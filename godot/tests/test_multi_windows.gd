extends SceneTree

## Два окна = два независимых локальных сервера. У каждого свой порт, свой
## каталог состояния и свой лог; комнаты одного окна не видны другому.

const Supervisor = preload("res://scripts/server_supervisor.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== два окна — два локальных сервера")
	var one = Supervisor.new()
	one.name = "ServerOne"
	one.profile = 1
	root.add_child(one)
	var two = Supervisor.new()
	two.name = "ServerTwo"
	two.profile = 2
	root.add_child(two)
	await process_frame

	var up1: bool = await one.start_server()
	check(up1, "сервер окна 1 поднялся: " + one.base)
	var up2: bool = await two.start_server()
	check(up2, "сервер окна 2 поднялся: " + two.base)
	if not (up1 and up2):
		_finish(one, two)
		return

	check(one.base != two.base, "разные адреса: %s / %s" % [one.base, two.base])
	check(one.state_dir != two.state_dir,
		"разные каталоги состояния: %s / %s" % [one.state_dir, two.state_dir])
	check(one.state_dir.ends_with("/state/rooms"), "окно 1 — прежний state/rooms")
	check(two.state_dir.ends_with("/state/client-2/rooms"),
		"окно 2 — свой state/client-2/rooms")
	check(one.log_path != two.log_path,
		"разные логи: %s / %s" % [one.log_path, two.log_path])
	check(one.log_path.ends_with("/logs/server.log"), "окно 1 — server.log")
	check(two.log_path.ends_with("/logs/server-2.log"), "окно 2 — server-2.log")
	check(one.is_running() and two.is_running(), "оба процесса живы")

	var h1: Dictionary = await one.http_json("GET", "/api/health", null)
	var h2: Dictionary = await two.http_json("GET", "/api/health", null)
	check(bool(h1.get("ok", false)), "/api/health окна 1")
	check(bool(h2.get("ok", false)), "/api/health окна 2")

	# Комнаты независимы: у каждого сервера свой слот MAX_ACTIVE_ROOMS.
	var l1: Dictionary = await one.http_json("POST", "/api/lobby",
		{"name": "Один", "max": 2, "seed": "тихая-долина-701", "size": 64})
	var l2: Dictionary = await two.http_json("POST", "/api/lobby",
		{"name": "Два", "max": 2, "seed": "тихая-долина-701", "size": 64})
	check(bool(l1.get("ok", false)), "лобби окна 1 создано")
	check(bool(l2.get("ok", false)), "лобби окна 2 создано")
	check(str(l1.get("code", "")) != str(l2.get("code", "")),
		"коды лобби разные: %s / %s" % [l1.get("code", ""), l2.get("code", "")])

	_finish(one, two)


func _finish(one, two) -> void:
	if one != null:
		one.stop()
	if two != null:
		two.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL MULTI WINDOW TESTS PASSED")
		quit(0)
	else:
		print("MULTI WINDOW TESTS FAILED")
		quit(1)
