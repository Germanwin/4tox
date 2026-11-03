class_name ToxServerSupervisor
extends Node

## Встроенный Node-сервер: приложение само находит `node`, выбирает свободный
## порт, поднимает `game/server/server.js --local --no-upnp --port N`,
## дожидается `GET /api/health` и гасит процесс при выходе.
##
## Терминала, ручного `node` и выбора порта игрок не видит (требование
## заказчика, docs/GODOT-PORT-PROMPT.md §1.2). Правил игры здесь нет: сервер
## — единственный источник мира, супервизор только поднимает и держит процесс.

signal server_ready(base_url: String)
signal failed(text: String)
signal status(text: String)

## Нижняя граница порога: 8790..8899 — редкий диапазон для чужих служб.
const PORT_FIRST := 8790
const PORT_LAST := 8899
## Не больше трёх перезапусков: иначе падающий сервер превращается в вечный
## цикл и забивает лог.
const MAX_RESTARTS := 3

var pid := -1
var base := ""
var project_dir := ""
var server_js := ""
var node_path := ""
var port := 0
var log_path := ""
var state_dir := ""
var starting := false
var restarts := 0
var last_error := ""

var _started_at := 0
var _ready_check := false


func _ready() -> void:
	set_process(false)


## Каталог с `game/server/server.js`. Разработка — репозиторий рядом с
## `godot/`, сборка — `server/` рядом с исполняемым файлом.
func find_project_dir() -> String:
	var here := ProjectSettings.globalize_path("res://").simplify_path()
	var candidates: Array[String] = []
	candidates.append(here.path_join("..").simplify_path())
	var exe := OS.get_executable_path().get_base_dir()
	candidates.append(exe)
	candidates.append(exe.path_join("server"))
	# macOS .app: Contents/MacOS/4tox → Contents/Resources/server.
	candidates.append(exe.path_join("../Resources/server").simplify_path())
	candidates.append(exe.path_join("..").simplify_path())
	for dir in candidates:
		var js := dir.path_join("game/server/server.js")
		if FileAccess.file_exists(js):
			return dir
	return ""


func find_node(project: String) -> String:
	var exe := OS.get_executable_path().get_base_dir()
	# Сначала свой Node рядом с приложением: в собранной версии системного
	# может не быть вовсе.
	var bundled: Array[String] = [
		exe.path_join("node"),
		exe.path_join("node.exe"),
		exe.path_join("node/bin/node"),
		project.path_join("node"),
		project.path_join("node.exe"),
	]
	for p in bundled:
		if FileAccess.file_exists(p):
			return p
	# Потом PATH. Godot не разворачивает PATH сам, поэтому идём по каталогам.
	var sep := ";" if OS.get_name() == "Windows" else ":"
	var exe_name := "node.exe" if OS.get_name() == "Windows" else "node"
	for dir in OS.get_environment("PATH").split(sep, false):
		if dir.is_empty():
			continue
		var p := dir.path_join(exe_name)
		if FileAccess.file_exists(p):
			return p
	# Обычные места установки: GUI-приложение на macOS наследует урезанный
	# PATH и Homebrew в нём часто отсутствует.
	var extra: Array[String] = [
		"/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node",
		"/opt/local/bin/node",
	]
	if OS.get_name() == "Windows":
		extra.append(OS.get_environment("ProgramFiles").path_join("nodejs/node.exe"))
		extra.append(OS.get_environment("LOCALAPPDATA").path_join("Programs/nodejs/node.exe"))
		extra.append("C:/Program Files/nodejs/node.exe")
	for p in extra:
		if p != "" and FileAccess.file_exists(p):
			return p
	return ""


func is_running() -> bool:
	if pid <= 0:
		return false
	return OS.is_process_running(pid)


func log_dir() -> String:
	var dir := "user://logs"
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(dir))
	return ProjectSettings.globalize_path(dir)


func state_root() -> String:
	var dir := "user://state"
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(dir))
	return ProjectSettings.globalize_path(dir)


## Поднимает сервер и ждёт готовности. Возвращает true, если `/api/health`
## ответил. Повторный вызов при живом сервере ничего не делает.
func start_server(base_url := "") -> bool:
	if starting:
		return false
	if is_running() and base != "":
		server_ready.emit(base)
		return true
	starting = true
	last_error = ""
	project_dir = find_project_dir()
	if project_dir == "":
		return _fail("не найден game/server/server.js рядом с приложением")
	server_js = project_dir.path_join("game/server/server.js")
	node_path = find_node(project_dir)
	if node_path == "":
		return _fail("не найден node: положите его рядом с приложением или установите Node.js")
	log_path = log_dir().path_join("server.log")
	state_dir = state_root().path_join("rooms")
	port = _free_port()
	if port <= 0:
		return _fail("нет свободного порта для локального сервера")
	base = base_url if base_url != "" else "http://127.0.0.1:%d" % port
	status.emit("запускаем локальный сервер…")
	var args := PackedStringArray([
		server_js, "--local", "--no-upnp", "--port", str(port),
		"--state-dir", state_dir, "--log-file", log_path,
	])
	pid = OS.create_process(node_path, args)
	if pid <= 0:
		return _fail("не удалось запустить node (" + node_path + ")")
	_started_at = Time.get_ticks_msec()
	status.emit("ждём сервер…")
	var ok := await _wait_health(20.0)
	starting = false
	if ok:
		restarts = 0
		status.emit("сервер готов · " + base)
		server_ready.emit(base)
		set_process(true)
		return true
	return _fail(last_error if last_error != "" else "сервер не ответил на /api/health")


func _wait_health(timeout: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout * 1000.0):
		if pid > 0 and not OS.is_process_running(pid):
			last_error = "сервер завершился при запуске (лог: " + log_path + ")"
			return false
		var r := await http_json("GET", "/api/health", null, 1.5)
		if bool(r.get("ok", false)) and str(r.get("build", "")) != "":
			return true
		await get_tree().create_timer(0.25).timeout
	return false


func _free_port() -> int:
	for p in range(PORT_FIRST, PORT_LAST + 1):
		var tcp := TCPServer.new()
		var err := tcp.listen(p, "127.0.0.1")
		if err == OK:
			tcp.stop()
			return p
	return 0


func _fail(text: String) -> bool:
	starting = false
	last_error = text
	status.emit("сбой сервера: " + text)
	failed.emit(text)
	return false


## Следит за процессом: если он умер не по нашей команде — до трёх
## перезапусков, потом честный отказ. Порт остаётся в `base`, клиент продолжает
## переподключаться сам.
func _process(_dt: float) -> void:
	if starting or pid <= 0:
		return
	if OS.is_process_running(pid):
		return
	pid = -1
	if restarts >= MAX_RESTARTS:
		set_process(false)
		_fail("сервер падал %d раза; смотрите лог %s" % [MAX_RESTARTS, log_path])
		return
	restarts += 1
	status.emit("сервер упал, перезапуск %d/%d…" % [restarts, MAX_RESTARTS])
	starting = true
	var args := PackedStringArray([
		server_js, "--local", "--no-upnp", "--port", str(port),
		"--state-dir", state_dir, "--log-file", log_path,
	])
	pid = OS.create_process(node_path, args)
	var ok := await _wait_health(20.0)
	starting = false
	if ok:
		status.emit("сервер снова готов · " + base)
		server_ready.emit(base)
	else:
		_fail("не удалось перезапустить сервер")


func stop() -> void:
	set_process(false)
	if pid > 0:
		if OS.is_process_running(pid):
			OS.kill(pid)
		pid = -1
	starting = false
	base = ""


func _exit_tree() -> void:
	stop()


## Небольшой HTTP-клиент: один запрос, таймаут, JSON обратно.
func http_json(method: String, path: String, body, timeout_s := 8.0) -> Dictionary:
	var http := HTTPRequest.new()
	http.timeout = timeout_s
	add_child(http)
	var headers := PackedStringArray(["Content-Type: application/json"])
	var payload := "" if body == null else JSON.stringify(body)
	var m := HTTPClient.METHOD_POST if method == "POST" else HTTPClient.METHOD_GET
	var err := http.request(base + path, headers, m, payload)
	if err != OK:
		http.queue_free()
		return {"ok": false, "reason": "HTTPRequest: %d" % err}
	var res: Array = await http.request_completed
	http.queue_free()
	var code := int(res[1])
	var text := (res[3] as PackedByteArray).get_string_from_utf8()
	var data: Variant = JSON.parse_string(text) if text != "" else null
	if data is Dictionary:
		var d: Dictionary = data
		if code != 200 and d.get("reason", "") == "":
			d["reason"] = "HTTP %d" % code
		return d
	return {"ok": false, "reason": "HTTP %d" % code}
