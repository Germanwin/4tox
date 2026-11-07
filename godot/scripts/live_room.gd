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
## Состояние транспорта: online / reconnecting / lost.
signal connection(state: String, detail: String)
## Пинг до сервера, мс (стенные часы вокруг HTTP-круга).
signal latency(ms: int)
## Служебные события комнаты по WS (JSON): peer-left/peer-back/host-left/
## room-fault/room-recovered. Снимки — только бинарный 4TX1.
signal net_event(kind: String, data: Dictionary)

const Wire = preload("res://scripts/wire.gd")
const WorldWire = preload("res://scripts/world_wire.gd")
const WorldData = preload("res://scripts/world_data.gd")
const ClientProfile = preload("res://scripts/client_profile.gd")

var base := "http://127.0.0.1:8787"
## Запасной вход того же сервера. 443 на VPS делит листенер с naive-прокси и
## при включённом VPN теряет соединение; 8443 — отдельный сайт без прокси.
## Пусто — второго входа нет, не пробуем.
var fallback_base := ""
## Запрос ушёл на запасной вход, потому что основной не ответил.
var used_fallback := false
## Почему последняя попытка не удалась, словами для экрана сети. «Нет связи»,
## «прокси ответил 407» и «сервер отказал» — разные вещи: путать их значит
## отправлять игрока проверять адрес, который верный.
var last_error := ""
var code := ""
var token := ""
var player_id: Variant = 0
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
var migration_paused := false
var watch_stall := false
var _last_frame_at := 0
var _migration_serial := 0

## Сессия последней партии: по ней приложение возвращается в ту же комнату
## после перезапуска (GET /api/resume). Файл лежит в user:// и переживает
## падение приложения; явный выход в меню его стирает.
##
## У каждого окна своя сессия (`--client=N`): иначе второе окно перетирает
## место первого, и F5 возвращает не туда. Внутри одного окна второй LiveRoom
## (тест, отладка) по-прежнему может выключить запись.
var persist_session := true
## -1 — номер этого процесса; тесты и второй клиент в одном процессе задают
## номер явно.
var session_profile := -1

var _ws: WebSocketPeer = null
var _started := false
var _lobby_timer := 0.0
var _polling := false
## Переподключение WS: 300 → 600 → 1200 → 2400 мс, не больше пяти попыток.
const RETRY_MS := [0.3, 0.6, 1.2, 2.4, 2.4]
## Сеть до VPS: 443 через VPN теряет ПЕРВОЕ соединение и отвечает со второго
## раза. Повторяем только сбои ДО отправки — тогда повтор ничего не создаёт
## дважды (второго лобби, второй команды).
const NET_TRIES := 3
const NET_RETRY_PAUSE := 0.35
const NET_ERRORS := [
	HTTPRequest.RESULT_CANT_CONNECT,
	HTTPRequest.RESULT_CANT_RESOLVE,
	HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR,
]
var _want_ws := false
var _reconnect_timer := 0.0
var _reconnect_attempt := 0
var reconnects := 0
var transport := "none"          # none / ws / sse / poll
var is_spectator := false
var latency_ms := -1
var connected := false
var _ws_was_open := false
## Запасной канал после пяти неудач WS: опрос /api/resume (0,5 с), пока WS
## не вернётся. Это не SSE, а именно опрос — в бейдже честно «poll».
var _fallback := false
var _fallback_timer := 0.0
var _ws_retry_timer := 0.0
var _fallback_fails := 0
## Запасной SSE: HTTPClient читает text/event-stream с сервера.
var _sse: HTTPClient = null
var _sse_buf := ""
var _sse_state := ""
var _sse_fails := 0
var _sse_retry := 0.0


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
	used_fallback = false
	var lobby := await _entry("POST", "/api/lobby", body)
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
	used_fallback = false
	var r := await _entry("POST", "/api/join", {"code": code, "name": name})
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
	var serial := _migration_serial
	var st := await _json("GET", "/api/status?code=%s&token=%s" % [code, token], null)
	if serial != _migration_serial:
		return {"ok": false, "reason": "migration"}
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
func start_now(solo_start := false) -> bool:
	if code == "" or not is_host:
		return false
	var body := {"code": code, "token": token}
	if solo_start:
		body["solo"] = true
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
func _after_start(start: Dictionary, announce := true) -> void:
	if _start_done:
		return
	_start_done = true
	var serial := _migration_serial
	start_payload = start
	protocol = int(start_payload.get("protocol", 0))
	room_id = str(start_payload.get("roomId", code))
	epoch = int(start_payload.get("epoch", 0))
	instance = ""
	my_owner = -1 if is_spectator else 0
	for p in ([] if is_spectator else start_payload.get("players", [])):
		if int(p.get("id", -1)) == player_id:
			instance = str(p.get("instance", ""))
			cmd_seq = int(p.get("nextClientSequence", 1)) - 1
			my_owner = int(p.get("owner", 0))
			is_host = is_host or int(p.get("id", -1)) == int(start_payload.get("hostId", -1))
			break
	if announce:
		room_started.emit()

	status.emit("мир…")
	var wbytes := await _raw("/api/world?code=%s&token=%s" % [code, token])
	if serial != _migration_serial:
		return
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
	_last_frame_at = Time.get_ticks_msec()
	_want_ws = true
	if not is_spectator:
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
	cfg.save(ClientProfile.session_path(session_profile))


func _clear_session() -> void:
	var path := ClientProfile.session_path(session_profile)
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


static func session_exists(profile := -1) -> bool:
	return FileAccess.file_exists(ClientProfile.session_path(profile))


static func session_info(profile := -1) -> Dictionary:
	var cfg := ConfigFile.new()
	if cfg.load(ClientProfile.session_path(profile)) != OK:
		return {}
	return {
		"base": str(cfg.get_value("net", "base", "")),
		"code": str(cfg.get_value("net", "code", "")),
		"token": str(cfg.get_value("net", "token", "")),
		"player": int(cfg.get_value("net", "player", 0)),
		"host": bool(cfg.get_value("net", "host", false)),
	}


static func clear_session(profile := -1) -> void:
	var path := ClientProfile.session_path(profile)
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


## Вернуться в сохранённую партию: тот же токен, тот же игрок, тот же мир.
## `/api/resume` отдаёт старт и последний снимок комнаты; WLD1 и WS клиент
## поднимает обычным путём. Возвращает false, если сессии уже нет (403/404).
func resume(url := "") -> bool:
	var info := ToxLiveRoom.session_info(session_profile)
	if info.is_empty():
		return false
	base = url if url != "" else str(info["base"])
	base = base.rstrip("/")
	code = str(info["code"])
	token = str(info["token"])
	player_id = int(info["player"])
	is_host = bool(info["host"])
	solo = false
	var st := await _entry("GET", "/api/resume?code=%s&token=%s" % [code, token], null)
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


func _start_sse(reason: String) -> void:
	if _sse != null or code == "" or token == "":
		return
	_close_fallback()
	_sse_fails = 0
	_sse_buf = ""
	_sse_state = "connecting"
	_sse_retry = 0.0
	var parts := _origin_parts()
	_sse = HTTPClient.new()
	var err: int
	if bool(parts[2]):
		err = _sse.connect_to_host(str(parts[0]), int(parts[1]), TLSOptions.client())
	else:
		err = _sse.connect_to_host(str(parts[0]), int(parts[1]))
	if err != OK:
		_sse = null
		_start_fallback("SSE: не удалось подключиться")
		return
	transport = "sse"
	connected = true
	connection.emit("sse", reason)


func _origin_parts() -> Array:
	var s := base
	var tls := s.begins_with("https://")
	s = s.trim_prefix("https://").trim_prefix("http://")
	var slash := s.find("/")
	if slash >= 0:
		s = s.substr(0, slash)
	var host := s
	var port := 443 if tls else 80
	var colon := s.rfind(":")
	if colon > 0 and s.substr(colon + 1).is_valid_int():
		host = s.substr(0, colon)
		port = int(s.substr(colon + 1))
	return [host, port, tls]


func _sse_poll(dt: float) -> void:
	if _sse == null:
		return
	_sse.poll()
	var st := _sse.get_status()
	if st == HTTPClient.STATUS_DISCONNECTED or st == HTTPClient.STATUS_CANT_CONNECT:
		_sse_fail("соединение закрыто")
		return
	if st == HTTPClient.STATUS_CONNECTED and _sse_state == "connecting":
		var err := _sse.request(HTTPClient.METHOD_GET,
			"/api/events?code=%s&token=%s" % [code, token],
			PackedStringArray(["Accept-Encoding: identity", "Cache-Control: no-cache"]))
		if err != OK:
			_sse_fail("запрос не отправился")
			return
		_sse_state = "requesting"
		return
	if st == HTTPClient.STATUS_REQUESTING and _sse_state == "requesting":
		return
	if st == HTTPClient.STATUS_BODY:
		if _sse_state != "body":
			_sse_state = "body"
			_sse_fails = 0
			transport = "sse"
			connected = true
			connection.emit("sse", "поток открыт")
		while true:
			var chunk := _sse.read_response_body_chunk()
			if chunk.size() == 0:
				break
			_sse_buf += chunk.get_string_from_utf8()
		_parse_sse()
	elif st == HTTPClient.STATUS_CONNECTING and _sse_retry > 0.0:
		_sse_retry -= dt
		if _sse_retry <= 0.0:
			_close_sse()
			_start_sse("SSE: повтор")


func _parse_sse() -> void:
	while true:
		var idx := _sse_buf.find("\n\n")
		if idx < 0:
			return
		var block := _sse_buf.substr(0, idx)
		_sse_buf = _sse_buf.substr(idx + 2)
		var kind := "message"
		var data := ""
		for line in block.split("\n"):
			if line.begins_with("event: "):
				kind = line.substr(7).strip_edges()
			elif line.begins_with("data: "):
				data += line.substr(6)
		if data == "":
			continue
		var parsed: Variant = JSON.parse_string(data)
		if not (parsed is Dictionary):
			continue
		var d: Dictionary = parsed
		if kind == "snapshot":
			latest_snapshot = d
			frames += 1
			_last_frame_at = Time.get_ticks_msec()
			snapshot.emit(d)
		elif kind in ["peer-left", "peer-back", "host-left", "host-back", "room-fault", "room-recovered"]:
			net_event.emit(kind, d)


func _sse_fail(reason: String) -> void:
	_sse_fails += 1
	_close_sse()
	if _sse_fails >= 3:
		_sse_fails = 0
		_start_fallback("SSE не отвечает: " + reason)
		return
	_sse_retry = 1.5
	_start_sse("SSE: повтор после ошибки")


func _close_sse() -> void:
	if _sse != null:
		_sse.close()
		_sse = null
	_sse_buf = ""
	_sse_state = ""
	_sse_retry = 0.0


func _close_fallback() -> void:
	_fallback = false
	_fallback_timer = 0.0


func _start_fallback(reason: String) -> void:
	if _fallback or code == "":
		return
	_close_sse()
	_fallback = true
	_fallback_fails = 0
	_fallback_timer = 0.0
	_ws_retry_timer = 5.0
	_reconnect_attempt = 0
	connected = true
	transport = "poll"
	connection.emit("poll", reason)


## Запасной канал: раз в 0,5 с берём последний снимок через /api/resume.
## Команды по-прежнему уходят HTTP-путём, так что игра продолжается.
func _poll_fallback() -> void:
	if not _fallback or code == "" or token == "":
		return
	var r := await _json("GET", "/api/resume?code=%s&token=%s" % [code, token], null)
	if not _fallback:
		return
	if not r.get("ok", false):
		_fallback_fails += 1
		if _fallback_fails >= 3:
			_fallback = false
			_want_ws = false
			connected = false
			transport = "none"
			connection.emit("lost", "опрос не отвечает")
			if not watch_stall:
				failed.emit("связь потеряна: опрос не отвечает")
		return
	_fallback_fails = 0
	var snap: Variant = r.get("snapshot", {})
	if snap is Dictionary and not (snap as Dictionary).is_empty():
		latest_snapshot = snap
		frames += 1
		_last_frame_at = Time.get_ticks_msec()
		snapshot.emit(snap)


func _open_ws() -> void:
	if code == "" or token == "":
		return
	var ws_base := base.replace("https://", "wss://").replace("http://", "ws://")
	var ws := WebSocketPeer.new()
	var err := ws.connect_to_url("%s/api/ws?code=%s&token=%s" % [ws_base, code, token])
	if err != OK:
		_schedule_reconnect("ws: ошибка " + str(err))
		return
	_ws = ws


func _schedule_reconnect(reason: String) -> void:
	if not _want_ws or code == "" or _fallback:
		return
	_reconnect_attempt += 1
	if _reconnect_attempt > RETRY_MS.size():
		_start_sse("WS недоступен: " + reason)
		return
	_reconnect_timer = float(RETRY_MS[_reconnect_attempt - 1])
	connection.emit("reconnecting", "%s · попытка %d" % [reason, _reconnect_attempt])


## Пинг для бейджа: стенный RTT HTTP-круга. Серверный /api/ping без кода и
## токена тоже работает, но с ними он ещё и heartbeat.
func ping() -> int:
	if code == "" or token == "":
		return -1
	var t0 := Time.get_ticks_msec()
	var r := await _json("GET", "/api/ping?code=%s&token=%s&c0=%d" % [code, token, t0], null)
	if not r.get("ok", false):
		return -1
	latency_ms = Time.get_ticks_msec() - t0
	latency.emit(latency_ms)
	return latency_ms


func _process(dt: float) -> void:
	if migration_paused:
		return
	if watch_stall and _started and _last_frame_at > 0 and Time.get_ticks_msec() - _last_frame_at > 8000:
		_last_frame_at = 0
		connection.emit("stalled", "поток состояния остановился")
		if migration_paused:
			return
	# Переподключение WS: пока комната жива, клиент сам возвращается в неё
	# (300/600/1200/2400 мс). Сервер на новом WS присылает baseline.
	if _ws == null and _want_ws and code != "" and _start_done and not _fallback:
		_reconnect_timer -= dt
		if _reconnect_timer <= 0.0:
			_open_ws()
	if _sse != null:
		_sse_poll(dt)
	if _fallback and _start_done:
		_fallback_timer -= dt
		_ws_retry_timer -= dt
		if _fallback_timer <= 0.0:
			_fallback_timer = 0.5
			_poll_fallback()
		if _ws_retry_timer <= 0.0 and _ws == null:
			_ws_retry_timer = 5.0
			_open_ws()
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
		if not _ws_was_open:
			_ws_was_open = true
			_fallback = false
			_fallback_fails = 0
			_close_sse()
			connected = true
			transport = "ws"
			if _reconnect_attempt > 0:
				reconnects += 1
			_reconnect_attempt = 0
			connection.emit("online", "")
	
		while _ws.get_available_packet_count() > 0:
			var pkt := _ws.get_packet()
			if pkt.size() < 6:
				continue
			if pkt.decode_u32(0) != Wire.MAGIC:
				# Не кадр мира — служебное событие комнаты (JSON-текст).
				var ev: Variant = JSON.parse_string(pkt.get_string_from_utf8())
				if ev is Dictionary and (ev as Dictionary).has("t"):
					var kind := str((ev as Dictionary)["t"])
					# hello/start/lobby/snapshot — протокол входа, а не событие
					# комнаты; наружу отдаём только то, что меняет игру.
					if kind in ["peer-left", "peer-back", "host-left", "host-back",
							"room-fault", "room-recovered"]:
						var d: Variant = (ev as Dictionary).get("d", {})
						net_event.emit(kind, d if d is Dictionary else {})
				continue
			var r: Dictionary = Wire.unpack(pkt)
			if r.get("ok", false):
				frames += 1
				_last_frame_at = Time.get_ticks_msec()
				latest_snapshot = r["snapshot"]
				snapshot.emit(latest_snapshot)
	elif st == WebSocketPeer.STATE_CLOSED and _started:
		_ws = null
		_ws_was_open = false
		if not _fallback:
			connected = false
			transport = "none"
			_schedule_reconnect("связь закрыта")


## Выход из комнаты: сервер закрывает партию сразу, если ушёл последний игрок
## (иначе комната живёт 30 с и занимает MAX_ACTIVE_ROOMS). Запрос отправляем
## без ожидания: клиент уже уходит.
## Наблюдатель: тот же мир и WS, но без деревни и без команд. Сервер
## проверяет токен и отвечает 403 на /api/command.
func spectate(base_url: String, room_code: String, player_name: String) -> bool:
	base = base_url.rstrip("/")
	used_fallback = false
	var r := await _entry("POST", "/api/spectate",
		{"code": room_code, "name": player_name})
	if not r.get("ok", false):
		failed.emit(str(r.get("reason", "не удалось войти наблюдателем")))
		return false
	code = str(r.get("code", room_code))
	token = str(r.get("token", ""))
	player_id = str(r.get("playerId", ""))
	my_owner = -1
	is_spectator = true
	solo = false
	persist_session = false
	_started = false
	_start_done = false
	var res := await _json("GET", "/api/resume?code=%s&token=%s" % [code, token], null)
	if not res.get("ok", false):
		failed.emit("наблюдатель: нет доступа к комнате")
		return false
	var start: Variant = res.get("start", {})
	if not (start is Dictionary):
		failed.emit("наблюдатель: сервер не отдал старт")
		return false
	await _after_start(start)
	return _started


func leave() -> void:
	is_spectator = false
	_started = false
	_start_done = false
	_want_ws = false
	_fallback = false
	_close_sse()
	_reconnect_attempt = 0
	connected = false
	transport = "none"
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


## Первый запрос входа: если основной адрес не ответил по сети, а запасной
## задан — идём запасным и запоминаем его. Только для сбоев ДО отправки:
## после доставленного POST второй лобби не создаём.
func _entry(method: String, path: String, body) -> Dictionary:
	var r := await _json(method, path, body)
	# 407 — ответ прокси/VPN, а не игры: до мира такой запрос не дошёл, значит
	# и повтор запасным входом безопасен (второго лобби не будет).
	if (bool(r.get("net", false)) or bool(r.get("proxy", false))) and fallback_base != "":
		var dead := base
		base = fallback_base.rstrip("/")
		fallback_base = ""
		used_fallback = true
		print("live: основной вход ", dead, " не ответил, запасной ", base)
		status.emit("основной вход не ответил — идём через " + base)
		r = await _json(method, path, body)
	return r


func _json(method: String, path: String, body) -> Dictionary:
	# Прошлая причина к этому запросу не относится: экран не должен показывать
	# старый отказ, если нынешний удался.
	last_error = ""
	var res: Array = await _request(method, path, body)
	var result := int(res[0])
	var http := int(res[1])
	var text := (res[2] as PackedByteArray).get_string_from_utf8()
	# Разбор без ругани движка: 407/404 — это HTML, и «Parse JSON failed» в
	# журнале тут не ошибка, а ожидаемый ответ не игры.
	var data: Variant = null
	var json := JSON.new()
	if text.strip_edges() != "" and json.parse(text) == OK:
		data = json.data
	if data is Dictionary:
		# Сервер ответил по-своему, даже если код не 200: причина важнее кода
		# (`/api/join` на чужой код — 404 и слова «лобби не найдено»).
		if not bool((data as Dictionary).get("ok", true)):
			last_error = str((data as Dictionary).get("reason", "сервер отказал"))
		return data
	var why := _http_reason(result, http, text)
	last_error = why
	print("live: ", method, " ", path.get_slice("?", 0), " -> result ", result, " http ", http,
		" ", text.substr(0, 160))
	return {"ok": false, "reason": why, "net": result in NET_ERRORS,
		"proxy": http == 407, "http": http}


## Причина словами. «Нет связи» — это сеть (VPN, прокси, DNS), «HTTP N» —
## ответ не игры; смешивать их нельзя: игрок чинит то, что названо.
func _http_reason(result: int, http: int, text: String) -> String:
	if result == HTTPRequest.RESULT_REQUEST_FAILED and http == 0:
		return "адрес не принят: нужен http:// или https://"
	if result != HTTPRequest.RESULT_SUCCESS or http == 0:
		return "нет связи: " + _net_reason(result)
	if http == 407:
		return "HTTP 407 — это прокси или VPN, а не игровой сервер"
	if http == 404:
		return "HTTP 404 — на этом адресе нет игры (нужен origin без /game/)"
	if http == 502 or http == 503 or http == 504:
		return "HTTP %d — шлюз не достучался до сервера" % http
	var line := ""
	for part in text.strip_edges().split("\n"):
		if part.strip_edges() != "":
			line = part.strip_edges().substr(0, 80)
			break
	return "сервер ответил HTTP %d%s" % [http, (" — " + line) if line != "" else ""]


func _net_reason(result: int) -> String:
	match result:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "не удалось соединиться"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "имя не разрешилось в адрес"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "соединение оборвалось"
		HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
			return "TLS-рукопожатие не прошло"
		HTTPRequest.RESULT_NO_RESPONSE:
			return "сервер перестал отвечать"
		HTTPRequest.RESULT_TIMEOUT:
			return "истекло время ожидания"
	return "ошибка запроса %d" % result


func _raw(path: String) -> PackedByteArray:
	var res: Array = await _request("GET", path, null)
	return res[2]


## [код результата HTTPRequest, HTTP-код, тело]. Сетевой сбой до отправки
## повторяем: на VPN-пути 443 теряет первое соединение, а адрес верный.
func _request(method: String, path: String, body) -> Array:
	var res: Array = []
	for attempt in range(NET_TRIES):
		res = await _request_once(method, path, body)
		if not (int(res[0]) in NET_ERRORS) or attempt == NET_TRIES - 1:
			break
		await get_tree().create_timer(NET_RETRY_PAUSE).timeout
	return res


func _request_once(method: String, path: String, body) -> Array:
	var http := HTTPRequest.new()
	http.timeout = 12.0
	add_child(http)
	var headers := PackedStringArray(["Content-Type: application/json"])
	var payload := "" if body == null else JSON.stringify(body)
	var m := HTTPClient.METHOD_POST if method == "POST" else HTTPClient.METHOD_GET
	var err := http.request(base + path, headers, m, payload)
	if err != OK:
		http.queue_free()
		# Адрес не принят (нет схемы) — это не «нет связи», а ошибка адреса.
		return [HTTPRequest.RESULT_REQUEST_FAILED, 0, PackedByteArray()]
	var res: Array = await http.request_completed
	http.queue_free()
	return [int(res[0]), int(res[1]), res[3]]


## Подсказка для призрака: можно ли поставить/двинуть/повернуть. Это НЕ
## решение — команду всё равно проверит комната; ответ только красит ромб и
## называет причину словами.
func check_place(kind: String, payload: Dictionary) -> Dictionary:
	if is_spectator:
		return {"ok": false, "reason": "наблюдатель не командует"}
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
	if migration_paused:
		return {"ok": false, "state": "rejected", "reason": "восстанавливаем подключение"}
	if is_spectator:
		return {"ok": false, "state": "rejected", "reason": "наблюдатель не командует"}
	if instance.is_empty():
		return {"ok": false, "state": "rejected", "reason": "нет комнаты"}
	cmd_seq += 1
	var serial := _migration_serial
	var cid := "%s:%d" % [instance, cmd_seq]
	var env := {
		"protocol": protocol, "roomId": room_id, "epoch": epoch,
		"commandId": cid, "clientSequence": cmd_seq,
		"type": type, "payload": payload
	}
	var r := await _json("POST", "/api/command",
		{"code": code, "token": token, "command": env})
	if serial != _migration_serial:
		return {"ok": false, "state": "unknown", "reason": "результат уточняется после восстановления"}
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
		if serial != _migration_serial:
			return {"ok": false, "state": "unknown", "reason": "результат уточняется после восстановления"}
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


func pause_migration() -> void:
	if migration_paused:
		return
	migration_paused = true
	_migration_serial += 1
	_last_frame_at = 0
	_started = false
	_want_ws = false
	_fallback = false
	_close_sse()
	if _ws != null:
		_ws.close()
		_ws = null
	_ws_was_open = false
	connected = false
	transport = "none"
	connection.emit("migrating", "Восстанавливаем подключение…")


func resume_migration(url: String, keep_paused := false) -> bool:
	base = url.rstrip("/")
	var result := await _entry("GET", "/api/resume?code=%s&token=%s" % [code, token], null)
	if not result.get("ok", false):
		return false
	is_host = bool(result.get("host", false))
	lobby_players = _status_players(result)
	if bool(result.get("started", false)):
		var start: Dictionary = result.get("start", {})
		if start.is_empty():
			return false
		_start_done = false
		latest_snapshot = {}
		world = null
		await _after_start(start, false)
		var session: Dictionary = result.get("session", {})
		if session.get("nextClientSequence") != null:
			cmd_seq = int(session.nextClientSequence) - 1
		if not _started:
			return false
	else:
		_start_done = false
	if not keep_paused:
		finish_migration()
	return true


func finish_migration() -> void:
	migration_paused = false
	connection.emit("online", "")
