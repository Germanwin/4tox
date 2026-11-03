extends SceneTree

## Встроенный Node-сервер (ServerSupervisor): приложение поднимает сервер само,
## без терминала, ждёт `/api/health`, играет одиночную партию и гасит процесс.
##
## Проверяется ровно то, без чего §6.1 «запуск» не выполняется: найден node,
## найден `game/server/server.js`, выбран свободный порт, сервер ответил,
## комната стартует с `bot:true`, `WLD1` декодируется, `/api/check` отвечает,
## `/api/leave` закрывает комнату, stop гасит процесс, лог существует.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const WorldData = preload("res://scripts/world_data.gd")
const WorldWire = preload("res://scripts/world_wire.gd")

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
	print("== server supervisor")
	var sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	var project: String = sup.find_project_dir()
	check(project != "", "найден game/server/server.js")
	check(sup.find_node(project) != "", "найден node: " + sup.find_node(project))

	var ok: bool = await sup.start_server()
	check(ok, "сервер поднялся: " + sup.base)
	if not ok:
		print("  FAIL причина: " + sup.last_error)
		_finish()
		return
	check(sup.port >= Supervisor.PORT_FIRST and sup.port <= Supervisor.PORT_LAST,
		"порт выбран из диапазона: %d" % sup.port)
	check(sup.is_running(), "процесс сервера жив")

	var health: Dictionary = await sup.http_json("GET", "/api/health", null)
	check(bool(health.get("ok", false)), "/api/health ok")
	check(int(health.get("wsProtocol", 0)) == 2, "wsProtocol 2")

	var lobby: Dictionary = await sup.http_json("POST", "/api/lobby", {
		"name": "Godot", "max": 2, "seed": "тихая-долина-701", "size": 64, "bot": true})
	check(bool(lobby.get("ok", false)), "лобби создано")
	var code := str(lobby.get("code", ""))
	var token := str(lobby.get("token", ""))
	var ready: Dictionary = await sup.http_json("POST", "/api/ready",
		{"code": code, "token": token, "ready": true})
	check(bool(ready.get("ok", false)), "готов без второго игрока")
	var started: Dictionary = await sup.http_json("POST", "/api/start",
		{"code": code, "token": token, "bot": true})
	check(bool(started.get("ok", false)), "старт solo+bot")
	var start: Dictionary = started.get("start", {}) if started.get("start") is Dictionary else {}
	check(str(start.get("mode", "")) == "bot", "старт несёт mode=bot")

	var wbytes: PackedByteArray = await _raw(sup, "/api/world?code=%s&token=%s" % [code, token])
	check(wbytes.size() > 1000, "WLD1 получен: %d байт" % wbytes.size())
	var world = WorldData.new()
	var wr: Dictionary = WorldWire.unpack_into(world, wbytes)
	check(bool(wr.get("ok", false)), "WLD1 декодирован: " + str(wr.get("error", "")))
	# Сетка мира больше заказанного острова: генератор добавляет поле моря.
	check(world.island_size == 64 and world.width >= world.island_size,
		"остров 64: сетка %dx%d" % [world.width, world.height])
	check(world.objects.size() > 100, "объектов природы %d" % world.objects.size())

	var bad: Dictionary = await sup.http_json("POST", "/api/check", {
		"code": code, "token": token,
		"query": {"kind": "build", "buildingType": "house", "variant": "a",
			"rot": 90, "x": 0, "y": 0}})
	check(not bool(bad.get("ok", true)), "/api/check отказал на угле: " + str(bad.get("reason", "")))
	check((bad.get("cells", []) as Array).size() == 6, "пятно 2x3 из шести клеток")

	await sup.http_json("POST", "/api/leave", {"code": code, "token": token})
	check(FileAccess.file_exists(sup.log_path), "лог сервера есть: " + sup.log_path)

	sup.stop()
	await create_timer(0.4).timeout
	check(not sup.is_running(), "stop погасил процесс")
	_finish()


func _raw(sup, path: String) -> PackedByteArray:
	var http := HTTPRequest.new()
	sup.add_child(http)
	http.timeout = 8.0
	var err := http.request(sup.base + path)
	if err != OK:
		http.queue_free()
		return PackedByteArray()
	var res: Array = await http.request_completed
	http.queue_free()
	return res[3]


func _finish() -> void:
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL SUPERVISOR TESTS PASSED")
		quit(0)
	else:
		print("SUPERVISOR TESTS FAILED")
		quit(1)
