extends SceneTree

## Two-process acceptance: run tests/net_loop.sh. This half hosts a match,
## auto-starts when the guest is ready, drives the authoritative sim and checks
## that the guest's hire command really changed the world.

var net: ToxNet
var sim: ToxSim
var host_ok := false
var checked := false
var client_seen := false
var client_left := false
var started_ms := 0

func _init() -> void:
	_run()

func _port() -> int:
	var p := 7801
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--port="):
			p = int(a.substr(7))
	return p

func _run() -> void:
	await process_frame
	net = ToxNet.new()
	net.name = "Net"
	get_root().add_child(net)
	await process_frame
	net.lobby_changed.connect(_on_lobby)
	net.peer_left.connect(_on_peer_left)
	net.net_error.connect(func(text: String) -> void:
		print("HOST ERROR ", text)
		quit(1))
	var port := _port()
	if not net.host_game("Хост", port, "тихая-долина-701", 64, 4):
		quit(1)
		return
	print("HOST READY ", port)
	var deadline := Time.get_ticks_msec() + 30000
	var last := Time.get_ticks_msec()
	var accum := 0.0
	while Time.get_ticks_msec() < deadline:
		await process_frame
		var now := Time.get_ticks_msec()
		var dt := clampf(float(now - last) / 1000.0, 0.0, 0.1)
		last = now
		if sim != null:
			accum += dt
			var steps := 0
			while accum >= 0.05 and steps < 12:
				sim.update(0.05)
				accum -= 0.05
				steps += 1
			if not checked and (client_left or now > started_ms + 4000):
				checked = true
				var camp: Variant = _camp(1)
				var n := 0 if camp == null else sim.workers_of(camp).size()
				print("HOST WORKERS ", n)
				host_ok = n == 3
		if client_left and checked:
			break
	if host_ok:
		print("HOST OK")
		quit(0)
	else:
		print("HOST FAIL checked=", checked, " client_seen=", client_seen, " client_left=", client_left)
		quit(1)

func _camp(owner: int) -> Variant:
	if sim == null:
		return null
	for b in sim.buildings:
		if int(b.get("owner", 0)) == owner and ToxBuildings.type_of(b) == "lumbercamp":
			return b
	return null

func _on_lobby(_state: Dictionary) -> void:
	if net == null or net.started:
		return
	if net.players.size() >= 2:
		client_seen = true
	if net.can_start():
		_start()

func _start() -> void:
	var payload := net.start_payload()
	sim = ToxSim.new()
	sim.start_net(str(payload.seed), int(payload.size), payload.players)
	sim.player_owner = 0
	net.begin_host_game(sim)
	started_ms = Time.get_ticks_msec()
	print("HOST STARTED players=", payload.players.size())

func _on_peer_left(name: String, owner: int) -> void:
	print("HOST PEER LEFT ", name, " ", owner)
	client_left = true
