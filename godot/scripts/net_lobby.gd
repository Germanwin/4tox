class_name ToxNetLobby
extends Control

## Экран сети на HTTP/WS того же сервера, что у браузера. Никакого ENet:
## «Создать игру» → POST /api/lobby, «Войти по коду» → POST /api/join,
## «Готов» → /api/ready, «Начать игру» → /api/start. Дальше комната сама
## поднимает WLD1 и кадры 4TX1 (ToxLiveRoom), а экран отдаёт её матчу.
##
## Правил игры здесь нет: состав, «можно ли начинать» и старт проверяет
## сервер (`block` в /api/status), экран только показывает ответ.

signal match_ready(room)
signal back

const UI = preload("res://scripts/ui_theme.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var room = null
var base := "http://127.0.0.1:8787"
var seed_text := ""
var world_size := 64
var joined := false
var is_host := false
var is_ready := false
var status_text := ""
var last_block: Dictionary = {}

var _name: LineEdit
var _addr: LineEdit
var _code: LineEdit
var _status_label: Label
var _players_box: VBoxContainer
var _hint: Label
var _create_btn: Button
var _join_btn: Button
var _ready_btn: Button
var _start_btn: Button
var _resume_btn: Button
var _spectate_btn: Button
var _back_btn: Button


func _ready() -> void:
	# Top-level Control в CanvasLayer: только anchors мало, нужны и offsets,
	# иначе корень остаётся 0×0 и CenterContainer ставит панель в угол.
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	theme = UI.theme()
	visible = false
	_build()


func _build() -> void:
	var dim := ColorRect.new()
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.color = Color(0.02, 0.08, 0.14, 0.55)
	dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(center)
	var panel := UI.panel(22)
	panel.custom_minimum_size = Vector2(760, 0)
	center.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	panel.add_child(box)
	var title := UI.label("Сеть", 34, UI.CREAM, 8)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(title)
	var note := UI.ink_label("тот же сервер, что у браузера · код и токен, без ENet", 13)
	note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	note.add_theme_color_override("font_color", UI.INK_SOFT)
	box.add_child(note)

	var addr_row := HBoxContainer.new()
	addr_row.add_theme_constant_override("separation", 8)
	box.add_child(addr_row)
	addr_row.add_child(UI.ink_label("сервер", 14))
	_addr = LineEdit.new()
	_addr.text = base
	_addr.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_addr.custom_minimum_size = Vector2(420, 38)
	addr_row.add_child(_addr)
	addr_row.add_child(UI.ink_label("origin без /game/", 12))

	var name_row := HBoxContainer.new()
	name_row.add_theme_constant_override("separation", 8)
	box.add_child(name_row)
	name_row.add_child(UI.ink_label("имя", 14))
	_name = LineEdit.new()
	_name.text = "Godot"
	_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_name.custom_minimum_size = Vector2(260, 38)
	name_row.add_child(_name)
	name_row.add_child(UI.ink_label("код", 14))
	_code = LineEdit.new()
	_code.placeholder_text = "например 4KQ2P"
	_code.custom_minimum_size = Vector2(160, 38)
	name_row.add_child(_code)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	box.add_child(row)
	_create_btn = UI.button("Создать игру", 16)
	_create_btn.custom_minimum_size = Vector2(220, 46)
	_create_btn.pressed.connect(func() -> void: create_game())
	row.add_child(_create_btn)
	_join_btn = UI.button("Войти по коду", 16)
	_join_btn.custom_minimum_size = Vector2(220, 46)
	_join_btn.pressed.connect(func() -> void: join_game())
	row.add_child(_join_btn)
	_spectate_btn = UI.button("Смотреть", 16)
	_spectate_btn.pressed.connect(func() -> void: spectate_game())
	box.add_child(_spectate_btn)
	_resume_btn = UI.button("Продолжить", 16)
	_resume_btn.custom_minimum_size = Vector2(180, 46)
	_resume_btn.visible = false
	_resume_btn.pressed.connect(func() -> void: resume_game())
	row.add_child(_resume_btn)
	_back_btn = UI.button("Назад", 15)
	_back_btn.custom_minimum_size = Vector2(140, 46)
	_back_btn.pressed.connect(func() -> void: leave_lobby())
	row.add_child(_back_btn)

	_status_label = UI.ink_label("", 14)
	_status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_status_label)
	var code_line := UI.ink_label("", 22)
	code_line.name = "CodeLine"
	code_line.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(code_line)

	box.add_child(UI.hsep(4))
	box.add_child(UI.ink_label("состав", 14))
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(700, 150)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	box.add_child(scroll)
	_players_box = VBoxContainer.new()
	_players_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_players_box.add_theme_constant_override("separation", 3)
	scroll.add_child(_players_box)

	var actions := HBoxContainer.new()
	actions.add_theme_constant_override("separation", 10)
	box.add_child(actions)
	_ready_btn = UI.button("Готов", 17)
	_ready_btn.custom_minimum_size = Vector2(200, 50)
	_ready_btn.disabled = true
	_ready_btn.pressed.connect(func() -> void: toggle_ready())
	actions.add_child(_ready_btn)
	_start_btn = UI.button("Начать игру", 17)
	_start_btn.custom_minimum_size = Vector2(240, 50)
	_start_btn.visible = false
	_start_btn.pressed.connect(func() -> void: start_game())
	actions.add_child(_start_btn)
	_hint = UI.ink_label("", 12)
	_hint.add_theme_color_override("font_color", UI.INK_SOFT)
	box.add_child(_hint)


# ------------------------------------------------------------------- экран

func open(p_base: String, p_seed: String, p_size: int) -> void:
	base = _norm_base(p_base)
	seed_text = p_seed
	world_size = p_size
	visible = true
	joined = false
	is_host = false
	is_ready = false
	status_text = ""
	last_block = {}
	_addr.text = base
	_code.text = ""
	if _resume_btn != null:
		_resume_btn.visible = LiveRoom.session_exists()
		_resume_btn.disabled = false
	_players_box_clear()
	_set_code_line("")
	_status_label.text = "создайте игру или введите код"
	_ready_btn.disabled = true
	_ready_btn.text = "Готов"
	_start_btn.visible = false


func _norm_base(text: String) -> String:
	var b := text.strip_edges().rstrip("/")
	# База — origin: https://host:8443, а не https://host/game/.
	if b.ends_with("/game"):
		b = b.substr(0, b.length() - 5)
	return b


func _set_code_line(text: String) -> void:
	var node := find_child("CodeLine", true, false)
	if node is Label:
		(node as Label).text = text


func _players_box_clear() -> void:
	for c in _players_box.get_children():
		_players_box.remove_child(c)
		c.queue_free()


func _ensure_room() -> bool:
	if room != null:
		return true
	base = _norm_base(_addr.text)
	if base == "":
		_status_label.text = "укажите адрес сервера"
		return false
	room = LiveRoom.new()
	room.name = "LiveRoom"
	add_child(room)
	room.lobby_update.connect(_on_lobby_update)
	room.room_started.connect(_on_room_started)
	room.failed.connect(_on_failed)
	room.status.connect(_on_status)
	return true


func create_game() -> void:
	if joined:
		return
	if not _ensure_room():
		return
	var nm := _name.text.strip_edges()
	if nm == "":
		nm = "Godot"
	_status_label.text = "создаём лобби…"
	_create_btn.disabled = true
	_join_btn.disabled = true
	var ok: bool = await room.create_lobby(base, nm, seed_text, world_size, 2)
	_create_btn.disabled = false
	_join_btn.disabled = false
	if not ok:
		_status_label.text = "локальный сервер не ответил: проверьте адрес"
		return
	joined = true
	is_host = room.is_host
	is_ready = false
	_ready_btn.disabled = false
	_start_btn.visible = is_host
	_code.text = room.code
	_set_code_line("код: " + room.code)
	_status_label.text = "лобби создано · дайте другу код и нажмите «Готов»"
	_render_players(room.lobby_players)


func join_game() -> void:
	if joined:
		return
	var c := _code.text.strip_edges().to_upper()
	if c == "":
		_status_label.text = "введите код лобби"
		return
	if not _ensure_room():
		return
	var nm := _name.text.strip_edges()
	if nm == "":
		nm = "Godot"
	_status_label.text = "входим в " + c + "…"
	_create_btn.disabled = true
	_join_btn.disabled = true
	var ok: bool = await room.join_lobby(base, c, nm)
	_create_btn.disabled = false
	_join_btn.disabled = false
	if not ok:
		_status_label.text = "войти не удалось: проверьте код и адрес"
		return
	joined = true
	is_host = room.is_host
	is_ready = false
	_ready_btn.disabled = false
	_start_btn.visible = is_host
	_code.text = room.code
	_set_code_line("код: " + room.code)
	_status_label.text = "вы в лобби · нажмите «Готов»"
	_render_players(room.lobby_players)


func toggle_ready() -> void:
	if room == null or not joined:
		return
	is_ready = not is_ready
	_ready_btn.text = "Отменить готовность" if is_ready else "Готов"
	await room.set_ready(is_ready)


## Вернуться в сохранённую партию (после перезапуска/падения): тот же токен и
## игрок, `/api/resume` отдаёт мир и снимок комнаты.
func spectate_game() -> void:
	var c := _code.text.strip_edges().to_upper()
	if c == "":
		status_text = "введите код комнаты"
		return
	if room == null:
		room = LiveRoom.new()
		room.name = "LiveRoom"
		add_child(room)
		room.lobby_update.connect(_on_lobby_update)
		room.room_started.connect(_on_room_started)
		room.failed.connect(_on_failed)
		room.status.connect(_on_status)
	if room.is_started():
		room.leave()
	status_text = "входим наблюдателем…"
	var ok: bool = await room.spectate(base, c, _name.text.strip_edges())
	if not ok:
		status_text = "не удалось: " + room.last_error
		return
	joined = true
	match_ready.emit(room)


func resume_game() -> void:
	if joined:
		return
	if not LiveRoom.session_exists():
		_status_label.text = "сохранённой партии нет"
		_resume_btn.visible = false
		return
	if not _ensure_room():
		return
	var info := LiveRoom.session_info()
	if str(info.get("base", "")) != "":
		base = str(info["base"])
		_addr.text = base
	_status_label.text = "возвращаемся в партию…"
	_resume_btn.disabled = true
	var ok: bool = await room.resume(base)
	_resume_btn.disabled = false
	if not ok:
		_status_label.text = "вернуться не удалось: комната уже закрыта"
		_resume_btn.visible = false
		return
	joined = true
	is_host = room.is_host
	is_ready = true
	_code.text = room.code
	_set_code_line("код: " + room.code)
	_create_btn.disabled = true
	_join_btn.disabled = true
	_ready_btn.disabled = false
	_resume_btn.visible = false
	if room.is_started():
		# room_started уже ушёл в _after_start; экран просто уходит.
		visible = false
		return
	_status_label.text = "партия ещё в лобби · ждём старта хоста"
	_render_players(room.lobby_players)


func start_game() -> void:
	if room == null or not is_host:
		return
	status_text = "стартуем…"
	_status_label.text = status_text
	var ok: bool = await room.start_now()
	if not ok:
		_status_label.text = "старт не удался: " + str(last_block.get("reason", "сервер отказал"))
		return


func leave_lobby() -> void:
	if room != null:
		room.leave()
		room.queue_free()
		room = null
	joined = false
	is_host = false
	is_ready = false
	visible = false
	back.emit()


## Матч закончился/игрок вышел в меню: комнату закрываем совсем.
func close_room() -> void:
	if room != null:
		room.leave()
		room.queue_free()
		room = null
	joined = false
	visible = false


# ------------------------------------------------------------------ ответы

func _on_lobby_update(players: Array, started: bool, block: Dictionary) -> void:
	last_block = block
	_render_players(players)
	var all_ready := players.size() >= 2
	for p in players:
		if not bool(p.get("ready", false)):
			all_ready = false
	_ready_btn.disabled = false
	if is_host:
		_start_btn.visible = true
		_start_btn.disabled = not all_ready or started
		if not all_ready:
			var why := str(block.get("reason", "")) if not block.is_empty() else ""
			_hint.text = why if why != "" else "нужно двое и «Готов» у обоих"
		else:
			_hint.text = "можно начинать"
	else:
		_start_btn.visible = false
		_hint.text = "ждём, когда хост начнёт игру"
	if started:
		status_text = "партия началась"


func _on_room_started() -> void:
	status_text = "мир поднимается…"
	_status_label.text = status_text
	visible = false
	match_ready.emit(room)


func _on_status(text: String) -> void:
	_status_label.text = text


func _on_failed(text: String) -> void:
	status_text = text
	_status_label.text = text


func _render_players(players: Array) -> void:
	_players_box_clear()
	for p in players:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)
		_players_box.add_child(row)
		var host_mark := " · хост" if bool(p.get("host", false)) else ""
		var ready_mark := "готов" if bool(p.get("ready", false)) else "не готов"
		var label := UI.ink_label("игрок %d · %s%s · %s" % [
			int(p.get("id", 0)) + 1, str(p.get("name", "?")), host_mark, ready_mark], 14)
		label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(label)
		var dot := ColorRect.new()
		dot.custom_minimum_size = Vector2(14, 14)
		var hex := str(p.get("color", "#4a90d9")).replace("#", "")
		dot.color = Color8(("0x" + hex.substr(0, 2)).hex_to_int(),
			("0x" + hex.substr(2, 2)).hex_to_int(),
			("0x" + hex.substr(4, 2)).hex_to_int())
		row.add_child(dot)


# ------------------------------------------------------------------- тесты

func state() -> Dictionary:
	return {
		"joined": joined,
		"host": is_host,
		"ready": is_ready,
		"code": _code.text,
		"status": _status_label.text,
		"players": _players_box.get_child_count(),
		"start_visible": _start_btn.visible,
		"resume_visible": _resume_btn.visible,
		"spectate_visible": _spectate_btn.visible,
		"start_disabled": _start_btn.disabled,
		"ready_disabled": _ready_btn.disabled,
		"base": base,
	}


func press(text: String) -> bool:
	var map := {
		"Создать игру": _create_btn, "Войти по коду": _join_btn,
		"Продолжить": _resume_btn, "Готов": _ready_btn,
		"Начать игру": _start_btn, "Смотреть": _spectate_btn,
		"Назад": _back_btn,
	}
	var b: Variant = map.get(text)
	if b == null:
		return false
	(b as Button).pressed.emit()
	return true


func set_code(text: String) -> void:
	_code.text = text


func set_player_name(text: String) -> void:
	_name.text = text


func set_address(text: String) -> void:
	_addr.text = text
