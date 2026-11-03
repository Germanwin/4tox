class_name ToxLobby
extends Control

## The network lobby: host or join, wait for friends, press ready, start.
## It never decides who is connected or when the match begins — that is the
## host's ToxNet state, rendered here.

signal host_requested(config: Dictionary)
signal join_requested(config: Dictionary)
signal leave_requested
signal ready_requested(value: bool)
signal start_requested
signal back_requested

const SIZES := [64, 96, 128, 192, 256]

var _menu_page: Control
var _wait_page: Control
var _name_edit: LineEdit
var _join_name_edit: LineEdit
var _seed_edit: LineEdit
var _host_port_edit: LineEdit
var _join_addr_edit: LineEdit
var _join_port_edit: LineEdit
var _size_buttons: Dictionary = {}
var _selected_size := 64
var _menu_status: Label
var _wait_status: Label
var _lobby_title: Label
var _lobby_role: Label
var _lobby_info: Label
var _lobby_address: Label
var _players_box: VBoxContainer
var _hint: Label
var _ready_btn: Button
var _start_btn: Button
var _is_host := false
var _local_owner := 0
var _ready_state := false

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	theme = ToxUI.theme()
	var veil := ColorRect.new()
	veil.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	veil.color = Color(0.025, 0.09, 0.16, 0.62)
	veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(veil)
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 26)
	margin.add_theme_constant_override("margin_right", 26)
	margin.add_theme_constant_override("margin_top", 22)
	margin.add_theme_constant_override("margin_bottom", 22)
	add_child(margin)
	var center := CenterContainer.new()
	margin.add_child(center)
	var board := ToxUI.panel(18, ToxUI.WOOD_LITE)
	board.custom_minimum_size = Vector2(820, 0)
	center.add_child(board)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	board.add_child(box)
	var title := ToxUI.label("СЕТЬ", 46, ToxUI.CREAM, 10)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(title)
	var sub := ToxUI.ink_label("один остров · до четырёх деревень · мир считает хозяин", 14)
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	sub.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	box.add_child(sub)
	box.add_child(ToxUI.hsep(4))
	_menu_page = VBoxContainer.new()
	_menu_page.add_theme_constant_override("separation", 10)
	box.add_child(_menu_page)
	_build_menu_page()
	_wait_page = VBoxContainer.new()
	_wait_page.add_theme_constant_override("separation", 8)
	_wait_page.visible = false
	box.add_child(_wait_page)
	_build_wait_page()
	visible = false

func _build_menu_page() -> void:
	var columns := HBoxContainer.new()
	columns.add_theme_constant_override("separation", 12)
	_menu_page.add_child(columns)
	var host_col := ToxUI.panel(14, ToxUI.WOOD)
	host_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	columns.add_child(host_col)
	var hv := VBoxContainer.new()
	hv.add_theme_constant_override("separation", 7)
	host_col.add_child(hv)
	hv.add_child(ToxUI.ink_label("Создать игру", 20))
	hv.add_child(ToxUI.ink_label("имя хозяина", 12))
	_name_edit = LineEdit.new()
	_name_edit.text = "Хозяин"
	_name_edit.custom_minimum_size = Vector2(0, 38)
	hv.add_child(_name_edit)
	var size_caption := ToxUI.ink_label("остров", 12)
	size_caption.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	hv.add_child(size_caption)
	var size_row := HBoxContainer.new()
	size_row.add_theme_constant_override("separation", 5)
	hv.add_child(size_row)
	var group := ButtonGroup.new()
	for s in SIZES:
		var b := ToxUI.button("%d" % s, 13)
		b.toggle_mode = true
		b.button_group = group
		b.custom_minimum_size = Vector2(0, 34)
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.pressed.connect(func() -> void: _select_size(s))
		b.add_theme_stylebox_override("pressed", _green_box())
		b.add_theme_stylebox_override("hover_pressed", _green_box())
		size_row.add_child(b)
		_size_buttons[s] = b
	_size_buttons[_selected_size].button_pressed = true
	hv.add_child(ToxUI.ink_label("сид", 12))
	_seed_edit = LineEdit.new()
	_seed_edit.text = "тихая-долина-701"
	_seed_edit.custom_minimum_size = Vector2(0, 38)
	hv.add_child(_seed_edit)
	var port_row := HBoxContainer.new()
	port_row.add_theme_constant_override("separation", 8)
	hv.add_child(port_row)
	var port_cap := ToxUI.ink_label("порт", 12)
	port_cap.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	port_row.add_child(port_cap)
	_host_port_edit = LineEdit.new()
	_host_port_edit.text = "7777"
	_host_port_edit.custom_minimum_size = Vector2(96, 36)
	port_row.add_child(_host_port_edit)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	port_row.add_child(spacer)
	var create_btn := ToxUI.button("Создать игру", 18)
	create_btn.custom_minimum_size = Vector2(0, 48)
	hv.add_child(create_btn)
	create_btn.pressed.connect(_on_host)
	_name_edit.text_submitted.connect(func(_t: String) -> void: _on_host())
	var note := ToxUI.ink_label("Друзья подключаются по адресу из лобби. Для игры через\nинтернет открой UDP-порт на роутере.", 11)
	note.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	hv.add_child(note)

	var join_col := ToxUI.panel(14, ToxUI.WOOD)
	join_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	columns.add_child(join_col)
	var jv := VBoxContainer.new()
	jv.add_theme_constant_override("separation", 7)
	join_col.add_child(jv)
	jv.add_child(ToxUI.ink_label("Присоединиться", 20))
	jv.add_child(ToxUI.ink_label("твоё имя", 12))
	_join_name_edit = LineEdit.new()
	_join_name_edit.text = "Игрок"
	_join_name_edit.custom_minimum_size = Vector2(0, 38)
	jv.add_child(_join_name_edit)
	jv.add_child(ToxUI.ink_label("адрес хозяина", 12))
	_join_addr_edit = LineEdit.new()
	_join_addr_edit.text = "127.0.0.1"
	_join_addr_edit.custom_minimum_size = Vector2(0, 38)
	jv.add_child(_join_addr_edit)
	var jport_row := HBoxContainer.new()
	jport_row.add_theme_constant_override("separation", 8)
	jv.add_child(jport_row)
	var jport_cap := ToxUI.ink_label("порт", 12)
	jport_cap.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	jport_row.add_child(jport_cap)
	_join_port_edit = LineEdit.new()
	_join_port_edit.text = "7777"
	_join_port_edit.custom_minimum_size = Vector2(96, 36)
	jport_row.add_child(_join_port_edit)
	jv.add_child(ToxUI.hsep(18))
	var join_btn := ToxUI.button("Войти", 18)
	join_btn.custom_minimum_size = Vector2(0, 48)
	jv.add_child(join_btn)
	join_btn.pressed.connect(_on_join)
	_join_addr_edit.text_submitted.connect(func(_t: String) -> void: _on_join())
	var jnote := ToxUI.ink_label("Нужна та же версия игры. Хозяин запускает матч\nкнопкой «Начать игру», когда все готовы.", 11)
	jnote.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	jnote.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	jv.add_child(jnote)

	_menu_status = ToxUI.label("", 13, ToxUI.CREAM, 2)
	_menu_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_menu_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_menu_page.add_child(_menu_status)
	var back := ToxUI.button("Назад", 16)
	back.custom_minimum_size = Vector2(0, 44)
	back.pressed.connect(func() -> void: emit_signal("back_requested"))
	_menu_page.add_child(back)

func _build_wait_page() -> void:
	_lobby_title = ToxUI.label("Лобби", 36, ToxUI.CREAM, 8)
	_lobby_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_wait_page.add_child(_lobby_title)
	_lobby_role = ToxUI.ink_label("", 14)
	_lobby_role.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_lobby_role.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	_wait_page.add_child(_lobby_role)
	_lobby_info = ToxUI.ink_label("", 13)
	_lobby_info.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_lobby_info.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	_wait_page.add_child(_lobby_info)
	_lobby_address = ToxUI.label("", 14, ToxUI.CREAM, 2)
	_lobby_address.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_lobby_address.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_wait_page.add_child(_lobby_address)
	var players_panel := ToxUI.panel(10, ToxUI.WOOD)
	players_panel.custom_minimum_size = Vector2(0, 174)
	_wait_page.add_child(players_panel)
	_players_box = VBoxContainer.new()
	_players_box.add_theme_constant_override("separation", 6)
	players_panel.add_child(_players_box)
	_hint = ToxUI.ink_label("", 12)
	_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_hint.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	_wait_page.add_child(_hint)
	_wait_status = ToxUI.label("", 13, ToxUI.CREAM, 2)
	_wait_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_wait_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_wait_page.add_child(_wait_status)
	var buttons := HBoxContainer.new()
	buttons.add_theme_constant_override("separation", 8)
	_wait_page.add_child(buttons)
	_ready_btn = ToxUI.button("Готов", 18)
	_ready_btn.custom_minimum_size = Vector2(0, 50)
	_ready_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_ready_btn.pressed.connect(_on_ready)
	buttons.add_child(_ready_btn)
	_start_btn = ToxUI.button("Начать игру", 18)
	_start_btn.custom_minimum_size = Vector2(0, 50)
	_start_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_start_btn.pressed.connect(func() -> void: emit_signal("start_requested"))
	buttons.add_child(_start_btn)
	var leave_btn := ToxUI.button("Выйти", 16)
	leave_btn.custom_minimum_size = Vector2(130, 50)
	leave_btn.pressed.connect(func() -> void: emit_signal("leave_requested"))
	buttons.add_child(leave_btn)

func _green_box() -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = Color("#63b348")
	s.border_color = Color("#2f6420")
	s.set_border_width_all(3)
	s.set_corner_radius_all(8)
	s.content_margin_left = 6
	s.content_margin_right = 6
	s.content_margin_top = 5
	s.content_margin_bottom = 5
	s.shadow_color = Color(0.05, 0.1, 0.03, 0.35)
	s.shadow_size = 3
	s.shadow_offset = Vector2(0, 2)
	return s

func open(size: int, seed_text: String) -> void:
	_selected_size = size if SIZES.has(size) else 64
	if _size_buttons.has(_selected_size):
		_size_buttons[_selected_size].button_pressed = true
	if _seed_edit != null:
		_seed_edit.text = seed_text
	if _name_edit != null and _name_edit.text.strip_edges().is_empty():
		_name_edit.text = "Хозяин"
	if _join_name_edit != null and _join_name_edit.text.strip_edges().is_empty():
		_join_name_edit.text = "Игрок"
	_menu_status.text = ""
	_wait_status.text = ""
	_hint.text = ""
	show_menu_page()
	visible = true

func show_menu_page() -> void:
	_menu_page.visible = true
	_wait_page.visible = false

func show_wait_page() -> void:
	_menu_page.visible = false
	_wait_page.visible = true

func set_status(text: String, is_error: bool = false) -> void:
	var col := Color("#ffb0a3") if is_error else ToxUI.CREAM
	_menu_status.add_theme_color_override("font_color", col)
	_wait_status.add_theme_color_override("font_color", col)
	if _menu_page.visible:
		_menu_status.text = text
	if _wait_page.visible:
		_wait_status.text = text

func set_address(text: String) -> void:
	if _lobby_address != null:
		_lobby_address.text = text

func render(state: Dictionary, is_host: bool, local_owner: int, local_name: String) -> void:
	_is_host = is_host
	_local_owner = local_owner
	var players: Array = state.get("players", [])
	var guests := 0
	var all_ready := true
	var me: Dictionary = {}
	for p in players:
		var owner := int(p.get("owner", 0))
		if owner != 0:
			guests += 1
			if not bool(p.get("ready", false)):
				all_ready = false
		if owner == local_owner:
			me = p
	_ready_state = bool(me.get("ready", false))
	_lobby_title.text = "Лобби"
	_lobby_role.text = ("ты хозяин · %s" % local_name) if is_host else ("ты гость · %s" % local_name)
	_lobby_info.text = "Остров %d × %d · сид %s" % [int(state.get("size", 64)), int(state.get("size", 64)), str(state.get("seed", ""))]
	if is_host:
		var port := int(state.get("port", 7777))
		if port <= 0:
			port = 7777
		set_address("Друзья подключаются: %s" % lan_addresses(port))
	else:
		set_address("Подключено к хозяину")
	ToxUI.clear(_players_box)
	for p in players:
		_players_box.add_child(_player_row(p))
	if is_host:
		_ready_btn.visible = false
		_start_btn.visible = true
		_start_btn.disabled = guests == 0 or not all_ready
		if guests == 0:
			_hint.text = "Позови друга: он вводит адрес из строки выше."
		elif not all_ready:
			_hint.text = "Ждём, пока все нажмут «Готов»."
		else:
			_hint.text = "Все готовы — можно начинать."
	else:
		_ready_btn.visible = true
		_start_btn.visible = false
		_ready_btn.text = "Не готов" if _ready_state else "Готов"
		_hint.text = "Хозяин начнёт игру, когда все будут готовы." if _ready_state else "Нажми «Готов», когда будешь ждать старт."

func _player_row(p: Dictionary) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var swatch := ColorRect.new()
	swatch.color = Color(str(p.get("color", "#4a90d9")))
	swatch.custom_minimum_size = Vector2(16, 16)
	row.add_child(swatch)
	var nm := ToxUI.ink_label(str(p.get("name", "Игрок")), 16)
	nm.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(nm)
	var owner := int(p.get("owner", 0))
	var tag := "хозяин" if owner == 0 else ("готов" if bool(p.get("ready", false)) else "не готов")
	var st := ToxUI.ink_label(tag, 13)
	st.add_theme_color_override("font_color", ToxUI.GRASS_DARK if tag == "готов" else ToxUI.INK_SOFT)
	row.add_child(st)
	return row

func _select_size(s: int) -> void:
	_selected_size = s
	for k in _size_buttons.keys():
		_size_buttons[k].button_pressed = int(k) == s

func _on_host() -> void:
	var port := int(_host_port_edit.text.strip_edges())
	if port < 1024 or port > 65535:
		set_status("Порт должен быть от 1024 до 65535", true)
		return
	var seed_text := _seed_edit.text.strip_edges()
	if seed_text.is_empty():
		seed_text = "тихая-долина-701"
		_seed_edit.text = seed_text
	emit_signal("host_requested", {
		"name": _name_edit.text.strip_edges(),
		"port": port, "seed": seed_text, "size": _selected_size
	})

func _on_join() -> void:
	var addr := _join_addr_edit.text.strip_edges()
	if addr.is_empty():
		set_status("Укажи адрес хозяина", true)
		return
	var port := int(_join_port_edit.text.strip_edges())
	if port < 1024 or port > 65535:
		set_status("Порт должен быть от 1024 до 65535", true)
		return
	emit_signal("join_requested", {
		"name": _join_name_edit.text.strip_edges(),
		"address": addr, "port": port
	})

func _on_ready() -> void:
	_ready_state = not _ready_state
	_ready_btn.text = "Не готов" if _ready_state else "Готов"
	emit_signal("ready_requested", _ready_state)

func _input(event: InputEvent) -> void:
	if not visible:
		return
	if event is InputEventKey and event.pressed and not event.echo:
		if event.physical_keycode == KEY_ESCAPE:
			if _wait_page.visible:
				emit_signal("leave_requested")
			else:
				emit_signal("back_requested")
			get_viewport().set_input_as_handled()

static func lan_addresses(port: int) -> String:
	var out := []
	for a in IP.get_local_addresses():
		var s := str(a)
		if s.contains(":"):
			continue
		if s.begins_with("127.") or s.begins_with("169.254.") or s.begins_with("0."):
			continue
		out.append("%s:%d" % [s, port])
	if out.is_empty():
		out.append("127.0.0.1:%d" % port)
	return ", ".join(out)
