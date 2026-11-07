extends Control

## Отдельный режим «EOS»: хозяин поднимает Node-сервер у себя, гость приходит
## к нему через туннель поверх пир-транспорта (EOS P2P или петля localhost).
##
## Основной режим «Сеть» не используется и не меняется: здесь свой экран и
## свой LiveRoom. Мир по-прежнему считает Node-сервер — EOS заменяет только
## провод, а не авторитет.

signal match_ready(room)
signal back

const LiveRoom = preload("res://scripts/live_room.gd")
const Tunnel = preload("res://scripts/eos/tunnel.gd")
const LoopLink = preload("res://scripts/eos/loop_link.gd")
const Supervisor = preload("res://scripts/server_supervisor.gd")
const Coordinator = preload("res://scripts/eos/coordinator_client.gd")
const UI = preload("res://scripts/ui_theme.gd")
const ClientProfile = preload("res://scripts/client_profile.gd")

const P2P_PATH := "res://scripts/eos/p2p_link.gd"
const DEFAULT_COORDINATOR := "https://374412.fornex.cloud/api/eos-coordinator"
## Хозяин, к которому никто не зашёл, держит лобби не дольше этого.
const UNUSED_TTL := 30.0
const PUBLIC_UNUSED_TTL := 300.0

var server = null
var link = null
var tunnel = null
var room = null
var coordinator = null
var coordinator_base := ""
var coordinator_test := false
var session_override := ""
var _backup_timer := 0.0
var _backup_busy := false
var _last_backup_success := 0
var _lease_renew_busy := false
var _recovering := false
var _recovery_deadline := 0
var _active_address := ""
var _active_generation := 0
var _candidate_busy := false
var _attach_busy := false
var _last_recovery_error := ""
var _last_backup_error := ""
var _recovery_terminal := false
var _resign_busy := false
var _restoring_from_disk := false
var is_host := false
var joined := false
var is_ready := false

var _busy := false
var _generation := 0
var _size := 64
var _seed := "тихая-долина-701"
var _meta: Dictionary = {}

var _panel: PanelContainer
var _status_label: Label
var _invite: LineEdit
var _invite_code := ""
var _code_caption: Label
var _code_row: HBoxContainer
var _copy_btn: Button
## Код, который последним собирались положить в буфер. Имя честное: в headless
## буфера обмена нет (`DisplayServer.FEATURE_CLIPBOARD`), и тогда это запись о
## намерении, а на экране — слова «буфера обмена нет».
var last_copied := ""
var _name: LineEdit
var _code: LineEdit
var _transport: OptionButton
var _capacity: OptionButton
var _host_btn: Button
var _join_btn: Button
var _ready_btn: Button
var _start_btn: Button
var _back_btn: Button
var _players: Label
var _hint: Label
var _unused_timer: Timer = null


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	theme = UI.theme()
	_build()
	_unused_timer = Timer.new()
	_unused_timer.one_shot = true
	_unused_timer.wait_time = UNUSED_TTL
	_unused_timer.timeout.connect(_on_unused_timeout)
	add_child(_unused_timer)
	visible = false


func _process(dt: float) -> void:
	if coordinator == null or not joined:
		return
	if _recovering and Time.get_ticks_msec() > _recovery_deadline:
		_recovery_failed("Восстановить подключение не удалось. Вернитесь в меню и создайте комнату заново.")
		return
	if is_host and not _recovering:
		if _last_backup_success > 0 and Time.get_ticks_msec() - _last_backup_success > 15000:
			coordinator.abandon_lease()
			return
		_backup_timer -= dt
		if _backup_timer <= 0.0 and not _backup_busy:
			_backup_timer = 3.0
			_backup()


func open(size: int, seed_text: String) -> void:
	_size = size
	_seed = seed_text
	_clear_room()
	joined = false
	is_host = false
	is_ready = false
	_meta = {}
	_busy = false
	_status_label.text = "хозяин создаёт комнату, гость вводит её номер"
	_set_invite("")
	_players.text = ""
	_ready_btn.disabled = true
	_start_btn.visible = false
	_hint.text = ""
	_fill_transport()
	visible = true
	UI.pop_in(_panel, 0.24)
	if not coordinator_test and FileAccess.file_exists(_session_path()):
		_resume_saved.call_deferred()


## Матч кончился/игрок ушёл в меню — гасим всё, что подняли.
func close_room() -> void:
	await _polite_leave()
	_clear_saved()
	_clear_room()
	visible = false
	joined = false


func state() -> Dictionary:
	return {"joined": joined, "host": is_host, "ready": is_ready,
		"room": room, "transport": _transport_id(), "invite": link.room_id() if link != null else ""}


# ------------------------------------------------------------------- экран

func _build() -> void:
	var dim := ColorRect.new()
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.color = Color(0.02, 0.08, 0.14, 0.55)
	dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(center)
	_panel = UI.panel(22)
	_panel.custom_minimum_size = Vector2(820, 0)
	center.add_child(_panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	_panel.add_child(box)

	var title := UI.label("EOS", 32, UI.CREAM, 8)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(title)
	var note := UI.ink_label("отдельный режим: мир считает Node у хозяина, гость идёт через пир-транспорт", 13)
	note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	note.add_theme_color_override("font_color", UI.INK_SOFT)
	box.add_child(note)

	var trow := HBoxContainer.new()
	trow.add_theme_constant_override("separation", 8)
	box.add_child(trow)
	trow.add_child(UI.ink_label("транспорт", 14))
	_transport = OptionButton.new()
	_transport.add_item("EOS (Epic)")
	_transport.add_item("Петля (localhost)")
	_transport.custom_minimum_size = Vector2(260, 38)
	trow.add_child(_transport)
	trow.add_child(UI.ink_label("игроков", 14))
	_capacity = OptionButton.new()
	for count in range(2, 5):
		_capacity.add_item(str(count), count)
	trow.add_child(_capacity)

	var name_row := HBoxContainer.new()
	name_row.add_theme_constant_override("separation", 8)
	box.add_child(name_row)
	name_row.add_child(UI.ink_label("имя", 14))
	_name = LineEdit.new()
	_name.text = "Godot"
	_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_name.custom_minimum_size = Vector2(260, 38)
	name_row.add_child(_name)
	name_row.add_child(UI.ink_label("код комнаты", 14))
	_code = LineEdit.new()
	_code.placeholder_text = "id или порт"
	_code.custom_minimum_size = Vector2(260, 38)
	name_row.add_child(_code)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	box.add_child(row)
	_host_btn = UI.button("Создать комнату", 16, "primary")
	_host_btn.custom_minimum_size = Vector2(230, 46)
	_host_btn.pressed.connect(func() -> void: host_game())
	row.add_child(_host_btn)
	_join_btn = UI.button("Войти по коду", 16)
	_join_btn.custom_minimum_size = Vector2(210, 46)
	_join_btn.pressed.connect(func() -> void: join_game())
	row.add_child(_join_btn)
	_back_btn = UI.button("Назад", 15, "ghost")
	_back_btn.custom_minimum_size = Vector2(140, 46)
	_back_btn.pressed.connect(func() -> void: _leave_and_back())
	row.add_child(_back_btn)

	_status_label = UI.ink_label("", 14)
	_status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_status_label)

	# Код комнаты — длинная строка («<Product User ID хозяина>.<имя сокета>»),
	# вручную её не переписать. Поэтому код лежит в поле, откуда его можно
	# выделить и скопировать, а кнопка рядом кладёт в буфер всю строку целиком.
	_code_caption = UI.ink_label("код для друга", 14)
	_code_caption.add_theme_color_override("font_color", UI.INK_SOFT)
	_code_caption.visible = false
	box.add_child(_code_caption)
	_code_row = HBoxContainer.new()
	_code_row.add_theme_constant_override("separation", 10)
	_code_row.visible = false
	box.add_child(_code_row)
	_invite = LineEdit.new()
	_invite.editable = false
	_invite.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_invite.custom_minimum_size = Vector2(0, 42)
	_invite.add_theme_font_size_override("font_size", 18)
	_invite.add_theme_color_override("font_color", UI.GOLD)
	_invite.add_theme_color_override("font_uneditable_color", UI.GOLD)
	_invite.add_theme_color_override("caret_color", UI.GOLD)
	var code_box := StyleBoxFlat.new()
	code_box.bg_color = Color("#231d14")
	code_box.border_color = UI.WOOD_DARK
	code_box.set_border_width_all(2)
	code_box.set_corner_radius_all(12)
	code_box.content_margin_left = 14
	code_box.content_margin_right = 14
	_invite.add_theme_stylebox_override("normal", code_box)
	_invite.add_theme_stylebox_override("focus", code_box)
	# Поле только для чтения: Godot рисует его стилем `read_only`, а не
	# `normal`, — без этой строки код выходил бледным по светлой плашке.
	_invite.add_theme_stylebox_override("read_only", code_box)
	_code_row.add_child(_invite)
	_copy_btn = UI.button("Копировать", 15, "secondary")
	_copy_btn.custom_minimum_size = Vector2(170, 42)
	_copy_btn.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_copy_btn.visible = false
	_copy_btn.tooltip_text = "код комнаты целиком — в буфер обмена"
	_copy_btn.pressed.connect(func() -> void: copy_invite())
	_code_row.add_child(_copy_btn)

	box.add_child(UI.hsep(2))
	box.add_child(UI.ink_label("состав", 14))
	_players = UI.ink_label("", 15)
	_players.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_players)

	var actions := HBoxContainer.new()
	actions.add_theme_constant_override("separation", 10)
	box.add_child(actions)
	_ready_btn = UI.button("Готов", 17, "primary")
	_ready_btn.custom_minimum_size = Vector2(200, 50)
	_ready_btn.disabled = true
	_ready_btn.pressed.connect(func() -> void: toggle_ready())
	actions.add_child(_ready_btn)
	_start_btn = UI.button("Начать игру", 17, "primary")
	_start_btn.custom_minimum_size = Vector2(240, 50)
	_start_btn.visible = false
	_start_btn.pressed.connect(func() -> void: start_game())
	actions.add_child(_start_btn)

	box.add_child(UI.hsep(6))
	_hint = UI.ink_label("", 12)
	_hint.add_theme_color_override("font_color", UI.INK_SOFT)
	_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_hint.custom_minimum_size = Vector2(740, 20)
	box.add_child(_hint)
	box.add_child(UI.hsep(8))


# ------------------------------------------------------------------- ходы

func host_game() -> void:
	if _busy or joined:
		return
	_busy = true
	_clear_room()
	_busy = true
	var generation := _generation
	if _needs_coordinator() and not _setup_coordinator():
		_status_label.text = "Служба комнат не настроена или недоступна"
		_busy = false
		return
	_status_label.text = "открываем транспорт…"
	link = _make_link()
	if link == null:
		_clear_room()
		_status_label.text = "нет EOS-аддона: выберите петлю"
		_busy = false
		return
	link.failed.connect(_on_link_failed)
	_watch_link(link)
	if coordinator != null and link.has_method("set_coordinator_url"):
		link.set_coordinator_url(coordinator.base)
	if coordinator_test and link is ToxEosLoopLink:
		link.listen_port = 0
	var pending_link = link
	var connected: bool = await pending_link.start_host()
	if generation != _generation:
		pending_link.stop()
		return
	if not connected:
		var error: String = "транспорт: " + str(link.error_text())
		_clear_room()
		_status_label.text = error
		_busy = false
		return
	# EOS и сеть могут подключаться долго. Не запускать аренду локального
	# сервера до того, как транспорт готов, иначе она истечёт во время входа.
	_status_label.text = "поднимаем Node-сервер…"
	server = Supervisor.new()
	server.migration_enabled = coordinator != null
	if coordinator_test:
		var temporary := OS.get_environment("TMPDIR")
		if temporary == "": temporary = ProjectSettings.globalize_path("user://state")
		server.recovery_state_dir = temporary.path_join("4tox-coord-test-" + Crypto.new().generate_random_bytes(12).hex_encode()).path_join("rooms")
	server.name = "EosServer"
	add_child(server)
	var up: bool = await server.start_server()
	if generation != _generation:
		return
	if not up:
		var error := "сервер не поднялся: " + str(server.last_error)
		_clear_room()
		_status_label.text = error
		_busy = false
		return
	tunnel = Tunnel.new()
	tunnel.failed.connect(_on_tunnel_failed)
	tunnel.require_auth = coordinator != null
	tunnel.name = "EosTunnel"
	add_child(tunnel)
	tunnel.start_host(link, server.port)
	_status_label.text = "создаём лобби…"
	room = _make_room()
	var created: bool = await room.create_lobby(server.base, _player_name(), _seed, _size, _capacity.get_selected_id())
	if generation != _generation:
		return
	if not created:
		var error := "лобби: " + str(room.last_error)
		_clear_room()
		_status_label.text = error
		_busy = false
		return
	if coordinator != null:
		_status_label.text = "регистрируем комнату…"
		var created_remote: Dictionary = await coordinator.create_room(_player_name(), _capacity.get_selected_id(), _network_version(), link.room_id())
		if generation != _generation:
			return
		if not created_remote.get("ok", false):
			push_warning("Coordinator create failed: " + str(created_remote.get("reason", "unknown")))
			_clear_room()
			_status_label.text = "Не удалось создать комнату. Проверьте подключение и попробуйте ещё раз."
			return
		var bound: Dictionary = await coordinator.request("bind", {"playerId": room.player_id, "roomTokenHash": room.token.sha256_text()})
		if generation != _generation:
			return
		if not bound.get("ok", false):
			_clear_room()
			_status_label.text = "Не удалось подготовить комнату. Попробуйте снова."
			return
		if not await _renew_node_lease():
			_clear_room()
			_status_label.text = "Не удалось подтвердить полномочия комнаты."
			return
		tunnel.set_authorized_hashes(coordinator.state.get("ticketHashes", []))
		_active_address = link.room_id()
		_active_generation = coordinator.generation
		_last_backup_success = Time.get_ticks_msec()
	tunnel.publish_meta({"code": room.code, "seed": _seed, "size": _size})
	is_host = true
	joined = true
	_busy = false
	_after_join()
	if coordinator != null:
		_backup()


func join_game() -> void:
	if _busy or joined:
		return
	var code := _code.text.strip_edges()
	if code == "":
		_status_label.text = "введите код комнаты"
		return
	_busy = true
	_clear_room()
	_busy = true
	var generation := _generation
	if _needs_coordinator() and not _setup_coordinator():
		_status_label.text = "Служба комнат не настроена или недоступна"
		_busy = false
		return
	_status_label.text = "подключаемся…"
	if coordinator != null:
		var lookup: Dictionary = {}
		var original_name := _player_name()
		var net_version := _network_version()
		for suffix in range(1, 17):
			var candidate := original_name if suffix == 1 else original_name.left(20) + " " + str(suffix)
			lookup = await coordinator.join_room(code, candidate, net_version)
			if generation != _generation:
				return
			if lookup.get("ok", false):
				_name.text = candidate
				break
			if str(lookup.get("reason", "")) != "name_taken":
				break
		if generation != _generation:
			return
		if not lookup.get("ok", false):
			var reason := str(lookup.get("reason", ""))
			_clear_room()
			match reason:
				"full": _status_label.text = "В комнате нет свободных мест."
				"started": _status_label.text = "Игра уже началась, новые участники не принимаются."
				"name_taken": _status_label.text = "Не удалось подобрать свободное имя. Измените имя и попробуйте снова."
				"incompatible_or_name", "version_mismatch": _status_label.text = "Версии игры не совпадают. Установите одинаковую сборку."
				"unavailable": _status_label.text = "Комната не найдена или закрыта. Проверьте код."
				"rate_limit": _status_label.text = "Слишком много попыток. Подождите минуту и попробуйте снова."
				_: _status_label.text = "Не удалось связаться со службой комнат. Проверьте интернет и повторите попытку."
			return
		code = str(lookup.get("address", ""))
		_active_address = code
		_active_generation = coordinator.generation
	link = _make_link()
	if link == null:
		_status_label.text = "нет EOS-аддона: выберите петлю"
		_busy = false
		return
	link.failed.connect(_on_link_failed)
	_watch_link(link)
	if coordinator != null and link.has_method("set_coordinator_url"):
		link.set_coordinator_url(coordinator.base)
	var pending_link = link
	var connected: bool = await pending_link.start_client(code)
	if generation != _generation:
		pending_link.stop()
		return
	if not connected:
		var error: String = "транспорт: " + str(link.error_text())
		_clear_room()
		_status_label.text = error
		_busy = false
		return
	tunnel = Tunnel.new()
	tunnel.failed.connect(_on_tunnel_failed)
	tunnel.require_auth = coordinator != null
	if coordinator != null:
		tunnel.auth_token = coordinator.token
	tunnel.name = "EosTunnel"
	add_child(tunnel)
	tunnel.meta.connect(_on_meta)
	var port: int = tunnel.start_guest(link)
	if port <= 0:
		_clear_room()
		_status_label.text = "туннель не поднялся"
		_busy = false
		return
	_status_label.text = "ждём комнату от хозяина…"
	var meta := await _wait_meta(20.0)
	if generation != _generation:
		return
	if meta.is_empty():
		_clear_room()
		_status_label.text = "хозяин не прислал комнату (код или сеть?)"
		_busy = false
		return
	room = _make_room()
	_status_label.text = "Входим в комнату…" if coordinator != null else "входим в лобби " + str(meta.get("code", "")) + "…"
	var joined_ok: bool = await room.join_lobby(tunnel.local_url(), str(meta.get("code", "")), _player_name())
	if generation != _generation:
		return
	if not joined_ok:
		var error := "вход: " + str(room.last_error)
		_clear_room()
		_status_label.text = error
		_busy = false
		return
	if coordinator != null:
		var bound: Dictionary = await coordinator.request("bind", {"playerId": room.player_id, "roomTokenHash": room.token.sha256_text()})
		if generation != _generation:
			return
		if not bound.get("ok", false):
			_clear_room()
			_status_label.text = "Не удалось завершить вход в комнату."
			return
	joined = true
	_busy = false
	_after_join()


func toggle_ready() -> void:
	if room == null or not joined:
		return
	is_ready = not is_ready
	_ready_btn.text = "Отменить готовность" if is_ready else "Готов"
	await room.set_ready(is_ready)


func start_game() -> void:
	if room == null or not is_host:
		return
	_status_label.text = "стартуем…"
	if coordinator != null:
		var admission: Dictionary = await coordinator.request("start", {})
		if not admission.get("ok", false):
			_status_label.text = "Не удалось начать: нет связи со службой комнат."
			return
	var started: bool = await room.start_now()
	if not started and coordinator != null:
		var observed: Dictionary = await room.lobby_status()
		if observed.get("ok", false) and not bool(observed.get("started", false)):
			await coordinator.request("unstart", {})


# --------------------------------------------------------------- внутреннее

func _after_join() -> void:
	_ready_btn.disabled = false
	_start_btn.visible = is_host
	_set_invite(coordinator.code if coordinator != null else link.room_id())
	_status_label.text = "Комната готова" if coordinator != null else "лобби " + room.code + " · " + link.describe()
	if is_host and _unused_timer != null:
		_unused_timer.wait_time = PUBLIC_UNUSED_TTL if coordinator != null else UNUSED_TTL
		_unused_timer.start()
	if room.lobby_players.size() > 0:
		_on_lobby_update(room.lobby_players, false, {})
	_save_session()


## Показать код комнаты или убрать его. Поле, из которого код можно выделить,
## и кнопка, которая кладёт в буфер всю строку, — единственный способ отдать
## другу 47 символов без переписывания руками.
func _set_invite(code: String) -> void:
	_invite_code = code
	if _invite != null:
		_invite.text = code
		_invite.tooltip_text = "выделите код мышью и скопируйте" if code != "" else ""
	if _code_row != null:
		_code_row.visible = code != ""
	if _code_caption != null:
		_code_caption.visible = code != ""
	if _copy_btn == null:
		return
	_copy_btn.visible = code != ""
	_copy_btn.text = "Копировать"
	_copy_btn.tooltip_text = "код комнаты целиком — в буфер обмена"


## Код комнаты целиком — в буфер обмена. Без буфера (headless, урезанный
## display server) не падаем: код остаётся на экране, кнопка говорит словами.
func copy_invite() -> String:
	if _invite_code == "":
		return ""
	last_copied = _invite_code
	var has_clipboard := DisplayServer.has_feature(DisplayServer.FEATURE_CLIPBOARD)
	if has_clipboard:
		DisplayServer.clipboard_set(_invite_code)
	if _copy_btn != null:
		_copy_btn.text = "скопировано" if has_clipboard else "код выше"
	if _status_label != null:
		_status_label.text = ("код комнаты в буфере обмена — вставьте его другу (⌘V или Ctrl+V)"
			if has_clipboard else "буфера обмена нет: выделите код мышью и скопируйте")
	return _invite_code


func _make_room():
	var r = LiveRoom.new()
	r.name = "EosRoom"
	r.persist_session = false
	r.watch_stall = coordinator != null
	add_child(r)
	r.lobby_update.connect(_on_lobby_update)
	r.room_started.connect(_on_room_started)
	r.failed.connect(_on_room_failed)
	r.status.connect(func(text: String) -> void:
		if not joined:
			_status_label.text = text)
	r.connection.connect(func(state: String, _detail: String) -> void:
		if state in ["stalled", "lost"] and coordinator != null:
			if is_host: coordinator.abandon_lease()
			else: _begin_recovery())
	return r


func _make_link():
	var id := _transport_id()
	if id == "loop":
		return LoopLink.new()
	var script = load(P2P_PATH)
	if script == null or not script.can_instantiate():
		return null
	return script.new()


func _watch_link(target) -> void:
	target.peer_down.connect(func(_peer: int) -> void:
		if target == link and coordinator != null and joined and not is_host:
			_begin_recovery())


func _transport_id() -> String:
	return "loop" if _transport.get_selected_id() == 1 else "eos"


func _fill_transport() -> void:
	var eos_ok: bool = ClassDB.class_exists("EOSGMultiplayerPeer")
	_transport.set_item_disabled(0, not eos_ok)
	_transport.select(0 if eos_ok else 1)
	if not eos_ok:
		_hint.text = "EOS выключен: нет аддона EOS" \
			+ " · петля работает на этой машине"


func _on_meta(d: Dictionary) -> void:
	_meta = d


func _wait_meta(timeout_s: float) -> Dictionary:
	var t0 := Time.get_ticks_msec()
	while _meta.is_empty() and Time.get_ticks_msec() - t0 < int(timeout_s * 1000.0):
		await get_tree().process_frame
	return _meta


func _on_lobby_update(players: Array, started: bool, _block: Dictionary) -> void:
	var lines: Array[String] = []
	var all_ready := players.size() >= 2
	var online_count := 0
	for p in players:
		var nm := str(p.get("name", "?"))
		var rdy := bool(p.get("ready", false))
		var online := true
		if coordinator != null:
			for member in coordinator.state.get("members", []):
				if str(member.get("name", "")) == nm:
					online = bool(member.get("online", false))
		lines.append(("✓ " if rdy and online else "· ") + nm + (" (нет связи)" if not online else ""))
		if online:
			online_count += 1
		if not rdy or not online:
			all_ready = false
	_players.text = "\n".join(lines)
	if is_host:
		_start_btn.visible = true
		_start_btn.disabled = not all_ready or started
		_hint.text = "можно начинать" if all_ready else "нужно двое и «Готов» у обоих"
	else:
		_start_btn.visible = false
		_hint.text = "ждём, когда хозяин начнёт"
	if started or online_count >= 2:
		_stop_unused_timer()
	elif is_host and _unused_timer != null and _unused_timer.is_stopped():
		_unused_timer.start()
	if started:
		_status_label.text = "партия началась"


func _on_room_started() -> void:
	_stop_unused_timer()
	if coordinator != null and is_host:
		_mark_started()
	_save_session()
	visible = false
	match_ready.emit(room)


func _on_room_failed(text: String) -> void:
	_status_label.text = text
	_hint.text = text


func _on_link_failed(text: String) -> void:
	_status_label.text = text
	_hint.text = text


func _on_tunnel_failed(text: String) -> void:
	_status_label.text = text
	if coordinator != null and joined:
		if is_host:
			coordinator.abandon_lease()
		else:
			_begin_recovery()


func _player_name() -> String:
	var nm := _name.text.strip_edges()
	return "Godot" if nm == "" else nm.left(24)


func _leave_and_back() -> void:
	await _polite_leave()
	_clear_saved()
	_clear_room()
	joined = false
	visible = false
	back.emit()


func _polite_leave() -> void:
	if coordinator == null:
		return
	var c = coordinator
	if c.code == "" or c.token == "":
		return
	if is_host and not _recovering:
		var until := Time.get_ticks_msec() + 5000
		while _backup_busy and Time.get_ticks_msec() < until:
			await get_tree().create_timer(0.1).timeout
		if c == coordinator and not _backup_busy:
			await _backup()
	if c == coordinator:
		await c.leave()


func _exit_tree() -> void:
	var script = load(P2P_PATH)
	if script != null and script.has_method("shutdown_eos"):
		script.shutdown_eos()


func _stop_unused_timer() -> void:
	if _unused_timer != null:
		_unused_timer.stop()


## Хозяин ждал гостя 30 секунд — закрываем комнату, сервер и сокет, чтобы
## не занимать слот и EOS-сессию. Экран остаётся, можно создать заново.
func _on_unused_timeout() -> void:
	if not joined or not is_host:
		return
	if coordinator != null:
		var online := 0
		for member in coordinator.state.get("members", []):
			if member.get("online", false): online += 1
		if online >= 2: return
	elif room != null and room.lobby_players.size() >= 2:
		return
	var code: String = str(coordinator.code) if coordinator != null else (str(room.code) if room != null else "")
	var was_public := coordinator != null
	_clear_saved()
	_clear_room()
	joined = false
	is_host = false
	is_ready = false
	_ready_btn.disabled = true
	_start_btn.visible = false
	_set_invite("")
	_players.text = ""
	_status_label.text = "Комната закрыта: время ожидания гостей истекло" if was_public else "лобби " + code + " закрыто: за 30 секунд никто не зашёл"
	_hint.text = "создайте комнату заново"


func _clear_room() -> void:
	_generation += 1
	_busy = false
	_recovering = false
	_recovery_terminal = false
	_candidate_busy = false
	_attach_busy = false
	_stop_unused_timer()
	var local_code: String = str(room.code) if room != null else ""
	if coordinator != null:
		_release_coordinator(coordinator)
		coordinator = null
	if room != null:
		room.leave()
		room.queue_free()
		room = null
	if tunnel != null:
		tunnel.stop()
		tunnel.queue_free()
		tunnel = null
	if link != null:
		link.stop()
		link = null
	if server != null:
		var old_state: String = server.state_dir
		var was_migrating: bool = server.migration_enabled
		server.stop()
		if was_migrating and old_state != "" and _safe_room_code(local_code):
			server._remove_tree(old_state.path_join(local_code))
		server.queue_free()
		server = null


func _needs_coordinator() -> bool:
	return _transport_id() == "eos" or coordinator_test


func _network_version() -> String:
	var probe := Supervisor.new()
	var root: String = probe.find_project_dir()
	probe.free()
	if root == "":
		return ""
	var paths: Array[String] = []
	for dir in ["game/shared", "game/server", "mapgen2/js", "mapgen2/js/simulation"]:
		var handle := DirAccess.open(root.path_join(dir))
		if handle == null:
			return ""
		handle.list_dir_begin()
		var entry := handle.get_next()
		while entry != "":
			if not handle.current_is_dir() and entry.ends_with(".js"):
				paths.append(dir + "/" + entry)
			entry = handle.get_next()
		handle.list_dir_end()
	paths.sort()
	var hash := HashingContext.new()
	hash.start(HashingContext.HASH_SHA256)
	for path in paths:
		hash.update(path.to_utf8_buffer())
		hash.update(FileAccess.get_file_as_bytes(root.path_join(path)))
	return "p4-" + hash.finish().hex_encode().substr(0, 24)


func _setup_coordinator() -> bool:
	var url := coordinator_base
	if url == "":
		var script = load(P2P_PATH)
		var cfg := ConfigFile.new()
		if script != null and script.config_path() != "" and cfg.load(script.config_path()) == OK:
			url = str(cfg.get_value("coordinator", "url", ""))
		if url == "":
			url = DEFAULT_COORDINATOR
	coordinator = Coordinator.new()
	add_child(coordinator)
	if not coordinator.configure(url, coordinator_test):
		coordinator.queue_free()
		coordinator = null
		return false
	coordinator.changed.connect(_coordinator_changed)
	coordinator.lease_expired.connect(_begin_recovery)
	coordinator.unavailable.connect(func(reason: String) -> void:
		if reason == "version_mismatch":
			_recovery_failed("Версия игры отличается от версии комнаты. Обновите игру и создайте новую комнату."))
	return true


func _release_coordinator(client) -> void:
	await client.leave()
	client.queue_free()


func _mark_started() -> void:
	if coordinator == null:
		return
	var c = coordinator
	var result: Dictionary = await c.request("start", {})
	if coordinator == c and result.get("ok", false):
		_backup_timer = 0.0


func _backup() -> void:
	if _backup_busy or coordinator == null or server == null or room == null or not is_host or _recovering:
		return
	_backup_busy = true
	var c = coordinator
	var local_server = server
	var local_room = room
	var copy: Dictionary = await local_server.http_json("POST", "/api/migration-export", {"code": local_room.code, "token": local_room.token}, 10.0)
	if c == coordinator and copy.get("ok", false) and not _recovering:
		var saved: Dictionary = await c.request("backup", {"data": copy.get("data", ""), "sha256": copy.get("sha256", ""), "codec": copy.get("codec", "json")})
		_last_backup_error = str(saved.get("reason", ""))
		if saved.get("ok", false):
			_last_backup_success = Time.get_ticks_msec()
	else:
		_last_backup_error = str(copy.get("reason", "export_failed"))
	_backup_busy = false


func _coordinator_changed(state: Dictionary) -> void:
	if coordinator == null or not joined or _recovery_terminal:
		return
	var phase := str(state.get("state", ""))
	if phase == "active" and not _recovering and (int(state.get("generation", 0)) != _active_generation or (is_host and not bool(state.get("host", false))) or str(state.get("address", "")) != _active_address):
		_begin_recovery()
	if is_host and bool(state.get("host", false)) and tunnel != null and phase == "active" and not _recovering:
		tunnel.set_authorized_hashes(state.get("ticketHashes", []))
		_renew_node_lease()
	if phase == "failed":
		_recovery_failed("Восстановить комнату не удалось. Создайте комнату заново.")
	elif phase == "migrating":
		_begin_recovery()
		if bool(state.get("candidate", false)) and not _candidate_busy:
			_become_host()
	elif phase == "active" and _recovering and not _candidate_busy and not _attach_busy:
		if bool(state.get("host", false)) and server == null and not _resign_busy:
			_resign_old_host()
		elif not bool(state.get("host", false)):
			_attach_host(str(state.get("address", "")))


func _resign_old_host() -> void:
	_resign_busy = true
	var c = coordinator
	await c.request("resign", {})
	_resign_busy = false


func _renew_node_lease() -> bool:
	if _lease_renew_busy or coordinator == null or server == null or room == null:
		return false
	_lease_renew_busy = true
	var c = coordinator
	var s = server
	if not bool(c.state.get("host", false)) or str(c.state.get("state", "")) != "active":
		_lease_renew_busy = false
		return false
	var remaining: int = c.remaining_lease_ms()
	var result: Dictionary = await s.http_json("POST", "/api/migration-lease", {"code": room.code, "token": room.token, "leaseMs": remaining}, 2.0)
	_lease_renew_busy = false
	if c != coordinator or s != server:
		return false
	if not result.get("ok", false) and joined:
		c.abandon_lease()
	return bool(result.get("ok", false))


func _begin_recovery() -> void:
	if _recovering or not joined or coordinator == null:
		return
	_recovering = true
	_recovery_deadline = Time.get_ticks_msec() + 45000
	_status_label.text = "Восстанавливаем подключение…"
	if room != null:
		room.pause_migration()
	_discard_transports()
	is_host = false


func _discard_transports() -> void:
	if tunnel != null:
		tunnel.stop()
		tunnel.queue_free()
		tunnel = null
	if link != null:
		link.stop()
		link = null
	if server != null:
		var old_state: String = server.state_dir
		var old_code: String = str(room.code) if room != null else ""
		server.stop()
		if old_state != "" and _safe_room_code(old_code):
			server._remove_tree(old_state.path_join(old_code))
		server.queue_free()
		server = null


func _safe_room_code(code: String) -> bool:
	if code.length() != 5:
		return false
	for ch in code:
		if not "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(ch):
			return false
	return true


func _become_host() -> void:
	_candidate_busy = true
	var c = coordinator
	var current := _generation
	var round: int = c.generation
	var copy: Dictionary = await c.request("restore", {})
	if current != _generation or c != coordinator:
		return
	if not copy.get("ok", false):
		_last_recovery_error = "restore: " + str(copy.get("reason", "error"))
		_candidate_busy = false
		await c.request("decline", {})
		return
	server = Supervisor.new()
	server.migration_enabled = true
	add_child(server)
	if not server.import_migration(copy) or not await server.start_server():
		_last_recovery_error = "import_or_start: " + str(server.last_error)
		if current == _generation and c == coordinator:
			if server != null:
				server.stop()
				server.queue_free()
				server = null
			_candidate_busy = false
			await c.request("decline", {})
		return
	if current != _generation or c != coordinator or c.generation != round:
		_candidate_busy = false
		return
	link = _make_link()
	if link != null:
		_watch_link(link)
	if link != null and link.has_method("set_coordinator_url"):
		link.set_coordinator_url(c.base)
	if coordinator_test and link is ToxEosLoopLink:
		link.listen_port = 0
	if link == null or not await link.start_host():
		_last_recovery_error = "transport"
		_discard_transports()
		_candidate_busy = false
		await c.request("decline", {})
		return
	tunnel = Tunnel.new()
	tunnel.failed.connect(_on_tunnel_failed)
	tunnel.require_auth = true
	tunnel.set_authorized_hashes(c.state.get("ticketHashes", []))
	add_child(tunnel)
	tunnel.start_host(link, server.port)
	tunnel.publish_meta({"code": room.code})
	var address: String = link.room_id()
	var active: Dictionary = await c.request("activate", {"address": address})
	if current != _generation or c != coordinator or not active.get("ok", false):
		_last_recovery_error = "activate: " + str(active.get("reason", "error"))
		_discard_transports()
		_candidate_busy = false
		return
	if not await _renew_node_lease() or not await room.resume_migration(server.base, true):
		_last_recovery_error = "resume"
		_discard_transports()
		_candidate_busy = false
		await c.request("resign", {})
		return
	is_host = true
	_active_address = address
	_active_generation = c.generation
	_candidate_busy = false
	_recovering = false
	room.finish_migration()
	_finish_screen_restore()
	_set_invite(c.code)
	_start_btn.visible = not room.is_started()
	if not room.is_started() and _unused_timer != null:
		_unused_timer.wait_time = PUBLIC_UNUSED_TTL
		_unused_timer.start()
	_backup_timer = 0.0
	_last_backup_success = Time.get_ticks_msec()


func _attach_host(address: String) -> void:
	if address == "":
		return
	_attach_busy = true
	_discard_transports()
	var c = coordinator
	var current := _generation
	var round: int = c.generation
	link = _make_link()
	if link != null:
		_watch_link(link)
	if link != null and link.has_method("set_coordinator_url"):
		link.set_coordinator_url(c.base)
	if link == null or not await link.start_client(address):
		_discard_transports()
		_attach_busy = false
		return
	if current != _generation or c != coordinator or c.generation != round:
		link.stop()
		_attach_busy = false
		return
	_meta = {}
	tunnel = Tunnel.new()
	tunnel.failed.connect(_on_tunnel_failed)
	tunnel.require_auth = true
	tunnel.auth_token = c.token
	add_child(tunnel)
	tunnel.meta.connect(_on_meta)
	if tunnel.start_guest(link) <= 0:
		_discard_transports()
		_attach_busy = false
		return
	var meta := await _wait_meta(12.0)
	if current != _generation or c != coordinator or c.generation != round:
		_attach_busy = false
		return
	if str(meta.get("code", "")) != room.code or not await room.resume_migration(tunnel.local_url()):
		_discard_transports()
		_attach_busy = false
		return
	_active_address = address
	_active_generation = c.generation
	_attach_busy = false
	_recovering = false
	is_host = false
	_status_label.text = "Подключение восстановлено"
	_finish_screen_restore()


func _finish_screen_restore() -> void:
	if not _restoring_from_disk:
		return
	_restoring_from_disk = false
	if room != null and room.is_started():
		visible = false
		match_ready.emit(room)
	else:
		_after_join()


func _recovery_failed(message: String) -> void:
	if _recovery_terminal:
		return
	_recovery_terminal = true
	if not _recovering:
		_begin_recovery()
	_recovering = false
	_discard_transports()
	if coordinator != null:
		coordinator.stop()
	_status_label.text = message
	if room != null:
		room.failed.emit(message)


func _session_path() -> String:
	if session_override != "":
		return session_override
	return "user://private/eos-session-%d.cfg" % ClientProfile.id()


func _save_session() -> void:
	if (coordinator_test and session_override == "") or coordinator == null or room == null or coordinator.code == "" or coordinator.token == "":
		return
	var cfg := ConfigFile.new()
	cfg.set_value("room", "coordinator", coordinator.base)
	cfg.set_value("room", "code", coordinator.code)
	cfg.set_value("room", "capability", coordinator.token)
	cfg.set_value("room", "local_code", room.code)
	cfg.set_value("room", "local_capability", room.token)
	cfg.set_value("room", "player", room.player_id)
	cfg.set_value("room", "name", _player_name())
	var private_dir := ProjectSettings.globalize_path(_session_path().get_base_dir())
	if DirAccess.make_dir_recursive_absolute(private_dir) != OK:
		return
	if OS.get_name() != "Windows":
		FileAccess.set_unix_permissions(private_dir, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER)
	var path := _session_path()
	if cfg.save(path) == OK and OS.get_name() != "Windows":
		FileAccess.set_unix_permissions(ProjectSettings.globalize_path(path), FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER)


func _clear_saved() -> void:
	if coordinator_test and session_override == "":
		return
	var path := _session_path()
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


func _resume_saved() -> void:
	if joined or _busy:
		return
	var cfg := ConfigFile.new()
	if cfg.load(_session_path()) != OK:
		return
	var url := str(cfg.get_value("room", "coordinator", ""))
	if not url.begins_with("https://") and not (coordinator_test and url.begins_with("http://127.0.0.1:")):
		return
	if not coordinator_test and _transport.is_item_disabled(0):
		_status_label.text = "Не удалось вернуться: служба EOS не настроена."
		return
	_transport.select(1 if coordinator_test else 0)
	coordinator_base = url
	if not _setup_coordinator():
		return
	coordinator.code = str(cfg.get_value("room", "code", ""))
	coordinator.token = str(cfg.get_value("room", "capability", ""))
	coordinator.version = _network_version()
	room = _make_room()
	room.code = str(cfg.get_value("room", "local_code", ""))
	room.token = str(cfg.get_value("room", "local_capability", ""))
	room.player_id = int(cfg.get_value("room", "player", 0))
	room.solo = false
	_name.text = str(cfg.get_value("room", "name", "Godot"))
	if coordinator.code == "" or coordinator.token == "" or room.code == "" or room.token == "":
		_clear_room()
		_clear_saved()
		return
	joined = true
	is_host = false
	_restoring_from_disk = true
	_begin_recovery()
	coordinator.start_heartbeats()
