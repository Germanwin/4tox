class_name ToxHUD
extends Control

signal menu_requested
signal continue_requested
signal new_island_requested
signal main_menu_requested
signal build_requested(type)
signal edit_requested(b)
signal edit_action(action)
signal hire_requested(v, camp)
signal fire_requested(v)
signal hire_all_requested(camp)
signal fire_all_requested(camp)
signal train_requested(v, barracks)
signal train_all_requested(barracks)
signal order_requested(ids)
signal stop_requested
signal focus_requested(v)
signal minimap_cell(cell)

const BUILD_MENU := [
	{"type": "house", "variant": "a", "price": 12, "note": "жильё для четверых"},
	{"type": "lumbercamp", "variant": "a", "price": 20, "note": "три рабочих места"},
	{"type": "barracks", "variant": "a", "price": 28, "note": "открытый плац · тип А"},
	{"type": "warcamp", "variant": "x", "price": 24, "note": "дружина до 20 воинов"}
]

var sim: ToxSim
var view: ToxWorldView

var res_label: Label
var event_head: Label
var event_list: VBoxContainer
var event_panel: PanelContainer
var net_panel: PanelContainer
var net_label: Label
var net_mode := false
var build_plaque: PanelContainer
var villager_plaque: PanelContainer
var villager_portrait: TextureRect
var villager_name: Label
var villager_status: Label
var villager_home: Label
var build_portrait: TextureRect
var build_name: Label
var build_size: Label
var build_cell: Label
var edit_btn: Button
var hire_panel: PanelContainer
var hire_title: Label
var hire_slots: Label
var hire_list: VBoxContainer
var hire_all_btn: Button
var fire_all_btn: Button
var hire_note: Label
var squad_panel: PanelContainer
var squad_title: Label
var squad_slots: Label
var squad_list: VBoxContainer
var squad_order_btn: Button
var squad_stop_btn: Button
var village_panel: PanelContainer
var village_list: VBoxContainer
var village_title: Label
var build_menu: PanelContainer
var build_cards: HBoxContainer
var edit_bar: PanelContainer
var edit_reason: Label
var hover_label: Label
var hint_label: Label
var minimap: ToxMinimap
var toast_panel: PanelContainer
var toast_label: Label
var toast_t: float = 0.0
var loading: Control
var end_screen: Control
var end_title: Label
var end_text: Label
var end_new_btn: Button
var left_col: VBoxContainer
var top_left: HBoxContainer
var top_right: HBoxContainer
var menu_btn: Button

var selected_building: Variant = null
var selected_villager: Variant = null
var focus_villager: Variant = null
var work_target: Variant = null
var squad_counts: Dictionary = {}
var squad_groups: Array = []
var edit_target: Variant = null
var _refresh_t := 0.0
var _ui_ready := false
var _view_connected := false
var _build_buttons: Array = []

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	theme = ToxUI.theme()
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_build_top_left()
	_build_top_right()
	_build_left_column()
	_build_bottom()
	_build_build_menu()
	_build_edit_bar()
	_build_toast()
	_build_loading()
	_build_end_screen()
	_ui_ready = true

func _panel_style() -> StyleBoxFlat:
	return null

func bind(p_sim: ToxSim, p_view: ToxWorldView) -> void:
	sim = p_sim
	view = p_view
	selected_building = null
	selected_villager = null
	focus_villager = null
	squad_counts.clear()
	build_plaque.visible = false
	villager_plaque.visible = false
	hire_panel.visible = false
	squad_panel.visible = false
	village_panel.visible = false
	build_menu.visible = false
	edit_bar.visible = false
	end_screen.visible = false
	loading.visible = false
	minimap.bind(sim, view)
	_refresh()
	if _view_connected:
		return
	_view_connected = true
	view.hover_changed.connect(_on_hover)
	view.building_clicked.connect(_on_building_clicked)
	view.villager_clicked.connect(_on_villager_clicked)
	view.ground_clicked.connect(_on_ground_clicked)
	view.building_double_clicked.connect(_on_building_double)
	view.building_held.connect(_on_building_held)
	view.place_clicked.connect(_on_place_clicked)
	view.edit_clicked.connect(_on_edit_clicked)
	view.order_clicked.connect(_on_order_clicked)
	view.cancel_requested.connect(_on_cancel)
	view.rotate_requested.connect(_on_rotate)

func set_net_mode(on: bool) -> void:
	net_mode = on
	if net_panel != null:
		net_panel.visible = on
	if end_new_btn != null:
		end_new_btn.visible = not on

func set_net_status(text: String, error: bool = false) -> void:
	if net_label == null:
		return
	net_label.text = text
	net_label.add_theme_color_override("font_color", Color("#9b2f21") if error else ToxUI.INK)

func _build_top_left() -> void:
	top_left = HBoxContainer.new()
	top_left.set_anchors_preset(Control.PRESET_TOP_LEFT)
	top_left.position = Vector2(16, 14)
	top_left.add_theme_constant_override("separation", 8)
	top_left.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(top_left)

	var res_panel := ToxUI.panel(10, ToxUI.WOOD_LITE)
	res_panel.custom_minimum_size = Vector2(210, 54)
	top_left.add_child(res_panel)
	var rh := HBoxContainer.new()
	rh.add_theme_constant_override("separation", 8)
	res_panel.add_child(rh)
	var icon := TextureRect.new()
	icon.texture = load("res://assets/wood.png")
	icon.custom_minimum_size = Vector2(42, 42)
	icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	rh.add_child(icon)
	var rv := VBoxContainer.new()
	rv.add_theme_constant_override("separation", -3)
	rh.add_child(rv)
	var title := ToxUI.ink_label("Добыто", 11)
	title.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	rv.add_child(title)
	res_label = ToxUI.ink_label("0 брёвен", 18)
	rv.add_child(res_label)

	var village_btn := ToxUI.button("☰ Деревня", 14)
	village_btn.custom_minimum_size = Vector2(126, 54)
	village_btn.tooltip_text = "Сведения о деревне (T)"
	village_btn.pressed.connect(_toggle_village)
	top_left.add_child(village_btn)

	event_panel = ToxUI.panel(8, ToxUI.WOOD_LITE)
	event_panel.custom_minimum_size = Vector2(280, 58)
	top_left.add_child(event_panel)
	var es := event_panel.get_theme_stylebox("panel").duplicate() as StyleBoxFlat
	if es != null:
		es.content_margin_top = 10
		es.content_margin_bottom = 6
		event_panel.add_theme_stylebox_override("panel", es)
	var ev := VBoxContainer.new()
	ev.alignment = BoxContainer.ALIGNMENT_CENTER
	ev.add_theme_constant_override("separation", 0)
	event_panel.add_child(ev)
	event_head = ToxUI.ink_label("событий пока нет", 12)
	event_head.add_theme_color_override("font_color", ToxUI.INK)
	event_head.custom_minimum_size = Vector2(0, 24)
	event_head.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	ev.add_child(event_head)
	event_list = VBoxContainer.new()
	event_list.visible = false
	ev.add_child(event_list)
	event_panel.gui_input.connect(func(e: InputEvent) -> void:
		if e is InputEventMouseButton and e.pressed and e.button_index == MOUSE_BUTTON_LEFT:
			event_list.visible = not event_list.visible)
	event_panel.mouse_filter = Control.MOUSE_FILTER_STOP

func _build_top_right() -> void:
	top_right = HBoxContainer.new()
	top_right.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	top_right.position = Vector2(-16, 14)
	top_right.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	top_right.add_theme_constant_override("separation", 8)
	top_right.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(top_right)
	net_panel = ToxUI.panel(8, ToxUI.WOOD_LITE)
	net_panel.custom_minimum_size = Vector2(206, 46)
	net_panel.visible = false
	top_right.add_child(net_panel)
	net_label = ToxUI.ink_label("Сеть", 12)
	net_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	net_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	net_panel.add_child(net_label)
	var build := ToxUI.button("Стройка", 15)
	build.custom_minimum_size = Vector2(106, 46)
	build.tooltip_text = "Построить дом, лагерь, казарму или военный лагерь"
	build.pressed.connect(_toggle_build_menu)
	top_right.add_child(build)
	var army := ToxUI.button("Войска  O", 15)
	army.custom_minimum_size = Vector2(116, 46)
	army.pressed.connect(_toggle_squad)
	top_right.add_child(army)
	menu_btn = ToxUI.button("Меню  Esc", 15)
	menu_btn.custom_minimum_size = Vector2(116, 46)
	menu_btn.pressed.connect(func() -> void: emit_signal("menu_requested"))
	top_right.add_child(menu_btn)

func _build_left_column() -> void:
	left_col = VBoxContainer.new()
	left_col.set_anchors_preset(Control.PRESET_TOP_LEFT)
	left_col.position = Vector2(16, 80)
	left_col.custom_minimum_size = Vector2(340, 0)
	left_col.add_theme_constant_override("separation", 8)
	left_col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(left_col)

	build_plaque = ToxUI.panel(10)
	build_plaque.visible = false
	left_col.add_child(build_plaque)
	var bh := HBoxContainer.new()
	bh.add_theme_constant_override("separation", 8)
	build_plaque.add_child(bh)
	build_portrait = TextureRect.new()
	build_portrait.custom_minimum_size = Vector2(74, 74)
	build_portrait.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	build_portrait.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	bh.add_child(build_portrait)
	var bv := VBoxContainer.new()
	bv.add_theme_constant_override("separation", 1)
	bh.add_child(bv)
	build_name = ToxUI.ink_label("Постройка", 17)
	bv.add_child(build_name)
	build_size = ToxUI.ink_label("", 12)
	build_size.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	bv.add_child(build_size)
	build_cell = ToxUI.ink_label("", 11)
	build_cell.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	bv.add_child(build_cell)
	edit_btn = ToxUI.button("Править", 13)
	edit_btn.custom_minimum_size = Vector2(92, 34)
	edit_btn.pressed.connect(func() -> void:
		if selected_building != null:
			emit_signal("edit_requested", selected_building))
	bh.add_child(edit_btn)

	villager_plaque = ToxUI.panel(10)
	villager_plaque.visible = false
	left_col.add_child(villager_plaque)
	var vh := HBoxContainer.new()
	vh.add_theme_constant_override("separation", 8)
	villager_plaque.add_child(vh)
	villager_portrait = TextureRect.new()
	villager_portrait.custom_minimum_size = Vector2(74, 86)
	villager_portrait.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	villager_portrait.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	vh.add_child(villager_portrait)
	var vvbox := VBoxContainer.new()
	vvbox.add_theme_constant_override("separation", 1)
	vvbox.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vh.add_child(vvbox)
	villager_name = ToxUI.ink_label("Житель", 17)
	vvbox.add_child(villager_name)
	villager_status = ToxUI.ink_label("", 12)
	villager_status.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	villager_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vvbox.add_child(villager_status)
	villager_home = ToxUI.ink_label("", 10)
	villager_home.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	vvbox.add_child(villager_home)
	var follow := ToxUI.button("Следить", 12)
	follow.custom_minimum_size = Vector2(86, 34)
	follow.pressed.connect(func() -> void:
		if selected_villager != null:
			emit_signal("focus_requested", selected_villager))
	vh.add_child(follow)

	hire_panel = ToxUI.panel(10)
	hire_panel.visible = false
	hire_panel.custom_minimum_size = Vector2(340, 0)
	left_col.add_child(hire_panel)
	var hv := VBoxContainer.new()
	hv.add_theme_constant_override("separation", 6)
	hire_panel.add_child(hv)
	var hh := HBoxContainer.new()
	hh.add_theme_constant_override("separation", 6)
	hv.add_child(hh)
	hire_title = ToxUI.ink_label("Лагерь лесоруба", 16)
	hire_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hh.add_child(hire_title)
	hire_slots = ToxUI.ink_label("работники 0 / 3", 12)
	hire_slots.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	hh.add_child(hire_slots)
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 6)
	hv.add_child(hb)
	hire_all_btn = ToxUI.button("Нанять свободных", 12)
	hire_all_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hire_all_btn.pressed.connect(func() -> void:
		if work_target != null:
			emit_signal("hire_all_requested", work_target))
	hb.add_child(hire_all_btn)
	fire_all_btn = ToxUI.button("Распустить всех", 12)
	fire_all_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	fire_all_btn.pressed.connect(func() -> void:
		if work_target != null:
			emit_signal("fire_all_requested", work_target))
	hb.add_child(fire_all_btn)
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(0, 230)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	hv.add_child(scroll)
	hire_list = VBoxContainer.new()
	hire_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hire_list.add_theme_constant_override("separation", 5)
	scroll.add_child(hire_list)
	hire_note = ToxUI.ink_label("", 11)
	hire_note.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	hv.add_child(hire_note)

	squad_panel = ToxUI.panel(10)
	squad_panel.visible = false
	squad_panel.custom_minimum_size = Vector2(340, 0)
	left_col.add_child(squad_panel)
	var sv := VBoxContainer.new()
	sv.add_theme_constant_override("separation", 6)
	squad_panel.add_child(sv)
	var sh := HBoxContainer.new()
	sh.add_theme_constant_override("separation", 6)
	sv.add_child(sh)
	squad_title = ToxUI.ink_label("Войска", 16)
	squad_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	sh.add_child(squad_title)
	squad_slots = ToxUI.ink_label("воины 0", 12)
	squad_slots.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	sh.add_child(squad_slots)
	var ab := HBoxContainer.new()
	ab.add_theme_constant_override("separation", 4)
	sv.add_child(ab)
	for pair in [["Всех", "all"], ["Половина", "half"], ["Сброс", "reset"]]:
		var bb := ToxUI.button(pair[0], 11)
		bb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		bb.pressed.connect(func() -> void: _squad_batch(pair[1]))
		ab.add_child(bb)
	var sscroll := ScrollContainer.new()
	sscroll.custom_minimum_size = Vector2(0, 170)
	sscroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	sv.add_child(sscroll)
	squad_list = VBoxContainer.new()
	squad_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	squad_list.add_theme_constant_override("separation", 5)
	sscroll.add_child(squad_list)
	var ob := HBoxContainer.new()
	ob.add_theme_constant_override("separation", 6)
	sv.add_child(ob)
	squad_order_btn = ToxUI.button("Приказ", 13)
	squad_order_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	squad_order_btn.custom_minimum_size = Vector2(0, 38)
	squad_order_btn.pressed.connect(_squad_order)
	ob.add_child(squad_order_btn)
	squad_stop_btn = ToxUI.button("Стоп", 13)
	squad_stop_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	squad_stop_btn.custom_minimum_size = Vector2(0, 38)
	squad_stop_btn.pressed.connect(func() -> void: emit_signal("stop_requested"))
	ob.add_child(squad_stop_btn)

	village_panel = ToxUI.panel(10)
	village_panel.visible = false
	village_panel.custom_minimum_size = Vector2(340, 0)
	left_col.add_child(village_panel)
	var vv := VBoxContainer.new()
	vv.add_theme_constant_override("separation", 5)
	village_panel.add_child(vv)
	village_title = ToxUI.ink_label("Деревня", 16)
	vv.add_child(village_title)
	var vscroll := ScrollContainer.new()
	vscroll.custom_minimum_size = Vector2(0, 280)
	vscroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	vv.add_child(vscroll)
	village_list = VBoxContainer.new()
	village_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	village_list.add_theme_constant_override("separation", 4)
	vscroll.add_child(village_list)

func _build_bottom() -> void:
	hover_label = ToxUI.label("", 14, ToxUI.CREAM, 4)
	hover_label.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	hover_label.position = Vector2(-300, -74)
	hover_label.custom_minimum_size = Vector2(600, 24)
	hover_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hover_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hover_label)
	hint_label = ToxUI.label("ЛКМ выбор · удержание правит · ПКМ/перетаскивание панорама · колесо зум · O войска · T деревня · Esc меню",
		12, Color(0.95, 0.93, 0.85, 0.82), 3)
	hint_label.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	hint_label.position = Vector2(-520, -40)
	hint_label.custom_minimum_size = Vector2(1040, 20)
	hint_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hint_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hint_label)

	var mm_panel := ToxUI.panel(6, ToxUI.WOOD_LITE)
	mm_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	mm_panel.position = Vector2(-222, -252)
	mm_panel.custom_minimum_size = Vector2(206, 236)
	add_child(mm_panel)
	var mm_box := VBoxContainer.new()
	mm_box.add_theme_constant_override("separation", 3)
	mm_panel.add_child(mm_box)
	var mm_title := ToxUI.ink_label("Остров", 12)
	mm_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	mm_box.add_child(mm_title)
	minimap = ToxMinimap.new()
	minimap.custom_minimum_size = Vector2(190, 190)
	minimap.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	minimap.cell_clicked.connect(func(c: Vector2i) -> void: emit_signal("minimap_cell", c))
	mm_box.add_child(minimap)

func _build_build_menu() -> void:
	build_menu = ToxUI.panel(14)
	build_menu.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	build_menu.position = Vector2(-420, -300)
	build_menu.custom_minimum_size = Vector2(840, 240)
	build_menu.visible = false
	add_child(build_menu)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	build_menu.add_child(v)
	var head := HBoxContainer.new()
	v.add_child(head)
	var title := ToxUI.ink_label("Стройка", 20)
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(title)
	var close := ToxUI.button("×", 18)
	close.custom_minimum_size = Vector2(38, 32)
	close.pressed.connect(_hide_build_menu)
	head.add_child(close)
	build_cards = HBoxContainer.new()
	build_cards.add_theme_constant_override("separation", 8)
	v.add_child(build_cards)

func _build_edit_bar() -> void:
	edit_bar = ToxUI.panel(10)
	edit_bar.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	edit_bar.position = Vector2(-360, -112)
	edit_bar.custom_minimum_size = Vector2(720, 64)
	edit_bar.visible = false
	add_child(edit_bar)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 2)
	edit_bar.add_child(v)
	edit_reason = ToxUI.ink_label("", 11)
	edit_reason.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	edit_reason.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(edit_reason)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	v.add_child(row)
	for pair in [["Двигать", "move"], ["Повернуть", "rotate"], ["Снести", "remove"], ["Применить", "apply"], ["Отменить", "cancel"]]:
		var b := ToxUI.button(pair[0], 13)
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.custom_minimum_size = Vector2(0, 36)
		b.pressed.connect(func() -> void: emit_signal("edit_action", pair[1]))
		row.add_child(b)

func _build_toast() -> void:
	toast_panel = ToxUI.panel(10)
	toast_panel.set_anchors_preset(Control.PRESET_CENTER_TOP)
	toast_panel.position = Vector2(-260, 90)
	toast_panel.custom_minimum_size = Vector2(520, 0)
	toast_panel.visible = false
	add_child(toast_panel)
	toast_label = ToxUI.ink_label("", 14)
	toast_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	toast_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	toast_panel.add_child(toast_label)

func _build_loading() -> void:
	loading = ColorRect.new()
	loading.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	loading.color = Color(0.02, 0.08, 0.14, 0.82)
	loading.visible = false
	loading.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(loading)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	loading.add_child(center)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	center.add_child(box)
	var t := ToxUI.label("Готовим остров…", 34, ToxUI.CREAM, 8)
	t.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(t)
	var sub := ToxUI.label("генерация карты, деревни и жителей", 14, Color(0.9, 0.92, 0.85, 0.8))
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(sub)

func _build_end_screen() -> void:
	end_screen = ColorRect.new()
	end_screen.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	end_screen.color = Color(0.02, 0.07, 0.12, 0.72)
	end_screen.visible = false
	end_screen.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(end_screen)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	end_screen.add_child(center)
	var panel := ToxUI.panel(22)
	panel.custom_minimum_size = Vector2(520, 280)
	center.add_child(panel)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 12)
	panel.add_child(v)
	end_title = ToxUI.label("Победа", 40, ToxUI.CREAM, 8)
	end_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(end_title)
	end_text = ToxUI.ink_label("", 15)
	end_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	end_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	v.add_child(end_text)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	v.add_child(row)
	end_new_btn = ToxUI.button("Новый остров", 16)
	end_new_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	end_new_btn.custom_minimum_size = Vector2(0, 46)
	end_new_btn.pressed.connect(func() -> void: emit_signal("new_island_requested"))
	row.add_child(end_new_btn)
	var menu_b := ToxUI.button("В главное меню", 16)
	menu_b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	menu_b.custom_minimum_size = Vector2(0, 46)
	menu_b.pressed.connect(func() -> void: emit_signal("main_menu_requested"))
	row.add_child(menu_b)

# ------------------------------------------------------------------ refresh

func _process(dt: float) -> void:
	if not _ui_ready or sim == null:
		return
	res_label.text = "%d брёвен" % sim.player_logs()
	if sim.events.is_empty():
		event_head.text = "событий пока нет"
	else:
		var last_event := str(sim.events[-1].text)
		if event_head.text != last_event:
			event_head.text = last_event
			ToxUI.clear(event_list)
			var start := maxi(0, sim.events.size() - 6)
			for i in range(start, sim.events.size()):
				var row := ToxUI.ink_label("• " + str(sim.events[i].text), 10)
				row.add_theme_color_override("font_color", ToxUI.INK_SOFT)
				row.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
				event_list.add_child(row)
	if toast_t > 0.0:
		toast_t -= dt
		if toast_t <= 0.0:
			toast_panel.visible = false
	_refresh_t -= dt
	if build_menu.visible:
		for item in _build_buttons:
			var btn: Button = item.btn
			var price: int = item.price
			btn.disabled = sim.player_logs() < price
			btn.tooltip_text = ("Нужно %d брёвен" % price) if btn.disabled else "Взять в руки и поставить"
	if selected_villager != null and selected_villager.dead:
		selected_villager = null
		villager_plaque.visible = false
		if village_panel.visible:
			_refresh_village()
	if selected_building != null and not sim.buildings.has(selected_building):
		selected_building = null
		build_plaque.visible = false
		hire_panel.visible = false
	if _refresh_t <= 0.0:
		_refresh_t = 1.0
		if edit_bar.visible:
			_refresh_edit_bar()
		if selected_villager != null and villager_plaque.visible:
			villager_status.text = sim.work_word(selected_villager)

func _refresh() -> void:
	if sim == null:
		return
	res_label.text = "%d брёвен" % sim.player_logs()
	if selected_building != null:
		_show_building(selected_building)
	elif selected_villager != null:
		_show_villager(selected_villager)

func show_toast(text: String, seconds: float = 2.6) -> void:
	toast_label.text = text
	toast_panel.visible = true
	toast_t = seconds

func show_loading(v: bool, text: String = "Готовим остров…") -> void:
	loading.visible = v
	if v:
		var t := loading.find_child("Label", true, false)
		if t is Label:
			t.text = text

func show_end(win: bool, text: String) -> void:
	hide_all_panels()
	end_screen.visible = true
	end_title.text = "Победа" if win else "Поражение"
	end_title.add_theme_color_override("font_color", ToxUI.GRASS_LITE if win else Color("#ffb0a3"))
	end_text.text = text

func hide_end() -> void:
	end_screen.visible = false

func _hide_popup_others(which: String) -> void:
	if which != "hire":
		hire_panel.visible = false
	if which != "squad":
		squad_panel.visible = false
	if which != "village":
		village_panel.visible = false
	if which != "build":
		build_menu.visible = false

func hide_all_panels() -> void:
	build_plaque.visible = false
	villager_plaque.visible = false
	hire_panel.visible = false
	squad_panel.visible = false
	village_panel.visible = false
	build_menu.visible = false
	edit_bar.visible = false

func _on_hover(cell: Vector2i, b: Variant, v: Variant) -> void:
	if sim == null:
		return
	if v != null:
		hover_label.text = "%s · %s" % [v.name, sim.work_word(v)]
		return
	if b != null:
		var fp := ToxBuildings.footprint(int(b.rot), ToxBuildings.type_of(b))
		hover_label.text = "%d, %d · %s · %d × %d" % [cell.x, cell.y, ToxBuildings.name_of(b), fp.x, fp.y]
		return
	var d := sim.world.describe_cell(cell.x, cell.y)
	hover_label.text = str(d.text) if d.text != null else ""

func _on_building_clicked(b: Dictionary) -> void:
	select_building(b)

func _on_villager_clicked(v: ToxVillager) -> void:
	select_villager(v)

func _on_ground_clicked(_cell: Vector2i) -> void:
	selected_building = null
	selected_villager = null
	build_plaque.visible = false
	villager_plaque.visible = false
	hire_panel.visible = false
	squad_panel.visible = false
	village_panel.visible = false
	build_menu.visible = false

func _on_building_double(b: Dictionary) -> void:
	select_building(b)

func _on_building_held(b: Dictionary) -> void:
	select_building(b)

func _on_place_clicked(_cell: Vector2i) -> void:
	pass

func _on_edit_clicked(_cell: Vector2i) -> void:
	pass

func _on_order_clicked(_cell: Vector2i) -> void:
	pass

func _on_cancel() -> void:
	pass

func _on_rotate() -> void:
	pass

func select_building(b: Dictionary) -> void:
	selected_building = b
	selected_villager = null
	villager_plaque.visible = false
	_show_building(b)
	if view != null:
		view.selected_building = b
		view.selected_villager = null
	var typ := ToxBuildings.type_of(b)
	var own := sim == null or int(b.get("owner", 0)) == sim.player_owner
	village_panel.visible = false
	squad_panel.visible = false
	if (typ == "lumbercamp" or typ == "barracks") and own:
		work_target = b
		hire_panel.visible = true
		_refresh_hire()
	else:
		hire_panel.visible = false

func select_villager(v: ToxVillager) -> void:
	selected_villager = v
	selected_building = null
	focus_villager = v
	_show_villager(v)
	if view != null:
		view.selected_villager = v
		view.selected_building = null
	build_plaque.visible = false
	hire_panel.visible = false
	if village_panel.visible:
		_refresh_village()

func _show_building(b: Dictionary) -> void:
	build_plaque.visible = true
	villager_plaque.visible = false
	var typ := ToxBuildings.type_of(b)
	var frame := ToxAtlasDB.ruin_frame(typ, int(b.rot)) if b.get("rubble", false) else ToxAtlasDB.building_frame(typ, str(b.variant), int(b.rot))
	build_portrait.texture = _atlas_texture(frame)
	build_name.text = ToxBuildings.name_of(b)
	var fp := ToxBuildings.footprint(int(b.rot), typ)
	build_size.text = "%d × %d клетки" % [fp.x, fp.y]
	build_cell.text = "клетка %d, %d" % [int(b.x), int(b.y)]
	var own := sim == null or int(b.get("owner", 0)) == sim.player_owner
	edit_btn.disabled = b.get("rubble", false) or not own
	if b.get("rubble", false):
		edit_btn.tooltip_text = "Руину не правят"
	elif not own:
		edit_btn.tooltip_text = "Чужая постройка"
	else:
		edit_btn.tooltip_text = "Править: подвинуть, повернуть, снести"

func _show_villager(v: ToxVillager) -> void:
	build_plaque.visible = false
	villager_plaque.visible = true
	villager_name.text = v.name
	villager_status.text = sim.work_word(v) if sim != null else ""
	var home: Variant = sim.bld_any(v.home_id) if sim != null else null
	villager_home.text = ("дом: " + ToxBuildings.name_of(home)) if home != null else "бездомный"
	var frame := ToxAtlasDB.character_frame(v.warrior, "idle", 0, 0.0)
	villager_portrait.texture = _atlas_texture(frame)

func _atlas_texture(frame: Dictionary) -> Texture2D:
	if frame.is_empty():
		return null
	var at := AtlasTexture.new()
	at.atlas = frame.tex
	at.region = frame.region
	return at

func _toggle_village() -> void:
	if sim == null:
		return
	_hide_popup_others("village")
	village_panel.visible = not village_panel.visible
	if village_panel.visible:
		_refresh_village()

func _toggle_squad() -> void:
	if sim == null:
		return
	_hide_popup_others("squad")
	squad_panel.visible = not squad_panel.visible
	if squad_panel.visible:
		_refresh_squad()

func _toggle_build_menu() -> void:
	_hide_popup_others("build")
	build_menu.visible = not build_menu.visible
	if build_menu.visible:
		_refresh_build_menu()

func _hide_build_menu() -> void:
	build_menu.visible = false

func _refresh_hire() -> void:
	if work_target == null or sim == null:
		return
	if int(work_target.get("owner", 0)) != sim.player_owner:
		hire_panel.visible = false
		return
	var typ := ToxBuildings.type_of(work_target)
	var is_barracks := typ == "barracks"
	hire_title.text = ToxBuildings.name_of(work_target)
	var slots := ToxBuildings.training_slots(work_target) if is_barracks else ToxBuildings.work_slots(work_target)
	var trainees := sim.trainees_of(work_target) if is_barracks else []
	var workers := sim.workers_of(work_target) if not is_barracks else []
	if is_barracks:
		var warriors := 0
		for v in sim.villagers:
			if v.warrior and not v.dead and v.owner == int(work_target.get("owner", 0)):
				warriors += 1
		hire_slots.text = "воины %d · тренируются %d / %d" % [warriors, trainees.size(), slots]
		hire_all_btn.text = "Тренировать свободных"
		fire_all_btn.visible = false
	else:
		hire_slots.text = "работники %d / %d" % [workers.size(), slots]
		hire_all_btn.text = "Нанять свободных"
		fire_all_btn.visible = true
	ToxUI.clear(hire_list)
	var rows := sim.training_order(work_target) if is_barracks else sim.hire_order(work_target)
	for row in rows:
		var v: ToxVillager = row.v
		var line := HBoxContainer.new()
		line.add_theme_constant_override("separation", 6)
		var frame := ToxAtlasDB.character_frame(v.warrior, "idle", 0, 0.0)
		var port := ToxUI.portrait(frame, Vector2(38, 42))
		line.add_child(port)
		var col := VBoxContainer.new()
		col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		col.add_theme_constant_override("separation", -2)
		line.add_child(col)
		var name := ToxUI.ink_label(v.name, 13)
		col.add_child(name)
		var status := ToxUI.ink_label(sim.work_word(v), 10)
		status.add_theme_color_override("font_color", ToxUI.INK_SOFT)
		status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		col.add_child(status)
		var action := ToxUI.button("", 11)
		action.custom_minimum_size = Vector2(88, 30)
		if is_barracks:
			if row.group == 0:
				action.text = "Тренируется"
				action.disabled = true
			elif row.group == 2:
				action.text = "Воин"
				action.disabled = true
			else:
				action.text = "Тренировать"
				action.disabled = not row.check.ok
				action.tooltip_text = str(row.check.reason)
				action.pressed.connect(func() -> void: emit_signal("train_requested", v, work_target))
		else:
			if row.group == 0:
				action.text = "Уволить"
				action.pressed.connect(func() -> void: emit_signal("fire_requested", v))
			elif row.group == 1:
				action.text = "Нанять"
				action.disabled = not row.check.ok
				action.tooltip_text = str(row.check.reason)
				action.pressed.connect(func() -> void: emit_signal("hire_requested", v, work_target))
			else:
				action.text = "Занят"
				action.disabled = true
				action.tooltip_text = str(row.check.reason)
		line.add_child(action)
		hire_list.add_child(line)
	hire_all_btn.disabled = (rows.is_empty())
	fire_all_btn.disabled = workers.is_empty() if not is_barracks else true
	hire_note.text = "В казарме не нанимают, а тренируют: 5 секунд, затем воин." if is_barracks else "Работник рубит лес, несёт брёвна в лагерь и приносит +4."

func _refresh_squad() -> void:
	if sim == null:
		return
	squad_groups = sim.army_groups(sim.player_owner)
	var total := 0
	for g in squad_groups:
		total += int(g.count)
	squad_slots.text = "воины %d" % total
	ToxUI.clear(squad_list)
	for idx in range(squad_groups.size()):
		var g: Dictionary = squad_groups[idx]
		var line := HBoxContainer.new()
		line.add_theme_constant_override("separation", 4)
		var label := ToxUI.ink_label("%s · %d / %d" % [g.label, g.count, g.cap], 11)
		label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		line.add_child(label)
		if not squad_counts.has(idx):
			squad_counts[idx] = int(g.count)
		var minus := ToxUI.button("−", 13)
		minus.custom_minimum_size = Vector2(30, 28)
		minus.pressed.connect(func() -> void: _squad_add(idx, -1))
		line.add_child(minus)
		var num := ToxUI.ink_label(str(squad_counts.get(idx, 0)), 12)
		num.custom_minimum_size = Vector2(26, 0)
		num.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		line.add_child(num)
		var plus := ToxUI.button("+", 13)
		plus.custom_minimum_size = Vector2(30, 28)
		plus.pressed.connect(func() -> void: _squad_add(idx, 1))
		line.add_child(plus)
		var half := ToxUI.button("½", 11)
		half.custom_minimum_size = Vector2(34, 28)
		half.pressed.connect(func() -> void:
			squad_counts[idx] = int(ceil(float(g.count) / 2.0))
			_refresh_squad())
		line.add_child(half)
		squad_list.add_child(line)
	squad_order_btn.disabled = total == 0

func _squad_add(idx: int, delta: int) -> void:
	if idx < 0 or idx >= squad_groups.size():
		return
	var g: Dictionary = squad_groups[idx]
	var v := clampi(int(squad_counts.get(idx, 0)) + delta, 0, int(g.count))
	squad_counts[idx] = v
	_refresh_squad()

func _squad_batch(mode: String) -> void:
	for idx in range(squad_groups.size()):
		var g: Dictionary = squad_groups[idx]
		if mode == "all":
			squad_counts[idx] = int(g.count)
		elif mode == "half":
			squad_counts[idx] = int(ceil(float(g.count) / 2.0))
		else:
			squad_counts[idx] = 0
	_refresh_squad()

func _squad_order() -> void:
	var ids := []
	for idx in range(squad_groups.size()):
		var g: Dictionary = squad_groups[idx]
		var n := clampi(int(squad_counts.get(idx, 0)), 0, int(g.count))
		var group_ids: Array = g.ids
		for i in range(n):
			if i < group_ids.size():
				ids.append(group_ids[i])
	if ids.is_empty():
		return
	emit_signal("order_requested", ids)

func _refresh_village() -> void:
	if sim == null:
		return
	ToxUI.clear(village_list)
	var seed_label := ToxUI.ink_label("Сид: %s" % sim.world.seed_text, 11)
	seed_label.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	village_list.add_child(seed_label)
	var stats := ToxUI.ink_label("срублено %d · ходок %d · время %s" % [sim.player_felled(), sim.player_deliveries(), ToxUI.fmt_time(sim.time)], 10)
	stats.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	village_list.add_child(stats)
	for v in sim.villagers:
		if v.owner != sim.player_owner or v.dead:
			continue
		var line := HBoxContainer.new()
		line.add_theme_constant_override("separation", 5)
		var frame := ToxAtlasDB.character_frame(v.warrior, "idle", 0, 0.0)
		line.add_child(ToxUI.portrait(frame, Vector2(34, 38)))
		var col := VBoxContainer.new()
		col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		col.add_theme_constant_override("separation", -2)
		line.add_child(col)
		col.add_child(ToxUI.ink_label(v.name, 12))
		var w := ToxUI.ink_label(sim.work_word(v), 10)
		w.add_theme_color_override("font_color", ToxUI.INK_SOFT)
		col.add_child(w)
		var follow := ToxUI.button("Следить", 10)
		follow.custom_minimum_size = Vector2(72, 28)
		follow.pressed.connect(func() -> void: emit_signal("focus_requested", v))
		line.add_child(follow)
		village_list.add_child(line)

func _refresh_build_menu() -> void:
	ToxUI.clear(build_cards)
	_build_buttons.clear()
	for card in BUILD_MENU:
		var type: String = card.type
		var price: int = card.price
		var frame := ToxAtlasDB.building_frame(type, str(card.variant), 90)
		var panel := ToxUI.panel(8, Color("#d8c19a"))
		panel.custom_minimum_size = Vector2(190, 190)
		var v := VBoxContainer.new()
		v.add_theme_constant_override("separation", 3)
		panel.add_child(v)
		var portrait := ToxUI.portrait(frame, Vector2(150, 92))
		portrait.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		v.add_child(portrait)
		var name := ToxUI.ink_label(ToxBuildings.NAMES.get(type, type), 15)
		name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		v.add_child(name)
		var note := ToxUI.ink_label(str(card.note), 9)
		note.add_theme_color_override("font_color", ToxUI.INK_SOFT)
		note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		v.add_child(note)
		var cost := ToxUI.ink_label("Цена: %d брёвен" % price, 11)
		cost.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		v.add_child(cost)
		var btn := ToxUI.button("Поставить", 13)
		btn.custom_minimum_size = Vector2(0, 34)
		var enough := sim.player_logs() >= price
		btn.disabled = not enough
		btn.tooltip_text = "Нужно %d брёвен" % price if not enough else "Взять в руки и поставить"
		btn.pressed.connect(func() -> void: emit_signal("build_requested", type))
		v.add_child(btn)
		_build_buttons.append({"type": type, "price": price, "btn": btn})
		build_cards.add_child(panel)

func show_edit(b: Dictionary, ok: bool, reason: String) -> void:
	edit_target = b
	edit_bar.visible = true
	edit_reason.text = reason if reason != "" else ("место годится" if ok else "место не годится")
	edit_reason.add_theme_color_override("font_color", ToxUI.INK_SOFT if ok else Color("#9b2f21"))
	_refresh_edit_bar()

func _refresh_edit_bar() -> void:
	if edit_target == null:
		return
	var typ := ToxBuildings.type_of(edit_target)
	var can_remove := typ != "townhall" and typ != "warcamp"
	for c in edit_bar.find_children("*", "Button", true, false):
		if c is Button:
			if c.text == "Снести":
				c.disabled = not can_remove
				c.tooltip_text = "ратушу снести нельзя" if not can_remove and typ == "townhall" else ("военный лагерь снести нельзя" if not can_remove else "")

func hide_edit() -> void:
	edit_bar.visible = false
	edit_target = null

func update_squad_counts() -> void:
	squad_counts.clear()
	if squad_panel.visible:
		_refresh_squad()

func village_toggle() -> void:
	_toggle_village()

func squad_toggle() -> void:
	_toggle_squad()

func build_toggle() -> void:
	_toggle_build_menu()

func refresh_selected() -> void:
	if selected_building != null:
		_show_building(selected_building)
	if hire_panel.visible and work_target != null:
		_refresh_hire()

func refresh_build_menu() -> void:
	if build_menu.visible:
		_refresh_build_menu()
