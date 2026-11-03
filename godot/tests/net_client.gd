extends SceneTree

## Joins the host from tests/net_host.gd, readies up, hires its own lumberjacks
## and verifies that the authoritative snapshot shows the result.

var net: ToxNet
var sim: ToxSim
var sent := false
var ok := false
var ready_sent := false

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
	net.game_started.connect(_on_start)
	net.snapshot_applied.connect(_on_snapshot)
	net.net_error.connect(func(text: String) -> void:
		print("CLIENT ERROR ", text)
		quit(1))
	net.host_left.connect(func() -> void:
		print("CLIENT HOST LEFT")
		quit(1))
	var port := _port()
	if not net.join_game("Гость", "127.0.0.1", port):
		quit(1)
		return
	print("CLIENT JOINING ", port)
	var deadline := Time.get_ticks_msec() + 30000
	while Time.get_ticks_msec() < deadline:
		await process_frame
		if ok:
			print("CLIENT OK")
			quit(0)
			return
	print("CLIENT FAIL sent=", sent, " started=", net.started, " bytes=", net.last_snapshot_bytes)
	quit(1)

func _on_lobby(state: Dictionary) -> void:
	var guests := 0
	for p in state.get("players", []):
		if int(p.get("owner", 0)) != 0:
			guests += 1
	if guests >= 1 and not ready_sent:
		ready_sent = true
		net.set_ready(true)
		print("CLIENT READY")

func _on_start(payload: Dictionary, _is_host: bool) -> void:
	if sim != null:
		return
	var p := ToxSim.new()
	p.start_net(str(payload.get("seed", "")), int(payload.get("size", 64)), payload.get("players", []))
	var expected := str(payload.get("world_hash", ""))
	if not expected.is_empty() and expected != p.world_hash():
		print("CLIENT ERROR island hash mismatch")
		quit(1)
		return
	sim = p
	net.attach_sim(sim, net.local_owner)
	print("CLIENT STARTED owner=", net.local_owner)

func _on_snapshot(_state: Dictionary) -> void:
	if sim == null:
		return
	var camp: Variant = null
	for b in sim.buildings:
		if int(b.get("owner", 0)) == sim.player_owner and ToxBuildings.type_of(b) == "lumbercamp":
			camp = b
			break
	if camp == null:
		return
	if not sent:
		sent = true
		net.send_command({"kind": "hire_all", "nid": sim._id_of(camp)})
		print("CLIENT COMMAND hire_all")
		return
	var n := sim.workers_of(camp).size()
	if n == 3:
		print("CLIENT WORKERS ", n, " snapshot_bytes=", net.last_snapshot_bytes)
		ok = true
