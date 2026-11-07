class_name ToxMenu
extends Control

signal play_pressed(size: int, seed_text: String, mode: String)
signal continue_pressed
signal models_pressed
signal hybrid_pressed
signal live_pressed
signal new_island_pressed
signal main_menu_pressed
signal size_changed(size: int, seed_text: String)

const SIZES := [64, 96, 128, 192, 256]
const SEEDS := {
	64: "тихая-долина-701", 96: "зелёная-пойма-202", 128: "каменная-грива-303",
	192: "вольная-согра-404", 256: "дальний-плёс-606"
}

var selected_size: int = 64
var selected_mode: String = "solo"
var seed_text: String = "тихая-долина-701"
var has_game := false

var _main_page: Control
var _pause_page: Control
var _seed_edit: LineEdit
var _play_btn: Button
var _continue_btn: Button
var _pause_continue: Button
var _pause_new_btn: Button
var _stat_labels: Dictionary = {}
var _cards: Dictionary = {}
var _mode_buttons: Dictionary = {}
var _size_grid: GridContainer
var _title: Label
var _subtitle: Label
var _veil: ColorRect
var _board: PanelContainer
var _sign_wrap: Control
var _right_hint: Label
var _dev_row: HBoxContainer
var _dev_btn: Button

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	theme = ToxUI.theme()
	_build_veil()
	_build_board()
	_show_main(true)
	_show_pause(false)
	modulate.a = 0.0
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", 1.0, 0.35)

func _build_veil() -> void:
	_veil = ColorRect.new()
	_veil.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_veil.color = Color(0.025, 0.09, 0.16, 0.52)
	_veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_veil)
	# Виньетка из процедурной текстуры: один квад, кадр не нагружает.
	var vig := TextureRect.new()
	vig.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	vig.texture = ToxUI.vignette_texture()
	vig.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	vig.stretch_mode = TextureRect.STRETCH_SCALE
	vig.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	vig.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(vig)

func _build_board() -> void:
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 28)
	margin.add_theme_constant_override("margin_right", 28)
	margin.add_theme_constant_override("margin_top", 24)
	margin.add_theme_constant_override("margin_bottom", 24)
	add_child(margin)
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.add_theme_constant_override("separation", 32)
	margin.add_child(row)
	var left := VBoxContainer.new()
	left.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	left.custom_minimum_size = Vector2(650, 0)
	left.add_theme_constant_override("separation", 14)
	row.add_child(left)
	_sign_wrap = Control.new()
	_sign_wrap.custom_minimum_size = Vector2(0, 196)
	_sign_wrap.clip_contents = true
	left.add_child(_sign_wrap)
	var sign_wrap := _sign_wrap
	var glow := TextureRect.new()
	glow.texture = ToxUI.glow_texture()
	glow.position = Vector2(-10, -36)
	glow.size = Vector2(580, 250)
	glow.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	glow.stretch_mode = TextureRect.STRETCH_SCALE
	glow.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	glow.mouse_filter = Control.MOUSE_FILTER_IGNORE
	glow.modulate = Color(1, 0.9, 0.72, 0.30)
	sign_wrap.add_child(glow)
	var glow_tw := glow.create_tween().set_loops()
	glow_tw.tween_property(glow, "modulate:a", 0.48, 2.6) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	glow_tw.tween_property(glow, "modulate:a", 0.26, 2.6) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	var sign_panel := PanelContainer.new()
	sign_panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	sign_panel.custom_minimum_size = Vector2(500, 124)
	sign_panel.position = Vector2(70, 14)
	sign_panel.rotation = deg_to_rad(-1.1)
	sign_wrap.add_child(sign_panel)
	var sign_box := VBoxContainer.new()
	sign_box.alignment = BoxContainer.ALIGNMENT_CENTER
	sign_panel.add_child(sign_box)
	_title = ToxUI.label("4TOX", 64, ToxUI.CREAM, 12)
	_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	sign_box.add_child(_title)
	_subtitle = ToxUI.label("остров · деревня · лесорубы", 15, ToxUI.INK)
	_subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	sign_box.add_child(_subtitle)

	_board = ToxUI.panel(18, ToxUI.WOOD_LITE)
	left.add_child(_board)
	var board_box := VBoxContainer.new()
	board_box.add_theme_constant_override("separation", 12)
	_board.add_child(board_box)

	_main_page = VBoxContainer.new()
	_main_page.add_theme_constant_override("separation", 12)
	board_box.add_child(_main_page)
	var size_caption := ToxUI.ink_label("Выбери остров", 15)
	size_caption.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	_main_page.add_child(size_caption)
	_size_grid = GridContainer.new()
	_size_grid.columns = 5
	_size_grid.add_theme_constant_override("h_separation", 8)
	_size_grid.add_theme_constant_override("v_separation", 8)
	_main_page.add_child(_size_grid)
	var group := ButtonGroup.new()
	for s in SIZES:
		var card := ToxUI.button("%d\nклеток" % s, 15)
		card.custom_minimum_size = Vector2(112, 64)
		card.toggle_mode = true
		card.button_group = group
		card.pressed.connect(func() -> void: _select_size(s))
		var pressed_set := ToxUI.button_set("primary")
		card.add_theme_stylebox_override("pressed", pressed_set["pressed"])
		card.add_theme_stylebox_override("hover_pressed", pressed_set["hover"])
		card.add_theme_color_override("font_pressed_color", ToxUI.CREAM)
		card.add_theme_color_override("font_hover_pressed_color", ToxUI.CREAM)
		_size_grid.add_child(card)
		_cards[s] = card
	_cards[selected_size].button_pressed = true

	var seed_row := HBoxContainer.new()
	seed_row.add_theme_constant_override("separation", 8)
	_main_page.add_child(seed_row)
	seed_row.add_child(ToxUI.ink_label("Сид", 15))
	_seed_edit = LineEdit.new()
	_seed_edit.text = seed_text
	_seed_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_seed_edit.custom_minimum_size = Vector2(280, 40)
	seed_row.add_child(_seed_edit)
	var dice := ToxUI.button("🎲", 18)
	dice.custom_minimum_size = Vector2(46, 40)
	dice.tooltip_text = "Случайный сид"
	dice.pressed.connect(func() -> void:
		var r := ToxRNG.random_seed()
		_seed_edit.text = r
		seed_text = r
		_select_size(selected_size))
	seed_row.add_child(dice)

	var mode_caption := ToxUI.ink_label("Режим", 15)
	mode_caption.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	_main_page.add_child(mode_caption)
	var mode_row := HBoxContainer.new()
	mode_row.add_theme_constant_override("separation", 8)
	_main_page.add_child(mode_row)
	var mgroup := ButtonGroup.new()
	var mode_names := {"solo": "Один", "bot": "Против деревни", "net": "Сеть",
		"eos": "EOS"}
	for m in ["solo", "bot", "net", "eos"]:
		var b := ToxUI.button(str(mode_names[m]), 15)
		b.toggle_mode = true
		b.button_group = mgroup
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.custom_minimum_size = Vector2(0, 42)
		b.button_pressed = (m == selected_mode)
		b.pressed.connect(func() -> void: _select_mode(m))
		var pressed_set := ToxUI.button_set("primary")
		b.add_theme_stylebox_override("pressed", pressed_set["pressed"])
		b.add_theme_stylebox_override("hover_pressed", pressed_set["hover"])
		b.add_theme_color_override("font_pressed_color", ToxUI.CREAM)
		b.add_theme_color_override("font_hover_pressed_color", ToxUI.CREAM)
		mode_row.add_child(b)
		_mode_buttons[m] = b
	if _mode_buttons.has("net"):
		_mode_buttons["net"].tooltip_text = "Хозяин создаёт лобби, друзья подключаются по адресу"
	if _mode_buttons.has("eos"):
		_mode_buttons["eos"].tooltip_text = "Отдельный режим: сервер у хозяина, гость через EOS P2P или петлю"

	var play_row := HBoxContainer.new()
	play_row.add_theme_constant_override("separation", 10)
	_main_page.add_child(play_row)
	_play_btn = ToxUI.button("Играть", 22, "primary")
	_play_btn.custom_minimum_size = Vector2(0, 58)
	_play_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_play_btn.pressed.connect(_on_play)
	play_row.add_child(_play_btn)
	_continue_btn = ToxUI.button("Продолжить", 16)
	_continue_btn.custom_minimum_size = Vector2(150, 58)
	_continue_btn.visible = false
	_continue_btn.pressed.connect(func() -> void: emit_signal("continue_pressed"))
	play_row.add_child(_continue_btn)

	# Отладочные входы не мозолят глаза в главном меню: они прячутся за
	# маленькой шестерёнкой. Для приёмок они по-прежнему на месте в дереве.
	_dev_row = HBoxContainer.new()
	_dev_row.add_theme_constant_override("separation", 8)
	_dev_row.visible = false
	_main_page.add_child(_dev_row)
	var hybrid := ToxUI.button("Новый рендер", 14, "ghost")
	hybrid.custom_minimum_size = Vector2(160, 36)
	hybrid.pressed.connect(func() -> void: emit_signal("hybrid_pressed"))
	_dev_row.add_child(hybrid)
	var live := ToxUI.button("Живая комната", 14, "ghost")
	live.custom_minimum_size = Vector2(160, 36)
	live.pressed.connect(func() -> void: emit_signal("live_pressed"))
	_dev_row.add_child(live)

	var bottom := HBoxContainer.new()
	bottom.add_theme_constant_override("separation", 8)
	_main_page.add_child(bottom)
	var models := ToxUI.button("Модели", 14)
	models.custom_minimum_size = Vector2(120, 38)
	models.pressed.connect(func() -> void: emit_signal("models_pressed"))
	bottom.add_child(models)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	bottom.add_child(spacer)
	_dev_btn = ToxUI.button("⚙", 15, "ghost")
	_dev_btn.custom_minimum_size = Vector2(40, 38)
	_dev_btn.tooltip_text = "Отладка: новый рендер и живая комната"
	_dev_btn.pressed.connect(func() -> void:
		_dev_row.visible = not _dev_row.visible)
	bottom.add_child(_dev_btn)
	var note := ToxUI.ink_label("4tox · Godot 4", 12)
	note.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	bottom.add_child(note)

	_pause_page = VBoxContainer.new()
	_pause_page.add_theme_constant_override("separation", 10)
	board_box.add_child(_pause_page)
	var pause_title := ToxUI.label("Меню", 40, ToxUI.CREAM, 8)
	pause_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_pause_page.add_child(pause_title)
	var pause_note := ToxUI.ink_label("игра не останавливается", 13)
	pause_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pause_note.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	_pause_page.add_child(pause_note)
	var stats_grid := GridContainer.new()
	stats_grid.columns = 2
	stats_grid.add_theme_constant_override("h_separation", 22)
	stats_grid.add_theme_constant_override("v_separation", 6)
	_pause_page.add_child(stats_grid)
	for key in ["seed", "size", "logs", "felled", "delivered", "time", "warriors"]:
		var k := ToxUI.ink_label(_stat_name(key), 14)
		k.add_theme_color_override("font_color", ToxUI.INK_SOFT)
		stats_grid.add_child(k)
		var v := ToxUI.ink_label("—", 15)
		stats_grid.add_child(v)
		_stat_labels[key] = v
	_pause_page.add_child(ToxUI.hsep(6))
	_pause_continue = ToxUI.button("Продолжить", 20, "primary")
	_pause_continue.custom_minimum_size = Vector2(0, 54)
	_pause_continue.pressed.connect(func() -> void: emit_signal("continue_pressed"))
	_pause_page.add_child(_pause_continue)
	var pause_row := HBoxContainer.new()
	pause_row.add_theme_constant_override("separation", 8)
	_pause_page.add_child(pause_row)
	_pause_new_btn = ToxUI.button("Новый остров", 15)
	_pause_new_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_pause_new_btn.custom_minimum_size = Vector2(0, 44)
	_pause_new_btn.pressed.connect(func() -> void: emit_signal("new_island_pressed"))
	pause_row.add_child(_pause_new_btn)
	var main_btn := ToxUI.button("В главное меню", 15)
	main_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	main_btn.custom_minimum_size = Vector2(0, 44)
	main_btn.pressed.connect(func() -> void: emit_signal("main_menu_pressed"))
	pause_row.add_child(main_btn)
	var pause_models := ToxUI.button("Модели", 14)
	pause_models.custom_minimum_size = Vector2(0, 38)
	pause_models.pressed.connect(func() -> void: emit_signal("models_pressed"))
	_pause_page.add_child(pause_models)

	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.alignment = BoxContainer.ALIGNMENT_END
	row.add_child(right)
	_right_hint = ToxUI.label("остров живёт за меню", 14, Color(0.9, 0.95, 0.9, 0.7), 3)
	_right_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	right.add_child(_right_hint)

func _green_box() -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = Color("#63b348")
	s.border_color = Color("#2f6420")
	s.set_border_width_all(3)
	s.set_corner_radius_all(10)
	s.content_margin_left = 10
	s.content_margin_right = 10
	s.content_margin_top = 8
	s.content_margin_bottom = 8
	s.shadow_color = Color(0.05, 0.1, 0.03, 0.35)
	s.shadow_size = 4
	s.shadow_offset = Vector2(0, 3)
	return s

func _stat_name(key: String) -> String:
	match key:
		"seed": return "Сид"
		"size": return "Остров"
		"logs": return "Брёвен"
		"felled": return "Срублено"
		"delivered": return "Ходок"
		"time": return "Время"
		"warriors": return "Воинов"
	return key

func _select_size(s: int) -> void:
	selected_size = s
	for k in _cards.keys():
		_cards[k].button_pressed = (k == s)
	if _seed_edit != null:
		seed_text = _seed_edit.text.strip_edges()
		if seed_text.is_empty():
			seed_text = SEEDS.get(s, "остров")
			_seed_edit.text = seed_text
	emit_signal("size_changed", selected_size, seed_text)

func _select_mode(m: String) -> void:
	selected_mode = m
	for k in _mode_buttons.keys():
		_mode_buttons[k].button_pressed = (k == m)

func _on_play() -> void:
	seed_text = _seed_edit.text.strip_edges()
	if seed_text.is_empty():
		seed_text = SEEDS.get(selected_size, "остров")
		_seed_edit.text = seed_text
	emit_signal("play_pressed", selected_size, seed_text, selected_mode)

func show_main(has_saved: bool = false) -> void:
	has_game = has_saved
	_show_main(true)
	_show_pause(false)
	_title.text = "4TOX"
	_subtitle.text = "остров · деревня · лесорубы"
	_sign_wrap.visible = true
	_continue_btn.visible = has_saved
	modulate.a = 1.0
	visible = true
	call_deferred("_animate_menu")

func show_pause(stats: Dictionary, net_mode: bool = false) -> void:
	_show_main(false)
	_show_pause(true)
	_title.text = "Меню"
	_subtitle.text = "матч не останавливается" if net_mode else "остров не останавливается"
	_sign_wrap.visible = false
	visible = true
	call_deferred("_animate_menu")
	if _pause_new_btn != null:
		_pause_new_btn.visible = not net_mode
	for key in _stat_labels.keys():
		_stat_labels[key].text = str(stats.get(key, "—"))

func _animate_menu() -> void:
	if not visible:
		return
	if _board != null and _board.is_inside_tree():
		ToxUI.pop_in(_board, 0.24)
	if _sign_wrap != null and _sign_wrap.visible and _sign_wrap.is_inside_tree():
		ToxUI.pop_in(_sign_wrap, 0.3)


func _show_main(v: bool) -> void:
	_main_page.visible = v
	_board.visible = true
	if v:
		_pause_page.visible = false

func _show_pause(v: bool) -> void:
	_pause_page.visible = v
	if v:
		_main_page.visible = false

func _input(event: InputEvent) -> void:
	if not visible:
		return
	if event is InputEventKey and event.pressed and not event.echo:
		if event.physical_keycode == KEY_ENTER and _main_page.visible:
			_on_play()
			get_viewport().set_input_as_handled()
