class_name ToxEosTunnel
extends Node

## Туннель TCP поверх пир-транспорта.
##
## Зачем. Игра говорит с Node-сервером по HTTP и WebSocket, а EOS P2P умеет
## только дейтаграммы «пир — пир». Вместо того чтобы переписывать LiveRoom,
## хозяин поднимает сервер у себя, а гостю на 127.0.0.1 открывается порт:
## LiveRoom думает, что сервер рядом, а байты едут через транспорт.
##
## Раскладка одного пакета: [тип:1][поток:2 little-endian][данные].
## Поток — одно TCP-соединение (HTTP-запрос, WebSocket, SSE-fallback).
## `T_OPEN` шлёт только гость, `T_META` — только хозяин.
##
## Чего здесь нет и почему: подтверждений и повторов. Транспорт (EOS
## RELIABLE-режим и петля) доставляет пакеты по порядку сам; туннель режет
## данные на куски ≤900 Б, чтобы влезть в MTU EOS, и придерживает чтение из
## TCP, когда очередь распухла. Этого достаточно для прототипа и мало для
## честного TCP — ограничение записано в EOS.md.

signal meta(data: Dictionary)
signal failed(text: String)

enum { T_OPEN = 1, T_DATA = 2, T_CLOSE = 3, T_RESET = 4, T_META = 5, T_AUTH = 6, T_AUTH_OK = 7, T_CHALLENGE = 8 }

const CHUNK := 900
const READ_MAX := 16384
const OUT_MAX := 262144
const MAX_STREAMS_PER_PEER := 32
const MAX_STREAMS_TOTAL := 128
const MAX_PENDING_PEERS := 8
const AUTH_TIMEOUT_MS := 15000

var link: ToxEosLink = null
var role := ""
var target_port := 0
var local_port := 0

var _listener: TCPServer = null
var _streams := {}
var _next_stream := 1
var _peer_host := 0
var _meta := {}
var _stopped := false
var require_auth := false
var auth_token := ""
var _authorized_hashes := {}
var _authenticated := {}
var _auth_retry := 0.0
var _challenges := {}
var _challenge := ""


func set_authorized_hashes(hashes: Array) -> void:
	_authorized_hashes.clear()
	for h in hashes:
		_authorized_hashes[str(h)] = true
	for peer in _authenticated.keys():
		if not _authorized_hashes.has(_authenticated[peer]):
			_authenticated.erase(peer)
			if link != null:
				link.disconnect_peer(int(peer))
			_on_peer_down(int(peer))


func start_host(p_link: ToxEosLink, p_port: int) -> bool:
	if p_link == null:
		failed.emit("нет транспорта")
		return false
	link = p_link
	role = "host"
	target_port = p_port
	link.packet.connect(_on_packet)
	link.peer_up.connect(_on_peer_up)
	link.peer_down.connect(_on_peer_down)
	return true


## Возвращает порт на 127.0.0.1, к которому подключается LiveRoom гостя.
func start_guest(p_link: ToxEosLink) -> int:
	if p_link == null:
		failed.emit("нет транспорта")
		return 0
	link = p_link
	role = "guest"
	_peer_host = link.host_peer()
	link.packet.connect(_on_packet)
	link.peer_up.connect(_on_peer_up)
	link.peer_down.connect(_on_peer_down)
	_listener = TCPServer.new()
	var err := _listener.listen(0, "127.0.0.1")
	if err != OK:
		failed.emit("туннель: не слушается локальный порт (%s)" % error_string(err))
		_listener = null
		return 0
	local_port = _listener.get_local_port()
	return local_port


func local_url() -> String:
	return "http://127.0.0.1:%d" % local_port


func publish_meta(data: Dictionary) -> void:
	_meta = data
	_broadcast_meta()


func stop() -> void:
	_stopped = true
	for key in _streams.keys():
		var st = _streams[key]
		var tcp: StreamPeerTCP = st.get("tcp")
		if tcp != null:
			tcp.disconnect_from_host()
	_streams.clear()
	if _listener != null:
		_listener.stop()
		_listener = null


func _process(dt: float) -> void:
	if link == null or _stopped:
		return
	link.poll()
	if role == "host" and require_auth:
		for peer in _challenges.keys():
			if not _authenticated.has(peer) and Time.get_ticks_msec() - int(_challenges[peer].created) > AUTH_TIMEOUT_MS:
				link.disconnect_peer(int(peer))
				_on_peer_down(int(peer))
	if role == "guest":
		if require_auth and not _authenticated.has(_peer_host):
			_auth_retry -= dt
			if _auth_retry <= 0.0 and _peer_host in link.peers() and _challenge != "":
				_auth_retry = 0.5
				var key := auth_token.sha256_text().hex_decode()
				var proof := Crypto.new().hmac_digest(HashingContext.HASH_SHA256, key, _challenge.to_utf8_buffer()).hex_encode()
				_send(_peer_host, T_AUTH, 0, proof.to_utf8_buffer())
		_accept()
	for key in _streams.keys():
		_pump(key)


# ------------------------------------------------------------------ приём

func _on_packet(from: int, data: PackedByteArray) -> void:
	if data.size() < 3:
		return
	var type := int(data[0])
	var stream := int(data[1]) | (int(data[2]) << 8)
	var payload := data.slice(3)
	if type == T_DATA and payload.size() > CHUNK:
		_overload(from, stream)
		return
	if type == T_META and payload.size() > 4096:
		return
	if require_auth:
		if role == "guest" and from == _peer_host and type == T_CHALLENGE:
			if payload.size() == 32:
				_challenge = payload.get_string_from_utf8()
				_auth_retry = 0.0
			return
		if role == "host" and type == T_AUTH:
			if payload.size() == 64 and _challenges.has(from):
				var proof := payload.get_string_from_utf8()
				if proof.length() != 64:
					return
				for hash in _authorized_hashes:
					var expected := Crypto.new().hmac_digest(HashingContext.HASH_SHA256, str(hash).hex_decode(), str(_challenges[from].nonce).to_utf8_buffer()).hex_encode()
					var different := 0
					for i in range(64):
						different |= proof.unicode_at(i) ^ expected.unicode_at(i)
					if different == 0:
						_authenticated[from] = hash
						_send(from, T_AUTH_OK, 0, PackedByteArray())
						_send_meta(from)
						break
			return
		if role == "guest" and from == _peer_host and type == T_AUTH_OK:
			_authenticated[from] = true
			return
		if not _authenticated.has(from):
			return
	match type:
		T_META:
			if role == "guest":
				var text := payload.get_string_from_utf8()
				var parsed = JSON.parse_string(text)
				if parsed is Dictionary:
					_meta = parsed
					meta.emit(parsed)
		T_OPEN:
			if role == "host":
				_open_local(from, stream)
		T_DATA:
			_write(_key(from, stream), payload)
		T_CLOSE:
			_mark_closing(_key(from, stream))
		T_RESET:
			_drop(_key(from, stream))


func _on_peer_up(peer: int) -> void:
	if role == "guest":
		if _peer_host == 0:
			_peer_host = peer
		return
	if require_auth:
		if _challenges.size() >= MAX_PENDING_PEERS:
			link.disconnect_peer(peer)
			return
		_challenges[peer] = {"nonce": Crypto.new().generate_random_bytes(16).hex_encode(), "created": Time.get_ticks_msec()}
		_send(peer, T_CHALLENGE, 0, str(_challenges[peer].nonce).to_utf8_buffer())
	if not require_auth and not _meta.is_empty():
		_send_meta(peer)


func _on_peer_down(peer: int) -> void:
	_authenticated.erase(peer)
	_challenges.erase(peer)
	for key in _streams.keys():
		if int(_streams[key].get("peer", -1)) == peer:
			_drop(key)


# ------------------------------------------------------------------ хозяин

func _open_local(peer: int, stream: int) -> void:
	if stream < 1 or stream > 60000 or _streams.size() >= MAX_STREAMS_TOTAL or _peer_stream_count(peer) >= MAX_STREAMS_PER_PEER:
		_send(peer, T_RESET, stream, PackedByteArray())
		return
	var key := _key(peer, stream)
	if _streams.has(key):
		return
	var tcp := StreamPeerTCP.new()
	var err := tcp.connect_to_host("127.0.0.1", target_port)
	if err != OK:
		_send(peer, T_RESET, stream, PackedByteArray())
		return
	_streams[key] = {
		"tcp": tcp, "out": PackedByteArray(), "peer": peer,
		"stream": stream, "closing": false
	}


# ------------------------------------------------------------------ гость

func _accept() -> void:
	if _listener == null:
		return
	if require_auth and not _authenticated.has(_peer_host):
		return
	var accepted := 0
	while _listener.is_connection_available() and accepted < 8:
		var tcp := _listener.take_connection()
		if tcp == null:
			return
		accepted += 1
		if _streams.size() >= MAX_STREAMS_PER_PEER:
			tcp.disconnect_from_host()
			continue
		if tcp.has_method("set_no_delay"):
			tcp.set_no_delay(true)
		while _streams.has(_next_stream):
			_next_stream = 1 if _next_stream >= 60000 else _next_stream + 1
		var stream := _next_stream
		_next_stream += 1
		if _next_stream > 60000:
			_next_stream = 1
		_streams[stream] = {
			"tcp": tcp, "out": PackedByteArray(), "peer": _peer_host,
			"stream": stream, "closing": false
		}
		_send(_peer_host, T_OPEN, stream, PackedByteArray())


# ------------------------------------------------------------------ общее

func _key(peer: int, stream: int) -> int:
	if role == "host":
		return peer * 65536 + stream
	return stream


func _peer_stream_count(peer: int) -> int:
	var count := 0
	for st in _streams.values():
		if int(st.get("peer", -1)) == peer:
			count += 1
	return count


func _pump(key: int) -> void:
	if not _streams.has(key):
		return
	var st: Dictionary = _streams[key]
	var tcp: StreamPeerTCP = st["tcp"]
	tcp.poll()
	var status := tcp.get_status()
	if status == StreamPeerTCP.STATUS_CONNECTED:
		_flush(key)
		if st["closing"]:
			if (st["out"] as PackedByteArray).is_empty():
				tcp.disconnect_from_host()
				_streams.erase(key)
			return
		if (st["out"] as PackedByteArray).size() < OUT_MAX:
			var n := tcp.get_available_bytes()
			if n > 0:
				var got: Array = tcp.get_partial_data(mini(n, READ_MAX))
				if int(got[0]) == OK:
					var chunk: PackedByteArray = got[1]
					if chunk.size() > 0:
						_send_data(int(st["peer"]), int(st["stream"]), chunk)
	elif status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
		if not st["closing"]:
			_send(int(st["peer"]), T_CLOSE, int(st["stream"]), PackedByteArray())
		_streams.erase(key)


func _write(key: int, data: PackedByteArray) -> void:
	if not _streams.has(key) or data.is_empty():
		return
	var st: Dictionary = _streams[key]
	if (st["out"] as PackedByteArray).size() + data.size() > OUT_MAX:
		_overload(int(st["peer"]), int(st["stream"]))
		return
	st["out"].append_array(data)
	_flush(key)


func _flush(key: int) -> void:
	if not _streams.has(key):
		return
	var st: Dictionary = _streams[key]
	var tcp: StreamPeerTCP = st["tcp"]
	var out: PackedByteArray = st["out"]
	while not out.is_empty():
		var res: Array = tcp.put_partial_data(out)
		if int(res[0]) != OK:
			return
		var sent := int(res[1])
		if sent <= 0:
			return
		out = out.slice(sent)
		st["out"] = out


func _mark_closing(key: int) -> void:
	if not _streams.has(key):
		return
	_streams[key]["closing"] = true


func _drop(key: int) -> void:
	if not _streams.has(key):
		return
	var st: Dictionary = _streams[key]
	var tcp: StreamPeerTCP = st["tcp"]
	if tcp.get_status() != StreamPeerTCP.STATUS_NONE:
		tcp.disconnect_from_host()
	_streams.erase(key)


func _send_data(peer: int, stream: int, data: PackedByteArray) -> void:
	var i := 0
	while i < data.size():
		var end := mini(i + CHUNK, data.size())
		if not _send(peer, T_DATA, stream, data.slice(i, end)):
			_overload(peer, stream)
			return
		i = end


func _overload(peer: int, stream: int) -> void:
	_send(peer, T_RESET, stream, PackedByteArray())
	_drop(_key(peer, stream))
	if role == "host" and link != null and link.disconnect_peer(peer):
		return
	failed.emit("Соединение перегружено; восстанавливаем связь.")


func _send(peer: int, type: int, stream: int, payload: PackedByteArray) -> bool:
	if link == null:
		return false
	var b := PackedByteArray()
	b.resize(3)
	b[0] = type
	b[1] = stream & 0xFF
	b[2] = (stream >> 8) & 0xFF
	b.append_array(payload)
	return link.send(peer, b)


func _send_meta(peer: int) -> void:
	if _meta.is_empty():
		return
	_send(peer, T_META, 0, JSON.stringify(_meta).to_utf8_buffer())


func _broadcast_meta() -> void:
	if link == null:
		return
	for p in link.peers():
		if not require_auth or _authenticated.has(p):
			_send_meta(int(p))
