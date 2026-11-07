extends SceneTree

## Полный EOS-путь в двух процессах: хозяин поднимает Node и туннель, гость
## приходит через EOS P2P (без петли), получает мир и кадры, шлёт команду.
##
##   godot --headless --path . -s res://tests/eos_pair_tunnel.gd -- --host
##   godot --headless --path . -s res://tests/eos_pair_tunnel.gd -- --guest=<код>

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var role := "host"
var room_code := ""
var world = null
var snap: Dictionary = {}
var meta: Dictionary = {}
var failure := ""

func _init() -> void:
	_run()

func _wait_for(pred: Callable, ms: int) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < ms:
		if pred.call():
			return true
		await create_timer(0.1).timeout
	return pred.call()

func _run() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--guest="):
			role = "guest"
			room_code = a.substr(8)
	print("== eos tunnel pair ", role)
	create_timer(240.0).timeout.connect(func() -> void:
		print("TIMEOUT")
		quit(3))
	await create_timer(0.6).timeout
	var openid_test := OS.get_environment("FOURTOX_TEST_OPENID") == "1"
	var script = load("res://tests/eos_openid_probe_link.gd" if openid_test else "res://scripts/eos/p2p_link.gd")
	var link = script.new()
	if openid_test:
		link.set_coordinator_url("https://374412.fornex.cloud/api/eos-coordinator")
	link.failed.connect(func(t: String) -> void: failure = t; print("FAILED ", t))
	if role == "host":
		await _host(link)
	else:
		await _guest(link)
	print("RESULT ", "OK" if failure == "" else failure)
	link.shutdown()
	quit(0 if failure == "" else 4)

func _host(link) -> void:
	var sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	if not await sup.start_server():
		failure = "сервер: " + str(sup.last_error)
		return
	if not await link.start_host():
		failure = "EOS: " + link.error_text()
		return
	print("ROOM ", link.room_id())
	var tun = load("res://scripts/eos/tunnel.gd").new()
	root.add_child(tun)
	tun.start_host(link, int(sup.port))
	var room = LiveRoom.new()
	room.persist_session = false
	root.add_child(room)
	room.snapshot.connect(func(s: Dictionary) -> void: snap = s)
	if not await room.create_lobby(sup.base, "Хозяин", "тихая-долина-701", 64, 2):
		failure = "лобби: " + str(room.last_error)
		return
	tun.publish_meta({"code": room.code, "seed": "тихая-долина-701", "size": 64})
	print("LOBBY ", room.code)
	await room.set_ready(true)
	var ready := await _wait_for(func() -> bool:
		var ps: Array = room.lobby_players
		if ps.size() < 2:
			return false
		for p in ps:
			if not bool(p.get("ready", false)):
				return false
		return true, 120000)
	if not ready:
		failure = "гость не собрался"
		return
	if not await room.start_now():
		failure = "старт не удался"
		return
	var got := await _wait_for(func() -> bool: return not snap.is_empty(), 60000)
	if not got:
		failure = "нет кадров у хозяина"
		return
	print("HOST_FRAMES ", int(room.frames))
	# ждём, пока гость повернёт ратушу
	var before := {}
	for b in snap.get("buildings", []):
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", -1)) != 0:
			before[str(b.get("id", ""))] = int(b.get("rot", 0))
	var turned := await _wait_for(func() -> bool:
		for b in snap.get("buildings", []):
			var id := str(b.get("id", ""))
			if before.has(id) and int(b.get("rot", 0)) != int(before[id]):
				return true
		return false, 60000)
	if not turned:
		failure = "поворот гостя не дошёл"
	await _wait_for(func() -> bool: return room.lobby_players.size() < 2, 30000)
	await room.leave()
	sup.stop()

func _guest(link) -> void:
	if not await link.start_client(room_code):
		failure = "EOS: " + link.error_text()
		return
	var tun = load("res://scripts/eos/tunnel.gd").new()
	root.add_child(tun)
	tun.meta.connect(func(d: Dictionary) -> void: meta = d)
	var port: int = tun.start_guest(link)
	if port <= 0:
		failure = "туннель не встал"
		return
	if not await _wait_for(func() -> bool: return not meta.is_empty(), 90000):
		failure = "нет мета от хозяина"
		return
	print("META ", meta.get("code", ""))
	var room = LiveRoom.new()
	room.persist_session = false
	root.add_child(room)
	room.world_ready.connect(func(w) -> void: world = w)
	room.snapshot.connect(func(s: Dictionary) -> void: snap = s)
	if not await room.join_lobby(tun.local_url(), str(meta.get("code", "")), "Гость"):
		failure = "вход: " + str(room.last_error)
		return
	await room.set_ready(true)
	var got := await _wait_for(func() -> bool: return world != null and not snap.is_empty(), 90000)
	if not got:
		failure = "нет мира/кадров у гостя"
		return
	print("GUEST_FRAMES ", int(room.frames))
	var hall: Dictionary = {}
	for b in snap.get("buildings", []):
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", -1)) == int(room.my_owner):
			hall = b
	if hall.is_empty():
		failure = "нет своей ратуши"
		return
	room.send_command("edit", {"action": "rotate", "id": str(hall.get("id", ""))})
	await create_timer(3.0).timeout
	room.leave()
