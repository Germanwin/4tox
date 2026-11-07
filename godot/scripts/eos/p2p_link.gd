extends "res://scripts/eos/link.gd"

## Настоящий EOS P2P: пакеты между пирами через Epic (NAT punch-through,
## при неудаче — релей). Загружается только когда в проекте есть аддон
## `epic-online-services-godot`, поэтому остальные файлы режима не зависят от
## эпиковских классов и проект живёт без аддона.
##
## Что делает:
##   1. поднимает EOS SDK по ключам из `user://eos.cfg`;
##   2. входит анонимно (`HAuth.login_anonymous_async`) — аккаунт Epic не нужен;
##   3. хозяин открывает сокет и отдаёт код `<Product User ID>.<ключ>`, гость
##      создаёт клиент на этот сокет и Product User ID;
##   4. `EOSGMultiplayerPeer` (RELIABLE, ordered) возит байты; туннель режет
##      их на куски ≤900 Б.
##
## Лобби EOS намеренно НЕ используется: у нашего клиента `CreateLobby`
## отвечает AccessDenied (сервис Lobby не включён в политике), а для игры он
## и не нужен — код комнаты заменяет обмен идентификаторами.
##
## Проверено на настоящем EOS (2026-11-04, две копии на одной машине):
## пакеты ходят, туннель доводит мир и кадры, команда гостя применяется.
## Между разными машинами/сетями ещё не проверялось.

const CFG := "user://eos.cfg"
const BUNDLED_CFG := "res://eos-client.cfg"
const Profile = preload("res://scripts/client_profile.gd")
const DeviceLogin = preload("res://scripts/eos/device_login.gd")
## Один общий Device ID на машину: создание и вход сериализуются между окнами.
const LOGIN_LOCK := "user://eos-login.lock"
const LOCK_STALE := 30.0
const EOS_QUEUE_LIMIT := 2 * 1024 * 1024

## Платформа EOS одна на процесс: входим и поднимаем SDK один раз, а ссылки
## на комнаты создаются и закрываются сколько нужно.
static var _platform_up := false
static var _platform_active := false
static var _cached_user := ""

var _peer = null
var _peer_generation := 0
var _room := ""
var _key := ""
var _host_user := ""
var _host_id := 1
var _local_user := ""
var _booted := false
var _name := "4tox"
var coordinator_url := ""


func available() -> bool:
	return ClassDB.class_exists("EOSGMultiplayerPeer")


func set_coordinator_url(url: String) -> void:
	coordinator_url = url.trim_suffix("/")


static func config_path() -> String:
	# Сборка может содержать отдельную клиентскую конфигурацию. Старый файл в
	# user:// остаётся запасным путём для разработки существующего прототипа.
	if FileAccess.file_exists(BUNDLED_CFG):
		return BUNDLED_CFG
	if FileAccess.file_exists(CFG):
		return CFG
	return ""


func start_host() -> bool:
	if not await _boot():
		return false
	_key = _make_key()
	_peer = EOSGMultiplayerPeer.new()
	_peer.peer_connected.connect(func(id: int) -> void: peer_up.emit(id))
	_peer.peer_disconnected.connect(_on_peer_disconnected.bind(_peer_generation))
	var err: int = _peer.create_server(_key)
	if err != OK:
		_fail("EOS: сервер сокета не создан (" + error_string(err) + ")")
		return false
	# Лобби EOS не используем: приглашение — это Product User ID хозяина и
	# имя сокета, разделённые точкой. Так режим не зависит от сервиса Lobbies.
	_room = _local_user + "." + _key
	return true


func start_client(room: String) -> bool:
	if not await _boot():
		return false
	var code := split_code(room)
	if code.is_empty():
		_fail("EOS: код комнаты — это <id хозяина>.<ключ>, скопируй целиком")
		return false
	_host_user = str(code["user"])
	_key = str(code["key"])
	if _host_user == _local_user:
		_fail("Для подключения через EOS нужны два разных устройства. На этом компьютере оба окна используют один профиль EOS.")
		return false
	_room = _host_user + "." + _key
	_peer = EOSGMultiplayerPeer.new()
	_peer.peer_connected.connect(func(id: int) -> void:
		if _host_id == 1:
			_host_id = id
		peer_up.emit(id))
	_peer.peer_disconnected.connect(_on_peer_disconnected.bind(_peer_generation))
	var err: int = _peer.create_client(_key, _host_user)
	if err != OK:
		_fail("EOS: клиент сокета не создан (" + error_string(err) + ")")
		return false
	return true


## Код комнаты — `<Product User ID хозяина>.<имя сокета>`. Его присылают в
## мессенджере, где строка переносится, а скопировать её могут вместе с
## пробелами и переводом строки. Поэтому весь пробельный мусор выбрасывается,
## иначе гость получает «код комнаты — это <id>.<ключ>» на ровном месте.
func split_code(text: String) -> Dictionary:
	var clean := ""
	for i in range(text.length()):
		var ch := text[i]
		if ch == " " or ch == "\t" or ch == "\n" or ch == "\r" or ch == "\u00a0":
			continue
		clean += ch
	var dot := clean.find(".")
	if dot <= 0 or dot >= clean.length() - 1:
		return {}
	return {"user": clean.substr(0, dot), "key": clean.substr(dot + 1)}


func room_id() -> String:
	return _room


func peers() -> Array:
	if _peer == null:
		return []
	var all = _peer.get_all_peers()
	return all.keys() if all is Dictionary else []


func host_peer() -> int:
	return _host_id


func send(to: int, data: PackedByteArray) -> bool:
	if _peer == null:
		return false
	_peer.set_target_peer(to)
	return _peer.put_packet(data) == OK


func disconnect_peer(peer: int) -> bool:
	if _peer == null or not _peer.has_method("disconnect_peer"):
		return false
	_peer.disconnect_peer(peer, true)
	return true


func poll() -> void:
	if _peer == null:
		return
	if int(_peer.get_active_mode()) == 0:
		return
	_peer.poll()
	while _peer.get_available_packet_count() > 0:
		# Спрашивать отправителя нужно ДО get_packet: addon читает голову
		# очереди, а get_packet её снимает (иначе — падение в libeosg).
		var from: int = _peer.get_packet_peer()
		var data: PackedByteArray = _peer.get_packet()
		if data.size() > 0:
			packet.emit(from, data)


## Отпустить EOS SDK. Без этого движок падает на выходе (segfault в
## teardown): аддон не делает release/shutdown сам.
static func shutdown_eos() -> void:
	if not _platform_active:
		return
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null:
		var auth = tree.root.get_node_or_null("HAuth")
		if auth != null:
			auth.guest_connect_options = null
			auth.guest_coordinator_url = ""
	_platform_up = false
	_platform_active = false
	_cached_user = ""
	EOS.Platform.PlatformInterface.release()
	EOS.Platform.PlatformInterface.shutdown()


func shutdown() -> void:
	stop()
	shutdown_eos()


func stop() -> void:
	_peer_generation += 1
	if _peer != null:
		_peer.close()
		_peer = null


func _on_peer_disconnected(id: int, generation: int) -> void:
	# EOSG продолжает использовать peer после сигнала. Восстановление комнаты
	# может уничтожить его, поэтому уведомляем слушателей после возврата в SDK.
	call_deferred("_emit_peer_down", id, generation)


func _emit_peer_down(id: int, generation: int) -> void:
	if generation == _peer_generation and _peer != null:
		peer_down.emit(id)


func describe() -> String:
	if _key == "":
		return "EOS P2P"
	return "EOS P2P · сокет " + _key


# --------------------------------------------------------------- внутреннее

func _boot() -> bool:
	if _booted:
		return true
	if _platform_up:
		_local_user = _cached_user
		_booted = true
		return true
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		_fail("EOS: нет дерева сцены (слишком ранний вызов)")
		return false
	var root: Node = tree.root
	if coordinator_url != "":
		HLog.log_level = HLog.LogLevel.OFF
	var plat = root.get_node_or_null("HPlatform")
	var auth = root.get_node_or_null("HAuth")
	if plat == null or auth == null:
		_fail("EOS: нет автозагрузок HPlatform/HAuth — аддон не включён")
		return false
	# Кэш SDK у каждого окна свой, а Device ID может быть общим на устройстве.
	# Очередь защищает одновременное создание; удалять ID здесь нельзя.
	var cache_dir := ProjectSettings.globalize_path("user://eosg-cache/client-%d" % Profile.id())
	DirAccess.make_dir_recursive_absolute(cache_dir)
	plat.cache_directory = cache_dir

	var values: Dictionary = await _credentials(tree)
	if values.is_empty():
		_fail("Не удалось получить настройки EOS. Проверьте интернет и повторите попытку.")
		return false
	if not _platform_active:
		var creds := HCredentials.new()
		creds.product_name = str(values.get("product_name", "4tox"))
		creds.product_version = str(values.get("product_version", "0.1"))
		creds.product_id = str(values.get("product_id", ""))
		creds.sandbox_id = str(values.get("sandbox_id", ""))
		creds.deployment_id = str(values.get("deployment_id", ""))
		creds.client_id = str(values.get("client_id", ""))
		creds.client_secret = str(values.get("client_secret", ""))
		if creds.product_id == "" or creds.client_id == "":
			_fail("EOS: конфигурация службы неполная")
			return false
		var initialized := [false]
		var on_initialized := func() -> void: initialized[0] = true
		plat.platform_initialized.connect(on_initialized, CONNECT_ONE_SHOT)
		var ok: bool = await plat.setup_eos_async(creds)
		if plat.platform_initialized.is_connected(on_initialized):
			plat.platform_initialized.disconnect(on_initialized)
		if not ok:
			_fail("EOS: SDK не инициализировался (неверные ключи или нет сети)")
			return false
		_platform_active = true
		if coordinator_url != "":
			EOS.Logging.set_log_level(EOS.Logging.LogCategory.AllCategories, EOS.Logging.LogLevel.Off)
			var limits = EOS.P2P.SetPacketQueueSizeOptions.new()
			limits.incoming_packet_queue_max_size_bytes = EOS_QUEUE_LIMIT
			limits.outgoing_packet_queue_max_size_bytes = EOS_QUEUE_LIMIT
			if not EOS.is_success(EOS.P2P.P2PInterface.set_packet_queue_size(limits)):
				_fail("EOS: не удалось настроить сетевую очередь")
				return false
	# Свой анонимный вход вместо HAuth.login_anonymous_async: тот сначала
	# зовёт delete_device_id, а потом ждёт сигнал. В release-сборке сигнал
	# приходит раньше, чем выставлен await, и вход падал (DuplicateNotAllowed
	# после UnexpectedError на удалении). Здесь обработчик ставится ДО вызова.
	var logged_in: bool
	if values.get("login_method", "") == "openid":
		logged_in = await _login_guest(tree)
	else:
		logged_in = await _login_anonymous(tree)
	if not logged_in:
		return false
	# Медиатор аддона сам ловит событие входа и запоминает Product User ID;
	# ждём, пока он это сделает, иначе create_server откажет.
	var t0 := Time.get_ticks_msec()
	while str(EOSGMultiplayerPeer.get_local_user_id()) == "" \
			and Time.get_ticks_msec() - t0 < 5000:
		await tree.create_timer(0.1).timeout
	if str(EOSGMultiplayerPeer.get_local_user_id()) == "":
		_fail("EOS: аддон не запомнил Product User ID после входа")
		return false
	_booted = true
	_platform_up = true
	_cached_user = _local_user
	return true


func _credentials(tree: SceneTree) -> Dictionary:
	if not coordinator_url.begins_with("https://"):
		var cfg := ConfigFile.new()
		if config_path() == "" or cfg.load(config_path()) != OK:
			return {}
		var values := {}
		for key in ["product_name", "product_version", "product_id", "sandbox_id", "deployment_id", "client_id", "client_secret"]:
			values[key] = str(cfg.get_value("eos", key, ""))
		return values
	for attempt in range(3):
		var http := HTTPRequest.new()
		http.use_threads = true
		http.timeout = 10.0
		tree.root.add_child(http)
		var request_error := http.request(coordinator_url + "/config")
		if request_error == OK:
			var result: Array = await http.request_completed
			http.queue_free()
			if int(result[0]) == HTTPRequest.RESULT_SUCCESS and int(result[1]) == 200:
				var parsed: Variant = JSON.parse_string((result[3] as PackedByteArray).get_string_from_utf8())
				if parsed is Dictionary and parsed.get("ok", false) and parsed.get("eos") is Dictionary:
					return parsed.eos
				push_warning("EOS config response was invalid")
				return {}
			push_warning("EOS config request failed: result=%d HTTP=%d" % [int(result[0]), int(result[1])])
			if int(result[0]) == HTTPRequest.RESULT_SUCCESS and int(result[1]) not in [500, 502, 503, 504]:
				return {}
		else:
			http.queue_free()
			push_warning("EOS config request could not start: %d" % request_error)
		if attempt < 2:
			await tree.create_timer(0.4 * (attempt + 1)).timeout
	return {}





## Анонимный вход через Connect. Если Device ID уже существует, используем его;
## независимые идентичности нескольких копий на одном устройстве не гарантированы.
func _login_anonymous(tree: SceneTree) -> bool:
	if not await _acquire_login_lock(tree):
		_fail("EOS: другое окно уже входит в EOS — подождите пару секунд")
		return false
	# Обычный запуск не удаляет Device ID: иначе меняется идентичность и
	# другая работающая копия может потерять свои учётные данные.
	var made: Variant = await _create_device(tree)
	var ok := false
	if DeviceLogin.can_login(_ok(made), _res(made)):
		ok = await _login_with_device(tree, true)
	else:
		_fail("EOS: device id не создан (" + _res(made) + ")")
	_release_login_lock()
	return ok


## Атомарный каталог-очередь. Брошенный после падения забирается через
## LOCK_STALE секунд.
func _acquire_login_lock(tree: SceneTree) -> bool:
	var path := ProjectSettings.globalize_path(LOGIN_LOCK)
	var t0 := Time.get_ticks_msec()
	while true:
		if DirAccess.make_dir_absolute(path) == OK:
			return true
		var mtime := FileAccess.get_modified_time(path)
		if mtime > 0 and Time.get_unix_time_from_system() - float(mtime) > LOCK_STALE:
			DirAccess.remove_absolute(path)
			continue
		if Time.get_ticks_msec() - t0 > int((LOCK_STALE + 5.0) * 1000.0):
			return false
		await tree.create_timer(0.1).timeout
	return false


func _release_login_lock() -> void:
	var path := ProjectSettings.globalize_path(LOGIN_LOCK)
	if DirAccess.dir_exists_absolute(path):
		DirAccess.remove_absolute(path)


func _create_device(tree: SceneTree) -> Variant:
	var ie = EOS.get_instance()
	return await _once(tree, ie.connect_interface_create_device_id_callback,
		func() -> void:
			var opts = EOS.Connect.CreateDeviceIdOptions.new()
			opts.device_model = " ".join(PackedStringArray([OS.get_name(), OS.get_model_name()]))
			EOS.Connect.ConnectInterface.create_device_id(opts))


func _delete_device(tree: SceneTree) -> Variant:
	var ie = EOS.get_instance()
	return await _once(tree, ie.connect_interface_delete_device_id_callback,
		func() -> void:
			EOS.Connect.ConnectInterface.delete_device_id(
				EOS.Connect.DeleteDeviceIdOptions.new()))


func _login_with_device(tree: SceneTree, report: bool) -> bool:
	var lo = EOS.Connect.LoginOptions.new()
	lo.credentials = EOS.Connect.Credentials.new()
	lo.credentials.type = EOS.ExternalCredentialType.DeviceidAccessToken
	lo.credentials.token = null
	lo.user_login_info = EOS.Connect.UserLoginInfo.new()
	lo.user_login_info.display_name = _name
	return await _login_with_options(tree, lo, report)


func _login_guest(tree: SceneTree) -> bool:
	var data: Variant = null
	for attempt in range(3):
		var http := HTTPRequest.new()
		http.use_threads = true
		http.timeout = 10.0
		tree.root.add_child(http)
		var err := http.request(coordinator_url + "/openid/token", ["Content-Type: application/json"], HTTPClient.METHOD_POST, "{}")
		if err == OK:
			var response: Array = await http.request_completed
			if int(response[0]) == HTTPRequest.RESULT_SUCCESS and int(response[1]) == 200:
				data = JSON.parse_string((response[3] as PackedByteArray).get_string_from_utf8())
				http.queue_free()
				break
		http.queue_free()
		if attempt < 2:
			await tree.create_timer(0.4 * (attempt + 1)).timeout
	if data == null:
		_fail("EOS: не удалось получить гостевой доступ")
		return false
	if not data is Dictionary or not data.get("token") is String or data.token.length() > 256 or data.token.is_empty():
		_fail("EOS: неверный ответ гостевой службы")
		return false
	var lo = EOS.Connect.LoginOptions.new()
	lo.credentials = EOS.Connect.Credentials.new()
	lo.credentials.type = EOS.ExternalCredentialType.OpenidAccessToken
	lo.credentials.token = data.token
	if not await _login_with_options(tree, lo, true):
		return false
	var auth = tree.root.get_node_or_null("HAuth")
	if auth != null:
		auth.guest_coordinator_url = coordinator_url
		auth.guest_connect_options = lo
	return true


func _login_with_options(tree: SceneTree, lo: Variant, report: bool) -> bool:
	var ie = EOS.get_instance()
	var login: Variant = await _connect_login_retry(tree, lo)
	if login is Dictionary and int(login.get("result_code", -1)) == EOS.Result.InvalidUser:
		var continuation = login.get("continuance_token")
		if continuation == null:
			_fail("EOS: не удалось создать профиль устройства")
			return false
		var created: Variant = await _once(tree, ie.connect_interface_create_user_callback,
			func() -> void:
				var options = EOS.Connect.CreateUserOptions.new()
				options.continuance_token = continuation
				EOS.Connect.ConnectInterface.create_user(options))
		if not _ok(created):
			_fail("EOS: не удалось создать профиль устройства")
			return false
		# После создания повторяем вход: runtime и P2P-аддон узнают пользователя
		# из callback Login, а не только из ответа CreateUser.
		login = await _connect_login_retry(tree, lo)
	if not _ok(login):
		if report:
			_fail("EOS: вход не удался (" + _res(login) + ")")
		else:
			print("EOS: вход существующим device id не удался: ", _res(login))
		return false
	_local_user = str(login.get("local_user_id", ""))
	if _local_user == "":
		_fail("EOS: вход не дал Product User ID")
		return false
	return true


func _connect_login_retry(tree: SceneTree, options: Variant) -> Variant:
	var ie = EOS.get_instance()
	for attempt in range(3):
		var result: Variant = await _once(tree, ie.connect_interface_login_callback,
			func() -> void: EOS.Connect.ConnectInterface.login(options))
		if result != null:
			return result
		if attempt < 2:
			await tree.create_timer(0.5 * (attempt + 1)).timeout
	return null


func _ok(v: Variant) -> bool:
	return v is Dictionary and EOS.is_success(v)


func _once(tree: SceneTree, sig: Signal, start: Callable, timeout_ms := 15000) -> Variant:
	var box := {"done": false, "value": null}
	var cb := func(d: Variant) -> void:
		box["done"] = true
		box["value"] = d
	sig.connect(cb, CONNECT_ONE_SHOT)
	start.call()
	var t0 := Time.get_ticks_msec()
	var last_frame := t0
	var max_gap := 0
	var expired_frames := 0
	while not box["done"]:
		await tree.process_frame
		var now := Time.get_ticks_msec()
		max_gap = maxi(max_gap, now - last_frame)
		last_frame = now
		if now - t0 >= timeout_ms:
			# process_frame runs before EOSGRuntime._process. After a long
			# render stall, let the SDK tick before declaring the callback lost.
			expired_frames += 1
			if expired_frames >= 3:
				break
	if sig.is_connected(cb):
		sig.disconnect(cb)
	if not box["done"]:
		push_warning("EOS callback timed out; longest frame gap=%d ms" % max_gap)
	return box["value"]


func _res(v: Variant) -> String:
	if v is Dictionary:
		return EOS.result_str(v)
	return "нет ответа"


func _make_key() -> String:
	return "t4x" + Crypto.new().generate_random_bytes(8).hex_encode()


func _fail(text: String) -> void:
	last_error = text
	failed.emit(text)
