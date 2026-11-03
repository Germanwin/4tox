class_name ToxNet
extends Node

## Host-authoritative multiplayer over ENet.
##
## The host runs the only ToxSim. Guests send commands (build, hire, train,
## army orders) and receive absolute, gzip-compressed snapshots ten times a
## second. The lobby, readiness and the start button live here; the world is
## generated from the same seed on every machine and checked by a hash.

signal lobby_changed(state: Dictionary)
signal status_changed(text: String, error: bool)
signal game_started(payload: Dictionary, is_host: bool)
signal snapshot_applied(state: Dictionary)
signal command_result(result: Dictionary)
signal peer_left(display_name: String, owner: int)
signal host_left
signal net_error(text: String)

const DEFAULT_PORT := 7777
const MAX_PLAYERS := 4
const SNAPSHOT_HZ := 10.0
const CONNECT_TIMEOUT := 10.0

var is_host := false
var active := false
var started := false
var starting := false
var connected := false
var local_owner := 0
var local_name := "Игрок"
var host_name := "Хозяин"
var server_address := ""
var settings := {"seed": "тихая-долина-701", "size": 64, "port": DEFAULT_PORT,
	"max_players": MAX_PLAYERS}
var players: Dictionary = {}
var lobby: Dictionary = {}
var sim: ToxSim
var last_state: Dictionary = {}
var last_seq := 0
var last_snapshot_bytes := 0
var ping_ms := -1
var local_edit_nid := -1

var _connect_left := 0.0
var _join_address := ""
var _snapshot_t := 0.0
var _ping_t := 0.0
var _req := 0
var _got_first_snapshot := false

func _ready() -> void:
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)

func _process(dt: float) -> void:
	if not active:
		return
	if _connect_left > 0.0:
		_connect_left -= dt
		if _connect_left <= 0.0 and not connected:
			var where := _join_address
			_join_address = ""
			_emit_error("не удалось подключиться к %s" % where)
			_shutdown()
			return
	_ping_t -= dt
	if _ping_t <= 0.0:
		_ping_t = 0.5
		_update_ping()
	if is_host and started and sim != null:
		_snapshot_t -= dt
		if _snapshot_t <= 0.0:
			_snapshot_t = 1.0 / SNAPSHOT_HZ
			_send_snapshot(false)

# ---------------------------------------------------------------- lobby

func host_game(p_name: String, port: int, seed_text: String, size: int, max_players: int = MAX_PLAYERS) -> bool:
	_shutdown()
	if port < 1024 or port > 65535:
		_emit_error("порт должен быть от 1024 до 65535")
		return false
	max_players = clampi(max_players, 2, MAX_PLAYERS)
	var peer := ENetMultiplayerPeer.new()
	var err := peer.create_server(port, max_players - 1)
	if err != OK:
		_emit_error("не удалось открыть порт %d (уже занят?)" % port)
		return false
	multiplayer.multiplayer_peer = peer
	is_host = true
	active = true
	started = false
	connected = true
	local_owner = 0
	local_name = _clean_name(p_name)
	host_name = local_name
	settings = {
		"seed": seed_text if not seed_text.strip_edges().is_empty() else "тихая-долина-701",
		"size": clampi(size, 64, 256),
		"port": port,
		"max_players": max_players
	}
	players = {
		1: {"peer": 1, "name": local_name, "owner": 0,
			"color": ToxSim.TEAM_COLORS[0], "ready": true}
	}
	last_state = {}
	last_seq = 0
	_got_first_snapshot = false
	_broadcast_lobby()
	_emit_status("лобби создано · ждём игроков", false)
	return true

func join_game(p_name: String, address: String, port: int) -> bool:
	_shutdown()
	var host := address.strip_edges()
	host = host.replace("http://", "").replace("https://", "")
	if host.contains("/"):
		host = host.split("/")[0]
	var host_port := port
	if host.contains(":"):
		var bits := host.rsplit(":", true, 1)
		host = bits[0]
		host_port = int(bits[1])
	if host.is_empty():
		_emit_error("укажи адрес хозяина")
		return false
	if host_port < 1024 or host_port > 65535:
		_emit_error("порт должен быть от 1024 до 65535")
		return false
	var peer := ENetMultiplayerPeer.new()
	var err := peer.create_client(host, host_port)
	if err != OK:
		_emit_error("не удалось начать подключение к %s:%d" % [host, host_port])
		return false
	multiplayer.multiplayer_peer = peer
	is_host = false
	active = true
	started = false
	connected = false
	local_owner = -1
	local_name = _clean_name(p_name)
	settings.port = host_port
	_join_address = "%s:%d" % [host, host_port]
	server_address = _join_address
	_connect_left = CONNECT_TIMEOUT
	players = {}
	lobby = {}
	last_state = {}
	last_seq = 0
	_got_first_snapshot = false
	_emit_status("подключаемся к %s…" % _join_address, false)
	return true

func leave() -> void:
	if active and is_host and multiplayer.has_multiplayer_peer() and started:
		rpc("_rpc_host_leaving")
	_shutdown()

func _shutdown() -> void:
	# Mark the session dead before closing the peer: ENet may emit
	# server_disconnected synchronously, and that must not look like a failure.
	active = false
	started = false
	starting = false
	connected = false
	is_host = false
	var peer := multiplayer.multiplayer_peer
	if peer != null:
		peer.close()
	multiplayer.multiplayer_peer = OfflineMultiplayerPeer.new()
	local_owner = 0
	players.clear()
	lobby.clear()
	sim = null
	last_state.clear()
	last_seq = 0
	_connect_left = 0.0
	_join_address = ""
	server_address = ""
	_snapshot_t = 0.0
	_req = 0
	_got_first_snapshot = false
	local_edit_nid = -1
	ping_ms = -1

func set_ready(value: bool) -> void:
	if active and not is_host and connected:
		rpc_id(1, "_rpc_set_ready", value)

func can_start() -> bool:
	if not is_host or started:
		return false
	var guests := 0
	for p in players.values():
		if int(p.owner) == 0:
			continue
		guests += 1
		if not bool(p.ready):
			return false
	return guests >= 1

func start_block_reason() -> String:
	if not is_host:
		return "начать игру может только хозяин"
	if started:
		return "игра уже началась"
	var guests := 0
	for p in players.values():
		if int(p.owner) == 0:
			continue
		guests += 1
		if not bool(p.ready):
			return "ждём готовности: %s" % str(p.name)
	if guests == 0:
		return "позови хотя бы одного друга"
	return ""

func start_payload() -> Dictionary:
	var list := []
	for p in players_sorted():
		list.append({"peer": int(p.peer), "owner": int(p.owner), "name": str(p.name)})
	return {
		"seed": str(settings.seed), "size": int(settings.size),
		"players": list, "host": 1, "max_players": int(settings.max_players)
	}

func begin_host_game(p_sim: ToxSim) -> void:
	if not is_host:
		return
	sim = p_sim
	starting = false
	started = true
	active = true
	connected = true
	local_owner = 0
	last_state = {}
	last_seq = 0
	_got_first_snapshot = false
	var payload := start_payload()
	payload["world_hash"] = sim.world_hash()
	rpc("_rpc_start", payload)
	_send_snapshot(true)
	_snapshot_t = 1.0 / SNAPSHOT_HZ
	_emit_status("игра началась", false)

func attach_sim(p_sim: ToxSim, owner: int) -> void:
	sim = p_sim
	if owner >= 0:
		sim.set_player_owner(owner)
		local_owner = owner
	if not last_state.is_empty():
		var state := last_state
		last_state = {}
		last_seq = int(state.get("seq", 0))
		sim.apply_net_state(state, -1, true)
		_got_first_snapshot = true
		emit_signal("snapshot_applied", state)

func send_command(cmd: Dictionary) -> int:
	if not active or not connected or is_host or not started:
		return -1
	_req += 1
	var payload := cmd.duplicate(true)
	payload["req"] = _req
	rpc_id(1, "_rpc_command", payload)
	return _req

func players_sorted() -> Array:
	var out := []
	for p in players.values():
		out.append(p)
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return int(a.owner) < int(b.owner))
	return out

func local_player() -> Dictionary:
	for p in players.values():
		if int(p.owner) == local_owner:
			return p
	return {}

func hud_text() -> String:
	if not active:
		return ""
	if not connected and not is_host:
		return "Сеть · нет связи"
	var s := "Сеть · "
	s += "хозяин" if is_host else "гость"
	if started:
		s += " · %d игр." % maxi(1, players.size())
		if ping_ms >= 0:
			s += " · %d мс" % ping_ms
	else:
		s += " · лобби"
	return s

func _update_ping() -> void:
	var enet := multiplayer.multiplayer_peer as ENetMultiplayerPeer
	if enet == null:
		ping_ms = -1
		return
	var best := -1
	var ids := []
	if is_host:
		for id in multiplayer.get_peers():
			ids.append(int(id))
	else:
		ids.append(1)
	for id in ids:
		var peer := enet.get_peer(id)
		if peer != null:
			var rtt := int(peer.get_statistic(ENetPacketPeer.PEER_ROUND_TRIP_TIME))
			best = maxi(best, rtt)
	ping_ms = best

func _broadcast_lobby() -> void:
	lobby = {
		"host": 1, "host_name": host_name, "started": started,
		"seed": str(settings.seed), "size": int(settings.size),
		"port": int(settings.port), "max_players": int(settings.max_players),
		"players": players_sorted()
	}
	rpc("_rpc_lobby", lobby.duplicate(true))
	emit_signal("lobby_changed", lobby.duplicate(true))

func _clean_name(value: String) -> String:
	var s := value.strip_edges().replace("\n", " ").replace("\r", " ")
	if s.is_empty():
		s = "Игрок"
	if s.length() > 18:
		s = s.substr(0, 18)
	return s

func _emit_status(text: String, is_error: bool) -> void:
	emit_signal("status_changed", text, is_error)

func _emit_error(text: String) -> void:
	_emit_status(text, true)
	emit_signal("net_error", text)

# ---------------------------------------------------------------- signals

func _on_peer_connected(id: int) -> void:
	if not is_host:
		return
	if started or starting:
		_reject_late(id)
		return
	_emit_status("игрок подключается…", false)

func _reject_late(id: int) -> void:
	rpc_id(id, "_rpc_reject", "игра уже начинается")
	if not is_inside_tree():
		return
	await get_tree().create_timer(0.25).timeout
	if not is_inside_tree() or not multiplayer.has_multiplayer_peer():
		return
	var enet := multiplayer.multiplayer_peer as ENetMultiplayerPeer
	if enet != null and enet.get_peer(id) != null:
		enet.disconnect_peer(id)

func _on_peer_disconnected(id: int) -> void:
	if not is_host:
		return
	if not players.has(id):
		return
	var p: Dictionary = players[id]
	players.erase(id)
	var display := str(p.get("name", "Игрок"))
	var owner := int(p.get("owner", -1))
	if started:
		if sim != null:
			sim.abandon_town(owner)
			_send_snapshot(true)
		rpc("_rpc_peer_left", display, owner)
		emit_signal("peer_left", display, owner)
	else:
		_broadcast_lobby()
		_emit_status("%s вышел из лобби" % display, false)

func _on_connected_to_server() -> void:
	if is_host or not active:
		return
	connected = true
	_connect_left = 0.0
	rpc_id(1, "_rpc_hello", local_name)
	_emit_status("подключено · ждём лобби", false)

func _on_connection_failed() -> void:
	if is_host or not active:
		return
	_emit_error("не удалось подключиться к %s" % _join_address)
	_shutdown()

func _on_server_disconnected() -> void:
	if is_host or not active or not connected:
		return
	connected = false
	_emit_status("связь с хозяином потеряна", true)
	emit_signal("host_left")

# ---------------------------------------------------------------- rpc

@rpc("any_peer", "call_remote", "reliable")
func _rpc_hello(p_name: String) -> void:
	if not is_host or not active:
		return
	var sender := multiplayer.get_remote_sender_id()
	if players.has(sender):
		return
	if started or starting:
		rpc_id(sender, "_rpc_reject", "игра уже начинается")
		return
	if players.size() >= int(settings.max_players):
		rpc_id(sender, "_rpc_reject", "лобби заполнено")
		return
	var used := {}
	for p in players.values():
		used[int(p.owner)] = true
	var owner := -1
	for i in range(int(settings.max_players)):
		if not used.has(i):
			owner = i
			break
	if owner < 0:
		rpc_id(sender, "_rpc_reject", "лобби заполнено")
		return
	players[sender] = {
		"peer": sender, "name": _clean_name(p_name), "owner": owner,
		"color": ToxSim.TEAM_COLORS[owner % ToxSim.TEAM_COLORS.size()], "ready": false
	}
	_broadcast_lobby()
	_emit_status("%s в лобби" % str(players[sender].name), false)

@rpc("any_peer", "call_remote", "reliable")
func _rpc_set_ready(value: bool) -> void:
	if not is_host or not active or started:
		return
	var sender := multiplayer.get_remote_sender_id()
	if not players.has(sender):
		return
	players[sender].ready = value
	_broadcast_lobby()

@rpc("authority", "call_remote", "reliable")
func _rpc_lobby(state: Dictionary) -> void:
	if is_host or not active or started:
		return
	lobby = state
	for p in state.get("players", []):
		if int(p.get("peer", -1)) == multiplayer.get_unique_id():
			local_owner = int(p.get("owner", -1))
	players = {}
	for p in state.get("players", []):
		players[int(p.peer)] = p
	emit_signal("lobby_changed", state)

@rpc("authority", "call_remote", "reliable")
func _rpc_reject(reason: String) -> void:
	if not active:
		return
	_emit_error(reason)
	_shutdown()

@rpc("authority", "call_remote", "reliable")
func _rpc_start(payload: Dictionary) -> void:
	if is_host or not active or not connected:
		return
	started = true
	active = true
	connected = true
	local_owner = -1
	for p in payload.get("players", []):
		if int(p.get("peer", -1)) == multiplayer.get_unique_id():
			local_owner = int(p.get("owner", -1))
	if local_owner < 0:
		_emit_error("хозяин не включил тебя в состав матча")
		_shutdown()
		return
	_emit_status("мир создаётся…", false)
	emit_signal("game_started", payload, false)

@rpc("any_peer", "call_remote", "reliable")
func _rpc_command(cmd: Dictionary) -> void:
	if not is_host or not started or sim == null:
		return
	var sender := multiplayer.get_remote_sender_id()
	if not players.has(sender):
		return
	var owner := int(players[sender].owner)
	var result := sim.net_command(owner, cmd)
	var ack := {
		"req": int(cmd.get("req", 0)),
		"ok": bool(result.get("ok", false)),
		"reason": str(result.get("reason", "")),
		"count": int(result.get("count", 0))
	}
	if str(cmd.get("kind", "")) == "ping":
		ack.ok = true
	rpc_id(sender, "_rpc_command_result", ack)
	if bool(result.get("ok", false)):
		_send_snapshot(true)

@rpc("authority", "call_remote", "reliable")
func _rpc_command_result(result: Dictionary) -> void:
	if not active or is_host:
		return
	emit_signal("command_result", result)

@rpc("authority", "call_remote", "unreliable_ordered", 1)
func _rpc_snapshot(bytes: PackedByteArray) -> void:
	if is_host or not active or not connected:
		return
	var state := decode_state(bytes)
	if state.is_empty():
		return
	var seq := int(state.get("seq", 0))
	if seq <= last_seq:
		return
	if sim == null:
		last_seq = seq
		last_state = state
		return
	last_seq = seq
	var silent := not _got_first_snapshot
	sim.apply_net_state(state, local_edit_nid, silent)
	_got_first_snapshot = true
	last_snapshot_bytes = bytes.size()
	emit_signal("snapshot_applied", state)

@rpc("authority", "call_remote", "reliable")
func _rpc_peer_left(display_name: String, owner: int) -> void:
	if not active or is_host:
		return
	for id in players.keys():
		if int(players[id].get("owner", -1)) == owner:
			players.erase(id)
			break
	emit_signal("peer_left", display_name, owner)

@rpc("authority", "call_remote", "reliable")
func _rpc_host_leaving() -> void:
	if not active or is_host or not connected:
		return
	connected = false
	_emit_status("хозяин закрыл игру", true)
	emit_signal("host_left")

# ---------------------------------------------------------------- snapshot

func _send_snapshot(force: bool) -> void:
	if sim == null or not is_host:
		return
	if not multiplayer.has_multiplayer_peer():
		return
	var state := sim.net_state()
	last_seq += 1
	state["seq"] = last_seq
	var bytes := encode_state(state)
	last_state = state
	last_snapshot_bytes = bytes.size()
	rpc("_rpc_snapshot", bytes)
	if force:
		_snapshot_t = 1.0 / SNAPSHOT_HZ

static func encode_state(state: Dictionary) -> PackedByteArray:
	var raw := var_to_bytes(state)
	return raw.compress(FileAccess.COMPRESSION_GZIP)

static func decode_state(bytes: PackedByteArray) -> Dictionary:
	if bytes.is_empty():
		return {}
	var raw := bytes.decompress_dynamic(8 * 1024 * 1024, FileAccess.COMPRESSION_GZIP)
	if raw.is_empty():
		return {}
	var value = bytes_to_var(raw)
	if value is Dictionary:
		return value
	return {}
