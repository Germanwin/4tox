extends SceneTree

## Full-shell host half of the multiplayer acceptance: the real main scene
## hosts, waits for a ready guest, starts, and checks the guest's commands
## reached the authoritative simulation through the HUD path.

var main: Node
var start_called := false
var checked := false
var client_seen := false

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
	# ENet-лобби больше не главный путь («Сеть» — HTTP). Легаси-петля
	# проверяет старый экран напрямую.
	main._open_lobby(64, "тихая-долина-701")
	await process_frame
	main._on_lobby_host({"name": "Хост", "port": port, "seed": "тихая-долина-701", "size": 64})
	print("MAIN HOST READY ", port)
	var deadline := Time.get_ticks_msec() + 35000
	var started_ms := 0
	while Time.get_ticks_msec() < deadline:
		await process_frame
		if main.net == null:
			continue
		if main.net.players.size() >= 2:
			client_seen = true
		if not start_called and main.net.can_start():
			start_called = true
			main._on_lobby_start()
			started_ms = Time.get_ticks_msec()
		if start_called and main.sim != null:
			if not checked and (main.sim.over or Time.get_ticks_msec() > started_ms + 3500):
				checked = true
				var camp: Variant = null
				for b in main.sim.buildings:
					if int(b.get("owner", 0)) == 1 and ToxBuildings.type_of(b) == "lumbercamp":
						camp = b
						break
				var n: int = 0 if camp == null else main.sim.workers_of(camp).size()
				print("MAIN HOST WORKERS ", n, " state=", main.state, " net=", main.net_game)
				if n == 3 and main.net_game and main.hud.net_mode and main.hud.net_panel.visible:
					print("MAIN HOST OK")
					quit(0)
					return
				break
	print("MAIN HOST FAIL start=", start_called, " client=", client_seen, " state=", main.state if main != null else -1)
	quit(1)
