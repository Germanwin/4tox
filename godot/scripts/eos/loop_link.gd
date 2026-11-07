class_name ToxEosLoopLink
extends ToxEosLink

## Локальный транспорт для проверок. Каждый гость получает свой peer id;
## пакеты и буферы независимы. Это не имитация NAT или задержки интернета.
const DEFAULT_PORT := 7791
const MAX_FRAME := 8 * 1024 * 1024
const MAX_PEERS := 3
var listen_port := DEFAULT_PORT
var _server: TCPServer = null
var _role := ""
var _port := 0
var _next_peer := 2
var _sockets: Dictionary = {}
var _buffers: Dictionary = {}
var _connected: Dictionary = {}

func available() -> bool:
	return true

func start_host() -> bool:
	stop()
	_server = TCPServer.new()
	var err := _server.listen(listen_port, "127.0.0.1")
	if err != OK:
		last_error = "петля: не слушается порт %d (%s)" % [listen_port, error_string(err)]
		failed.emit(last_error)
		_server = null
		return false
	_role = "host"
	_port = _server.get_local_port()
	_next_peer = 2
	return true

func start_client(room: String) -> bool:
	stop()
	var p := _as_port(room)
	if p <= 0:
		last_error = "петля: код комнаты — номер порта, например %d" % DEFAULT_PORT
		failed.emit(last_error)
		return false
	var sock := StreamPeerTCP.new()
	var err := sock.connect_to_host("127.0.0.1", p)
	if err != OK:
		last_error = "петля: не подключается к локальному серверу (%s)" % error_string(err)
		failed.emit(last_error)
		return false
	_role = "client"
	_port = p
	_add_socket(1, sock)
	return true

func room_id() -> String:
	return str(_port) if _port > 0 else ""

func peers() -> Array:
	return _connected.keys()

func host_peer() -> int:
	return 1

func send(to: int, data: PackedByteArray) -> bool:
	if not _connected.has(to) or not _sockets.has(to) or data.size() > MAX_FRAME:
		return false
	var frame := PackedByteArray()
	frame.resize(4)
	frame.encode_u32(0, data.size())
	frame.append_array(data)
	return (_sockets[to] as StreamPeerTCP).put_data(frame) == OK

func disconnect_peer(peer: int) -> bool:
	if not _sockets.has(peer):
		return false
	_remove_socket(peer)
	return true

func poll() -> void:
	if _role == "host" and _server != null:
		while _server.is_connection_available():
			var sock := _server.take_connection()
			if sock == null:
				break
			if _sockets.size() >= MAX_PEERS:
				sock.disconnect_from_host()
				continue
			_add_socket(_next_peer, sock)
			_next_peer += 1
	for id in _sockets.keys():
		var sock: StreamPeerTCP = _sockets[id]
		sock.poll()
		var st := sock.get_status()
		if st == StreamPeerTCP.STATUS_CONNECTED:
			if not _connected.has(id):
				_connected[id] = true
				peer_up.emit(id)
			var n := sock.get_available_bytes()
			if n > 0:
				var got: Array = sock.get_partial_data(n)
				if int(got[0]) == OK:
					var buf: PackedByteArray = _buffers[id]
					buf.append_array(got[1])
					_buffers[id] = buf
					_drain(id)
		elif st == StreamPeerTCP.STATUS_ERROR or st == StreamPeerTCP.STATUS_NONE:
			_remove_socket(id)

func _add_socket(id: int, sock: StreamPeerTCP) -> void:
	if sock.has_method("set_no_delay"):
		sock.set_no_delay(true)
	_sockets[id] = sock
	_buffers[id] = PackedByteArray()

func _remove_socket(id: int) -> void:
	if not _sockets.has(id):
		return
	(_sockets[id] as StreamPeerTCP).disconnect_from_host()
	_sockets.erase(id)
	_buffers.erase(id)
	if _connected.erase(id):
		peer_down.emit(id)

func stop() -> void:
	for id in _sockets.keys():
		_remove_socket(id)
	if _server != null:
		_server.stop()
		_server = null
	_role = ""
	_port = 0

func describe() -> String:
	return "петля 127.0.0.1:%d" % _port

func _drain(id: int) -> void:
	var buf: PackedByteArray = _buffers[id]
	while buf.size() >= 4:
		var n := int(buf.decode_u32(0))
		if n > MAX_FRAME:
			_remove_socket(id)
			return
		if buf.size() < 4 + n:
			break
		var payload := buf.slice(4, 4 + n)
		buf = buf.slice(4 + n)
		packet.emit(id, payload)
		if not _sockets.has(id):
			return
	_buffers[id] = buf

func _as_port(room: String) -> int:
	var text := room.strip_edges()
	var colon := text.rfind(":")
	if colon >= 0:
		text = text.substr(colon + 1)
	if not text.is_valid_int():
		return 0
	return int(text)
