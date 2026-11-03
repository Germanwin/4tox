extends SceneTree

## Full-shell guest half: joins the real main scene, readies, hires through
## Main._on_hire_all and waits for the authority to show three workers.

var main: Node
var ready_sent := false
var sent := false

func _init() -> void:
	_run()

func _port() -> int:
	var p := 7812
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--port="):
			p = int(a.substr(7))
	return p

func _run() -> void:
	await process_frame
	main = load("res://scenes/main.tscn").instantiate()
	get_root().add_child(main)
	await create_timer(1.8).timeout
	var port := _port()
	main._on_play(64, "тихая-долина-701", "net")
	await process_frame
	main._on_lobby_join({"name": "Гость", "address": "127.0.0.1", "port": port})
	print("MAIN CLIENT JOINING ", port)
	var deadline := Time.get_ticks_msec() + 35000
	while Time.get_ticks_msec() < deadline:
		await process_frame
		if main.net == null:
			continue
		if not ready_sent and main.net.players.size() >= 2:
			ready_sent = true
			main.net.set_ready(true)
			print("MAIN CLIENT READY")
		if main.net_game and main.sim != null and main.state == main.State.PLAY:
			var camp: Variant = null
			for b in main.sim.buildings:
				if int(b.get("owner", 0)) == main.sim.player_owner and ToxBuildings.type_of(b) == "lumbercamp":
					camp = b
					break
			if camp == null:
				continue
			if not sent:
				sent = true
				main._on_hire_all(camp)
				print("MAIN CLIENT HIRE owner=", main.sim.player_owner)
				continue
			var n: int = main.sim.workers_of(camp).size()
			if n == 3:
				print("MAIN CLIENT WORKERS ", n, " bytes=", main.net.last_snapshot_bytes,
					" hud=", main.hud.net_mode, " net_game=", main.net_game)
				if main.hud.net_mode and main.hud.net_panel.visible and main.net.last_snapshot_bytes > 0:
					print("MAIN CLIENT OK")
					quit(0)
					return
				break
	print("MAIN CLIENT FAIL ready=", ready_sent, " sent=", sent, " net_game=", main.net_game if main != null else false,
		" state=", main.state if main != null else -1)
	quit(1)
