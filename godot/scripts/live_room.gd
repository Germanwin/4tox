class_name ToxLiveRoom
extends Node

## Live room client: creates a lobby over HTTP, starts the match, pulls the
## static world once (WLD1) and then streams 4TX1 snapshots over WebSocket.
## No game rules here — the server owns the world.

signal status(text)
signal world_ready(world)
signal snapshot(snap)
signal command_done(result)
signal players_changed(count, ready)
signal failed(text)
## Лобби-состояние для экрана сети: состав, «началось ли», причина блока.
signal lobby_update(players: Array, started: bool, block: Dictionary)
## Партия началась (мир и WS подняты или вот-вот): экран лобби уходит.
signal room_started

const Wire = preload("res://scripts/wire.gd")
const WorldWire = preload("res://scripts/world_wire.gd")
const WorldData = preload("res://scripts/world_data.gd")

var base := "http://127.0.0.1:8787"
var code := ""
var token := ""
var player_id := 0
var frames := 0
## Одиночная партия: один игрок, без гостя (solo:true на /api/start).
var solo := true
## «Против деревни»: вторая деревня под управлением движка (bot:true).
var bot := false
## Мир, выбранный в меню. Сервер один раз генерирует его из сида.
var seed_text := ""
var world_size := 64
## Мультиплеер-хост: ждём второго игрока (кроссплей Godot ↔ браузер).
var wait_guest := false
var instance := ""
var room_id := ""
var epoch := 0
var protocol := 0
var cmd_seq := 0
var cmd_instance_ok := false
var start_payload: Dictionary = {}
var last_command: Dictionary = {}
var my_owner := 0
## Хост лобби создал комнату (кнопка «Начать игру» его).
var is_host := false
## Имя в лобби.
var player_name := "Godot"
## Мир и последний кадр кэшируются: экран матча подключается к комнате уже
## после старта и должен увидеть мир, не ожидая второго WLD1/кадра.
var world = null
var latest_snapshot: Dictionary = {}
var lobby_players: Array = []
var _start_done := false

## Сессия последней партии: по ней приложение возвращается в ту же комнату
## после перезапуска (GET /api/resume). Файл лежит в user:// и переживает
## падение приложения; явный выход в меню его стирает.
const SESSION_PATH := "user://net-session.cfg"
## Один процесс — одна сессия. Второй клиент (тест, отладка) может выключить
## запись, чтобы не перетирать сессию основного.
var persist_session := true

var _ws: WebSocketPeer = null
var _started := false
var _lobby_timer := 0.0
var _polling := false


func begin(url: String) -> void:
	base = url.rstrip("/")
	_run()


func begin_solo(url: String, p_seed := "", p_size := 0, p_bot := false) -> void:
	solo = true
	wait_guest = false
	bot = p_bot
	if p_seed != "":
		seed_text = p_seed
	if p_size > 0:
		world_size = p_size
	begin(url)


## Лобби на двоих: Godot — хост, второй игрок заходит по коду из браузера.
func begin_host(url: String) -> void:
	solo = false
	wait_guest = true
	begin(url)


## Создать лобби, но НЕ начинать: состав, «Готов» и старт — кнопки экрана.
func create_lobby(url: String, name: String, p_seed := "", p_size := 0,
		max_players := 2) -> bool:
	base = url.rstrip("/")
	player_name = name
	solo = false
	wait_guest = false
	is_host = true
	if p_seed != "":
		seed_text = p_seed
	if p_size > 0:
		world_size = p_size
	var body := {"name": name, "max": maxi(2, max_players)}
	if seed_text != "":
		body["seed"] = seed_text
	if world_size > 0:
		body["size"] = world_size
	var lobby := await _json("POST", "/api/lobby", body)
	if not lobby.get("ok", false):
		failed.emit("лобби: " + str(lobby.get("reason", "нет ответа")))
		return false
	code = str(lobby.get("code", ""))
	token = str(lobby.get("token", ""))
	player_id = int(lobby.get("playerId", 0))
	is_host = int(lobby.get("hostId", player_id)) == player_id
	status.emit("лобби " + code + " создано")
	await lobby_status()
	return true


## Войти в чужое лобби по коду.
func join_lobby(url: String, p_code: String, name: String) -> bool:
	base = url.rstrip("/")
	player_name = name
	solo = false
	wait_guest = false
	is_host = false
	code = p_code.strip_edges().to_upper()
	var r := await _json("POST", "/api/join", {"code": code, "name": name})
	if not r.get("ok", false):
		failed.emit("вход: " + str(r.get("reason", "нет ответа")))
		return false
	token = str(r.get("token", ""))
	player_id = int(r.get("playerId", 0))
	is_host = int(r.get("hostId", -1)) == player_id
	status.emit("в лобби " + code)
	await lobby_status()
	return true


## Один опрос состава. Если партия началась — поднимает мир и WS один раз.
func lobby_status() -> Dictionary:
	if code == "":
		return {"ok": false}
	var st := await _json("GET", "/api/status?code=%s&token=%s" % [code, token], null)
	if not st.get("ok", false):
		failed.emit("статус: " + str(st.get("reason", "нет ответа")))
		return st
	lobby_players = _status_players(st)
	var ready := 0
	for p in lobby_players:
		if bool(p.get("ready", false)):
			ready += 1
	players_changed.emit(lobby_players.size(), ready)
	var block: Dictionary = st.get("block", {}) if st.get("block") is Dictionary else {}
	lobby_update.emit(lobby_players, bool(st.get("started", false)), block)
	if bool(st.get("started", false)) and not _start_done:
		var start: Dictionary = st.get("start", {}) if st.get("start") is Dictionary else {}
		if not start.is_empty():
			await _after_start(start)
	return st


func _poll_lobby() -> void:
	_polling = true
	await lobby_status()
	_polling = false


func is_started() -> bool:
	return _start_done


func players_count() -> int:
	return lobby_players.size()


func ready_count() -> int:
	var n := 0
	for p in lobby_players:
		if bool(p.get("ready", false)):
			n += 1
	return n


func set_ready(value: bool) -> void:
	if code == "":
		return
	var r := await _json("POST", "/api/ready",
		{"code": code, "token": token, "ready": value})
	if not r.get("ok", false):
		failed.emit("готов: " + str(r.get("reason", "нет ответа")))
		return
	await lobby_status()


## «Начать игру» — только хост. Сервер сам проверит, можно ли.
func start_now() -> bool:
	if code == "" or not is_host:
		return false
	var body := {"code": code, "token": token}
	var r := await _json("POST", "/api/start", body)
	if not r.get("ok", false):
		failed.emit("старт: " + str(r.get("reason", "нет ответа")))
		return false
	var start: Dictionary = r.get("start", {}) if r.get("start") is Dictionary else {}
	if not start.is_empty():
		await _after_start(start)
	return true


## Автоодиночка/автолобби для тестов и отладочного входа.
func _run() -> void:
	status.emit("создаём комнату…")
	var body := {"name": player_name, "max": 2}
	if seed_text != "":
		body["seed"] = seed_text
	if world_size > 0:
		body["size"] = world_size
	if bot:
		body["bot"] = true
	var lobby := await _json("POST", "/api/lobby", body)
	if not lobby.get("ok", false):
		failed.emit("лобби: " + str(lobby.get("reason", "нет ответа")))
		return
	code = str(lobby.get("code", ""))
	token = str(lobby.get("token", ""))
	player_id = int(lobby.get("playerId", 0))
	is_host = true

	if not solo:
		status.emit("ждём второго игрока… код " + code)
		var joined := false
		for i in range(150):
			var st := await _json("GET", "/api/status?code=%s&token=%s" % [code, token], null)
			var players: Array = _status_players(st)
			players_changed.emit(players.size(), players.size())
			if players.size() >= 2:
				joined = true
				break
			await get_tree().create_timer(0.2).timeout
		if not joined:
			failed.emit("второй игрок не зашёл по коду " + code)
			return

	status.emit("готовы…")
	var r := await _json("POST", "/api/ready", {"code": code, "token": token, "ready": true})
	if not r.get("ok", false):
		failed.emit("готов: " + str(r.get("reason", "нет ответа")))
		return
	if not solo:
		for i in range(150):
			var st := await _json("GET", "/api/status?code=%s&token=%s" % [code, token], null)
			var players: Array = _status_players(st)
			var ready := 0
			for p in players:
				if bool(p.get("ready", false)):
					ready += 1
			players_changed.emit(players.size(), ready)
			if players.size() >= 2 and ready >= players.size():
				break
			await get_tree().create_timer(0.2).timeout

	status.emit("стартуем…")
	var start_body := {"code": code, "token": token}
	if solo:
		start_body["solo"] = true
	if bot:
		start_body["bot"] = true
	var started := await _json("POST", "/api/start", start_body)
	if not started.get("ok", false):
		failed.emit("старт: " + str(started.get("reason", "нет ответа")))
		return
	var start: Dictionary = started.get("start", {}) if started.get("start") is Dictionary else {}
	await _after_start(start)


## Общий путь после старта: снимок старта → WLD1 → WebSocket. Повторный
## вызов безопасен: мир и WS поднимаются один раз.
func _after_start(start: Dictionary) -> void:
	if _start_done:
		return
	_start_done = true
	start_payload = start
	protocol = int(start_payload.get("protocol", 0))
	room_id = str(start_payload.get("roomId", code))
	epoch = int(start_payload.get("epoch", 0))
	instance = ""
	my_owner = 0
	for p in start_payload.get("players", []):
		if int(p.get("id", -1)) == player_id:
			instance = str(p.get("instance", ""))
			cmd_seq = int(p.get("nextClientSequence", 1)) - 1
			my_owner = int(p.get("owner", 0))
			is_host = is_host or int(p.get("id", -1)) == int(start_payload.get("hostId", -1))
			break
	room_started.emit()

	status.emit("мир…")
	var wbytes := await _raw("/api/world?code=%s&token=%s" % [code, token])
	print("live: мир ", wbytes.size(), " байт, режим ",
		"bot" if bot else ("solo" if solo else "multi"))
	if wbytes.is_empty():
		failed.emit("мир: пустой ответ")
		return
	world = WorldData.new()
	var wr: Dictionary = WorldWire.unpack_into(world, wbytes)
	if not wr.get("ok", false):
		failed.emit("мир: " + str(wr.get("error", "")))
		return
	world_ready.emit(world)

	var ws_base := base.replace("https://", "wss://").replace("http://", "ws://")
	_ws = WebSocketPeer.new()
	var err := _ws.connect_to_url("%s/api/ws?code=%s&token=%s" % [ws_base, code, token])
	if err != OK:
		failed.emit("ws: ошибка " + str(err))
		_ws = null
		return
	_started = true
	_save_session()
	status.emit("в комнате")


func _save_session() -> void:
	if not persist_session:
		return
	if code == "" or token == "":
		return
	var cfg := ConfigFile.new()
	cfg.set_value("net", "base", base)
	cfg.set_value("net", "code", code)
	cfg.set_value("net", "token", token)
	cfg.set_value("net", "player", player_id)
	cfg.set_value("net", "host", is_host)
	cfg.save(SESSION_PATH)


func _clear_session() -> void:
	if FileAccess.file_exists(SESSION_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SESSION_PATH))


static func session_exists() -> bool:
	return FileAccess.file_exists("user://net-session.cfg")


static func session_info() -> Dictionary:
	var cfg := ConfigFile.new()
	if cfg.load("user://net-session.cfg") != OK:
		return {}
	return {
		"base": str(cfg.get_value("net", "base", "")),
		"code": str(cfg.get_value("net", "code", "")),
		"token": str(cfg.get_value("net", "token", "")),
		"player": int(cfg.get_value("net", "player", 0)),
		"host": bool(cfg.get_value("net", "host", false)),
	}


static func clear_session() -> void:
	if FileAccess.file_exists("user://net-session.cfg"):
		DirAccess.remove_absolute(ProjectSettings.globalize_path("user://net-session.cfg"))


## Вернуться в сохранённую партию: тот же токен, тот же игрок, тот же мир.
## `/api/resume` отдаёт старт и последний снимок комнаты; WLD1 и WS клиент
## поднимает обычным путём. Возвращает false, если сессии уже нет (403/404).
func resume(url := "") -> bool:
	var info := ToxLiveRoom.session_info()
	if info.is_empty():
		return false
	base = url if url != "" else str(info["base"])
	base = base.rstrip("/")
	code = str(info["code"])
	token = str(info["token"])
	player_id = int(info["player"])
	is_host = bool(info["host"])
	solo = false
	var st := await _json("GET", "/api/resume?code=%s&token=%s" % [code, token], null)
	if not st.get("ok", false):
		_clear_session()
		return false
	is_host = bool(st.get("host", is_host))
	lobby_players = _status_players(st)
	if bool(st.get("started", false)):
		var start: Dictionary = st.get("start", {}) if st.get("start") is Dictionary else {}
		if start.is_empty():
			return false
		status.emit("возвращаемся в партию…")
		await _after_start(start)
		return true
	# Партия ещё в лобби (никто не начал): остаёмся на экране сети.
	await lobby_status()
	return true


func _process(dt: float) -> void:
	# Пока идёт лобби, состав и старт подтягиваются сами: гость не должен
	# нажимать ничего, чтобы узнать, что хост начал.
	if code != "" and not _start_done and not solo:
		_lobby_timer -= dt
		if _lobby_timer <= 0.0 and not _polling:
			_lobby_timer = 0.8
			_poll_lobby()
	if _ws == null:
		return
	_ws.poll()
	var st := _ws.get_ready_state()
	if st == WebSocketPeer.STATE_OPEN:
		while _ws.get_available_packet_count() > 0:
			var pkt := _ws.get_packet()
			if pkt.size() < 6:
				continue
			if pkt.decode_u32(0) != Wire.MAGIC:
				continue
			var r: Dictionary = Wire.unpack(pkt)
			if r.get("ok", false):
				frames += 1
				latest_snapshot = r["snapshot"]
				snapshot.emit(latest_snapshot)
	elif st == WebSocketPeer.STATE_CLOSED and _started:
		_started = false
		_ws = null
		failed.emit("связь закрыта")


## Выход из комнаты: сервер закрывает партию сразу, если ушёл последний игрок
## (иначе комната живёт 30 с и занимает MAX_ACTIVE_ROOMS). Запрос отправляем
## без ожидания: клиент уже уходит.
func leave() -> void:
	_started = false
	_start_done = false
	_clear_session()
	if _ws != null:
		_ws.close()
		_ws = null
	if code == "" or token == "":
		return
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 4.0
	http.request_completed.connect(func(_r, _c, _h, _b) -> void: http.queue_free())
	var payload := JSON.stringify({"code": code, "token": token})
	var err := http.request(base + "/api/leave",
		PackedStringArray(["Content-Type: application/json"]),
		HTTPClient.METHOD_POST, payload)
	if err != OK:
		http.queue_free()
	code = ""
	token = ""


## /api/status отдаёт лобби внутри lobby: {ok, lobby:{players:[...]}}.
func _status_players(st) -> Array:
	if not (st is Dictionary):
		return []
	var lb: Variant = st.get("lobby", st)
	if not (lb is Dictionary):
		return []
	return (lb as Dictionary).get("players", [])


func _json(method: String, path: String, body) -> Dictionary:
	var res: Array = await _request(method, path, body)
	var text := (res[1] as PackedByteArray).get_string_from_utf8()
	if res[0] != 200:
		print("live: ", method, " ", path, " -> ", res[0], " ", text.substr(0, 160))
	var data: Variant = JSON.parse_string(text)
	if data == null or not (data is Dictionary):
		return {"ok": false, "reason": "HTTP %d" % int(res[0])}
	return data


func _raw(path: String) -> PackedByteArray:
	var res: Array = await _request("GET", path, null)
	return res[1]


func _request(method: String, path: String, body) -> Array:
	var http := HTTPRequest.new()
	http.timeout = 12.0
	add_child(http)
	var headers := PackedStringArray(["Content-Type: application/json"])
	var payload := "" if body == null else JSON.stringify(body)
	var m := HTTPClient.METHOD_POST if method == "POST" else HTTPClient.METHOD_GET
	var err := http.request(base + path, headers, m, payload)
	if err != OK:
		http.queue_free()
		return [0, PackedByteArray()]
	var res: Array = await http.request_completed
	http.queue_free()
	return [int(res[1]), res[3]]


## Подсказка для призрака: можно ли поставить/двинуть/повернуть. Это НЕ
## решение — команду всё равно проверит комната; ответ только красит ромб и
## называет причину словами.
func check_place(kind: String, payload: Dictionary) -> Dictionary:
	if code == "" or token == "":
		return {"ok": false, "reason": "нет комнаты"}
	var q := {"kind": kind}
	for k in payload:
		q[k] = payload[k]
	var r: Dictionary = await _json("POST", "/api/check",
		{"code": code, "token": token, "query": q})
	return r


## Команда — единственный проверенный путь: POST /api/command, затем
## /api/command-state по commandId. HTTP 200 значит только «принято в
## очередь»; applied/rejected читаются из состояния.
func send_command(type: String, payload: Dictionary) -> Dictionary:
	if instance.is_empty():
		return {"ok": false, "state": "rejected", "reason": "нет комнаты"}
	cmd_seq += 1
	var cid := "%s:%d" % [instance, cmd_seq]
	var env := {
		"protocol": protocol, "roomId": room_id, "epoch": epoch,
		"commandId": cid, "clientSequence": cmd_seq,
		"type": type, "payload": payload
	}
	var r := await _json("POST", "/api/command",
		{"code": code, "token": token, "command": env})
	if not r.get("ok", false):
		var bad := {"ok": false, "state": "rejected", "commandId": cid,
			"reason": str(r.get("reason", "сервер отказал"))}
		last_command = bad
		command_done.emit(bad)
		return bad
	for i in range(40):
		await get_tree().create_timer(0.2).timeout
		var st := await _json("GET", "/api/command-state?code=%s&token=%s&id=%s"
			% [code, token, cid], null)
		for res in st.get("results", []):
			if str(res.get("commandId", "")) != cid:
				continue
			var state := str(res.get("status", ""))
			if state in ["applied", "rejected", "expired", "history_expired"]:
				var out := {"ok": state == "applied", "state": state,
					"commandId": cid, "reason": str(res.get("reason", "")),
					"ids": res.get("ids", [])}
				last_command = out
				command_done.emit(out)
				return out
	var unk := {"ok": false, "state": "unknown", "commandId": cid,
		"reason": "результат уточняется"}
	last_command = unk
	command_done.emit(unk)
	return unk
