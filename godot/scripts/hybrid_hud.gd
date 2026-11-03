class_name ToxHybridHud
extends Control

## HUD гибрида на Control-нодах. Данные — только из снимка сервера
## (towns[owner], постройки, жители), действия — только `POST /api/command`
## через ToxLiveRoom. Ни одного правила игры здесь нет: можно ли ставить дом,
## нанимать, тренировать или приказывать — решает сервер, HUD показывает его
## ответ словами.
##
## Панели: «Стройка» (карточки с ценами из data/constants.json), «Правка»
## (двигать/повернуть/снести/применить/отменить), «Найм» (лагерь лесоруба и
## казарма: 3 места, тренировка 5 с), «Войска» (группы, всех/половина/сброс,
## приказ/стоп), «Деревня» (T: состав, население), «Меню». Плюс миникарта,
## полоса постановки, экран итога и бейдж сети.

const UI = preload("res://scripts/ui_theme.gd")
const Minimap = preload("res://scripts/match_minimap.gd")

var room = null
var demo = null
var snap: Dictionary = {}
var owner_id := 0
var mode := "solo"
var panel := ""
var place_type := ""
var place_name := ""
var place_rot := 90
var selected_id := ""
var selected_villager_id := ""
## Состояние постройки на момент открытия правки: «Отменить» возвращает его,
## а не просто закрывает панель. Применённое сервером уже нельзя откатить
## нажатием — поэтому снимок делается ДО первого действия.
var edit_prev: Dictionary = {}
var move_id := ""
var order_mode := false
var status_text := ""
var buttons: Dictionary = {}
var constants: Dictionary = {}
var _panel_sig_last := ""
var _minimap_cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var _viewport := Vector2(1440, 900)
var _follow := false
var _end_shown := false
# Сеть: транспорт и пинг (в solo/bot бейдж не про сеть).
var net_transport := "none"
var net_ms := -1
var net_host := false
var net_online := false
var net_note := ""
## Поколение панели: асинхронная команда (например, «Отменить» с тремя
## поворотами) не должна закрыть панель, которую игрок уже открыл заново.
var _panel_gen := 0
# Серия домов (buildLine): начало и конец выбираются кликами, число и цена —
# ответ сервера `/api/check kind=line`; правила серии клиент не повторяет.
var line_mode := false
var line_type := ""
var line_variant := "a"
var line_rot := 90
var line_from := Vector2i(-1, -1)
var line_to := Vector2i(-1, -1)
var line_count := 0
var line_cost := 0
var line_ok := false
var line_reason := ""
var line_seq := 0

var _top: PanelContainer
var _top_label: Label
var _events: PanelContainer
var _events_label: Label
var _status: Label
var _bottom: HBoxContainer
var _panel: PanelContainer
var _panel_body: VBoxContainer
var _place_bar: PanelContainer
var _place_label: Label
var _place_state: Label
var _place_rot_btn: Button
var _place_confirm: Button
var _minimap: Control
var _village: PanelContainer
var _village_body: VBoxContainer
var _end: PanelContainer
var _end_body: VBoxContainer
var _badge: Label
var _hint: Label


func _ready() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	theme = UI.theme()
	_load_constants()
	_build_frame()
	resized.connect(_on_resized)
	_on_resized()


func _load_constants() -> void:
	var text := FileAccess.get_file_as_string("res://data/constants.json")
	var data: Variant = JSON.parse_string(text) if text != "" else null
	constants = data if data is Dictionary else {}


func _menu_items() -> Array:
	var items: Array = constants.get("buildMenu", [])
	if items.is_empty():
		# Запасной список — те же числа, что в game/js/play.js. Он нужен только
		# если constants.json не собран; приёмка проверяет именно JSON.
		items = [
			{"type": "house", "variant": "a", "price": 12, "note": "жильё для четверых"},
			{"type": "lumbercamp", "variant": "a", "price": 20, "note": "три рабочих места"},
			{"type": "barracks", "variant": "a", "price": 28, "note": "открытый плац · тренировка"},
			{"type": "warcamp", "variant": "x", "price": 24, "note": "дружина до 20 воинов"},
		]
	return items


func _type_name(type: String) -> String:
	var names: Dictionary = constants.get("names", {})
	if names.has(type):
		return str(names[type])
	for it in _menu_items():
		if str(it["type"]) == type:
			return str(it.get("name", it.get("note", type)))
	return type


func _build_frame() -> void:
	_top = UI.panel(10)
	_top.custom_minimum_size = Vector2(720, 44)
	add_child(_top)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 18)
	_top.add_child(row)
	_top_label = UI.ink_label("Брёвна 0 · Жители 0 · Воины 0", 17)
	row.add_child(_top_label)

	_events = UI.panel(8)
	_events.custom_minimum_size = Vector2(720, 34)
	add_child(_events)
	_events_label = UI.ink_label("событий нет", 14)
	_events_label.add_theme_color_override("font_color", UI.INK_SOFT)
	_events.add_child(_events_label)

	_bottom = HBoxContainer.new()
	_bottom.add_theme_constant_override("separation", 10)
	add_child(_bottom)
	for spec in [["build", "Стройка"], ["edit", "Правка"], ["army", "Войска"],
			["village", "Деревня"], ["menu", "Меню"]]:
		var b := UI.button(str(spec[1]), 16)
		b.custom_minimum_size = Vector2(108, 46)
		b.pressed.connect(func() -> void: toggle_panel(str(spec[0])))
		_bottom.add_child(b)
		buttons[str(spec[1])] = b

	_status = UI.label("", 15, UI.CREAM, 3)
	add_child(_status)

	_hint = UI.label("ЛКМ — выбрать · удержать — правка · колесо — зум · WASD — камера · Esc — меню",
		12, Color(0.94, 0.92, 0.84, 0.8), 2)
	add_child(_hint)

	_panel = UI.panel(14)
	_panel.custom_minimum_size = Vector2(760, 0)
	_panel.visible = false
	add_child(_panel)
	_panel_body = VBoxContainer.new()
	_panel_body.add_theme_constant_override("separation", 8)
	_panel.add_child(_panel_body)

	_place_bar = UI.panel(12)
	_place_bar.custom_minimum_size = Vector2(640, 64)
	_place_bar.visible = false
	add_child(_place_bar)
	var pbox := VBoxContainer.new()
	pbox.add_theme_constant_override("separation", 4)
	_place_bar.add_child(pbox)
	_place_label = UI.ink_label("", 16)
	pbox.add_child(_place_label)
	var prow := HBoxContainer.new()
	prow.add_theme_constant_override("separation", 8)
	pbox.add_child(prow)
	_place_state = UI.ink_label("ведите мышью · ЛКМ — поставить · Esc — отменить", 13)
	_place_state.add_theme_color_override("font_color", UI.INK_SOFT)
	_place_state.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	prow.add_child(_place_state)
	_place_confirm = UI.button("Построить", 13)
	_place_confirm.visible = false
	_place_confirm.pressed.connect(func() -> void: confirm_line())
	prow.add_child(_place_confirm)
	buttons["Построить серию"] = _place_confirm
	_place_rot_btn = UI.button("Повернуть", 13)
	_place_rot_btn.pressed.connect(func() -> void:
		if demo != null:
			demo.rotate_place())
	prow.add_child(_place_rot_btn)
	buttons["Повернуть"] = _place_rot_btn
	var pcancel := UI.button("Отменить", 13)
	pcancel.pressed.connect(func() -> void: cancel_action())
	prow.add_child(pcancel)
	buttons["Отменить"] = pcancel

	_minimap = Minimap.new()
	add_child(_minimap)
	_minimap.cell_clicked.connect(func(cell: Vector2i) -> void:
		if demo != null:
			demo.minimap_to(cell))

	_village = UI.panel(12)
	_village.custom_minimum_size = Vector2(320, 520)
	_village.visible = false
	add_child(_village)
	_village_body = VBoxContainer.new()
	_village_body.add_theme_constant_override("separation", 6)
	_village.add_child(_village_body)

	_badge = UI.label("", 14, UI.CREAM, 3)
	add_child(_badge)

	_end = UI.panel(20)
	_end.visible = false
	add_child(_end)
	_end_body = VBoxContainer.new()
	_end_body.add_theme_constant_override("separation", 10)
	_end.add_child(_end_body)


func _on_resized() -> void:
	_viewport = get_viewport_rect().size
	# Как в браузере: ресурсы сверху слева, действия сверху справа, подсказки
	# снизу слева, обзор снизу справа, события под ресурсами.
	_top.position = Vector2(24, 16)
	_top.size = Vector2(720, 44)
	_events.position = Vector2(24, 66)
	_events.size = Vector2(720, 34)
	_bottom.position = Vector2(_viewport.x - 604, 16)
	_status.position = Vector2(24, _viewport.y - 58)
	_status.size = Vector2(760, 24)
	_hint.position = Vector2(24, _viewport.y - 30)
	_hint.size = Vector2(900, 20)
	_panel.position = Vector2(_viewport.x * 0.5 - 380, 120)
	_place_bar.position = Vector2(_viewport.x * 0.5 - 320, _viewport.y - 190)
	_minimap.position = Vector2(_viewport.x - 216, _viewport.y - 192)
	_minimap.size = Vector2(196, 168)
	_village.position = Vector2(16, 110)
	_village.size = Vector2(330, 520)
	_badge.position = Vector2(_viewport.x - 216, _viewport.y - 216)
	_end.position = Vector2(_viewport.x * 0.5 - 300, _viewport.y * 0.5 - 150)
	_end.size = Vector2(600, 300)
	_panel_sig_last = ""


# ------------------------------------------------------------------ данные

func reset() -> void:
	snap = {}
	panel = ""
	place_type = ""
	place_name = ""
	selected_id = ""
	selected_villager_id = ""
	move_id = ""
	order_mode = false
	edit_prev = {}
	status_text = ""
	buttons.clear()
	_panel_sig_last = ""
	_end_shown = false
	if _panel != null:
		_panel.visible = false
		_clear(_panel_body)
	if _place_bar != null:
		_place_bar.visible = false
	if _village != null:
		_village.visible = false
	if _end != null:
		_end.visible = false


func set_mode(m: String) -> void:
	mode = m


func on_snapshot(s: Dictionary) -> void:
	snap = s
	if _minimap != null and demo != null:
		_minimap.set_world(demo.get("_world"))
		var colors: Array = []
		for t in s.get("towns", []):
			colors.append(str(t.get("color", "#4a90d9")))
		_minimap.set_snapshot(s.get("buildings", []), s.get("villagers", []), colors)
	_check_end()
	refresh()


func set_player_owner(o: int) -> void:
	owner_id = o
	refresh()


func set_zoom(z: float) -> void:
	_minimap_cam["zoom"] = z


func set_minimap_camera(x: float, y: float, z: float, viewport: Vector2) -> void:
	_minimap_cam = {"x": x, "y": y, "zoom": z}
	if _minimap != null:
		_minimap.set_camera(x, y, z, viewport)


func set_net_note(text: String) -> void:
	net_note = text
	if _badge != null:
		refresh()


func set_net(transport: String, ms: int, host: bool, online: bool) -> void:
	net_transport = transport
	net_ms = ms
	net_host = host
	net_online = online
	if _badge != null:
		refresh()


func set_follow(v: bool) -> void:
	_follow = v
	refresh()


func _town() -> Dictionary:
	var towns: Array = snap.get("towns", [])
	if owner_id >= 0 and owner_id < towns.size():
		return towns[owner_id]
	return {}


func _villagers_of_mine() -> Array:
	var out: Array = []
	for v in snap.get("villagers", []):
		if int(v.get("owner", 0)) != owner_id:
			continue
		if bool(v.get("dead", false)):
			continue
		out.append(v)
	return out


func _counts() -> Dictionary:
	var villagers := 0
	var warriors := 0
	var trainees := 0
	var workers := 0
	for v in _villagers_of_mine():
		if bool(v.get("hidden", false)):
			continue
		if bool(v.get("warrior", false)):
			warriors += 1
		elif bool(v.get("trainee", false)):
			trainees += 1
		else:
			villagers += 1
			if str(v.get("employerId", "")) != "":
				workers += 1
	return {"villagers": villagers, "warriors": warriors, "trainees": trainees,
		"workers": workers}


func refresh() -> void:
	if _top_label == null:
		return
	var t := _town()
	var c := _counts()
	var logs := int(t.get("logs", 0))
	var felled := int(t.get("felled", 0))
	var delivered := int(t.get("deliveries", 0))
	var lost := int(t.get("lost", 0))
	_top_label.text = "Брёвна %d · Жители %d · Воины %d · Учатся %d · Срублено %d · Доставлено %d" % [
		logs, int(c["villagers"]) + int(c["trainees"]), c["warriors"], c["trainees"],
		felled, delivered]
	var mode_text := "одиночная партия"
	if mode == "bot":
		mode_text = "против деревни"
	elif mode == "multi":
		mode_text = "сетевая партия"
	_events_label.text = ("Ответ: " + status_text) if status_text != "" else \
		("потеряно брёвен %d · кадр №%d · %s" % [lost, int(snap.get("revision", 0)),
			mode_text])
	if _badge != null:
		if mode == "multi":
			if not net_online:
				_badge.text = "нет связи"
				_badge.add_theme_color_override("font_color", Color("#ffb4a2"))
			else:
				var role := "хост" if net_host else "гость"
				var tr := net_transport if net_transport != "none" else "…"
				var ping := (" · %d мс" % net_ms) if net_ms >= 0 else ""
				var note := (" · " + net_note) if net_note != "" else ""
				_badge.text = "%s · %s%s%s" % [role, tr, ping, note]
				_badge.add_theme_color_override("font_color", UI.CREAM)
		else:
			_badge.text = "" if mode == "solo" else ("локальный сервер · %s" % mode)
	_update_place_bar()
	if panel != "":
		var sig := _panel_sig(logs, c)
		if sig != _panel_sig_last:
			_panel_sig_last = sig
			_fill_current(logs, c)
	if _village.visible:
		_fill_village()
	if demo != null:
		var fx: Variant = demo.get("_fx")
		if fx != null:
			var fp := Vector2i(0, 0)
			var layer: Variant = demo.get("_layer")
			if selected_id != "" and layer != null and layer.bdata != null:
				var b: Dictionary = demo.building_by_id(selected_id)
				if not b.is_empty():
					var f: Dictionary = layer.bdata.frame_for(str(b.get("type", "townhall")),
						str(b.get("variant", "a")), int(b.get("rot", 0)))
					if not f.is_empty():
						var a: Array = f["fp"]
						fp = Vector2i(int(a[0]), int(a[1]))
			fx.selected_building = selected_id
			fx.footprint = fp


func _panel_sig(logs: int, c: Dictionary) -> String:
	return "%s|%d|%s|%s|%d|%d|%d|%d" % [panel, logs, selected_id, selected_villager_id,
		int(c["villagers"]), int(c["warriors"]), int(c["trainees"]), int(c["workers"])]


# ------------------------------------------------------------------ панели

func toggle_panel(name: String) -> void:
	if panel == name:
		close_panel()
		return
	open_panel(name)


func open_panel(name: String) -> void:
	_panel_gen += 1
	panel = name
	order_mode = false
	if name == "village":
		_village.visible = true
		_fill_village()
		refresh()
		return
	if name == "hire":
		pass
	_panel.visible = true
	_village.visible = false
	_panel_sig_last = ""
	refresh()


func close_panel() -> void:
	edit_prev = {}
	panel = ""
	place_type = ""
	place_name = ""
	move_id = ""
	order_mode = false
	if _panel != null:
		_panel.visible = false
		_clear(_panel_body)
	if _place_bar != null:
		_place_bar.visible = false
	if _village != null:
		_village.visible = false
	if demo != null:
		demo.set_place_hint("", place_rot)
		demo.set_order_marker(Vector2i(-1, -1))


## Немедленное удаление детей: queue_free() оставляет их в дереве до конца
## кадра, а `get_combined_minimum_size()` уже в этом кадре считает панель по
## СТАРОМУ содержимому — панель правки раздувалась до размера меню стройки.
func _clear(node: Node) -> void:
	for c in node.get_children():
		node.remove_child(c)
		c.queue_free()


func _title(text: String) -> void:
	_panel_body.add_child(UI.ink_label(text, 18))


## Кнопки прошлой панели удаляются вместе с панелью, но ссылки в `buttons`
## остались бы — и `press()`/тест жали бы уже освобождённый объект. Чистим
## карту перед каждой пересборкой.
func _prune_buttons() -> void:
	for k in buttons.keys():
		var b: Variant = buttons[k]
		if b == null or not is_instance_valid(b) or (b as Node).is_queued_for_deletion() \
				or not (b as Node).is_inside_tree():
			buttons.erase(k)


func _fill_current(logs: int, c: Dictionary) -> void:
	_clear(_panel_body)
	_prune_buttons()
	match panel:
		"build": _fill_build(logs)
		"edit": _fill_edit()
		"hire": _fill_hire()
		"army": _fill_army(c)
		"menu": _fill_menu()
	_panel.reset_size()
	_panel.position.y = maxf(110.0, _bottom.position.y - 12.0 - _panel.size.y)


func _fill_build(logs: int) -> void:
	_title("Постройки · брёвен %d" % logs)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	_panel_body.add_child(row)
	for item in _menu_items():
		var card := UI.panel(8)
		card.custom_minimum_size = Vector2(180, 132)
		var col := VBoxContainer.new()
		col.add_theme_constant_override("separation", 2)
		card.add_child(col)
		col.add_child(UI.ink_label(_type_name(str(item["type"])), 15))
		col.add_child(UI.ink_label("%d брёвен" % int(item["price"]), 14))
		var note := UI.ink_label(str(item.get("note", "")), 12)
		note.add_theme_color_override("font_color", UI.INK_SOFT)
		note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		note.custom_minimum_size = Vector2(160, 0)
		col.add_child(note)
		var b := UI.button("Построить", 14)
		b.disabled = logs < int(item["price"])
		b.pressed.connect(func() -> void: begin_place(str(item["type"]), _type_name(str(item["type"]))))
		col.add_child(b)
		buttons["Построить " + str(item["type"])] = b
		var line := UI.button("Серия", 12)
		line.disabled = logs < int(item["price"]) * 2
		line.pressed.connect(func() -> void: begin_line(str(item["type"])))
		col.add_child(line)
		buttons["Серия " + str(item["type"])] = line
		row.add_child(card)
	_panel_body.add_child(UI.ink_label(
		"Стройка тратит брёвна: их приносят лесорубы из лагеря.", 12))


func _fill_edit() -> void:
	var name := _sel_name()
	_title(("Правка · " + name) if selected_id != "" else "Правка · выберите постройку")
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	_panel_body.add_child(row)
	for spec in [["Двигать", "move"], ["Повернуть", "rotate"], ["Снести", "delete"]]:
		var b := UI.button(str(spec[0]), 14)
		b.disabled = selected_id == ""
		b.pressed.connect(func() -> void: edit_action(str(spec[1])))
		buttons[str(spec[0])] = b
		row.add_child(b)
	var apply := UI.button("Применить", 14)
	apply.disabled = selected_id == ""
	apply.pressed.connect(func() -> void: close_panel())
	buttons["Применить"] = apply
	row.add_child(apply)
	var cancel := UI.button("Отменить", 14)
	cancel.pressed.connect(func() -> void: edit_cancel())
	buttons["Отменить правку"] = cancel
	row.add_child(cancel)
	_panel_body.add_child(UI.ink_label(
		"сервер проверяет место и выходы соседей; отказ придёт словами", 12))


func _camp_name(b: Dictionary) -> String:
	var slots := 0
	if str(b.get("type", "")) == "barracks":
		slots = _train_slots()
	else:
		slots = _work_slots(str(b.get("type", "")))
	return "%s · %d" % [_type_name(str(b.get("type", ""))), slots]


func _fill_hire() -> void:
	var camp: Dictionary = _selected_camp()
	if camp.is_empty():
		_title("Найм · выберите лагерь или казарму")
		return
	var c := _counts()
	var train := str(camp.get("type", "")) == "barracks"
	var slots := _train_slots() if train else _work_slots(str(camp.get("type", "")))
	var here := _workers_at(camp)
	var title := ""
	if train:
		title = "%s · воины %d · тренируются %d / %d" % [_type_name("barracks"),
			c["warriors"], here.size(), slots]
	else:
		title = "%s · работники %d / %d" % [_type_name(str(camp.get("type", ""))),
			here.size(), slots]
	_title(title)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	_panel_body.add_child(row)
	if train:
		var all := UI.button("Тренировать свободных", 14)
		all.pressed.connect(func() -> void: batch("train"))
		buttons["Тренировать свободных"] = all
		row.add_child(all)
	else:
		var all := UI.button("Нанять свободных", 14)
		all.pressed.connect(func() -> void: batch("hire"))
		buttons["Нанять свободных"] = all
		row.add_child(all)
		var fire_all := UI.button("Распустить всех", 14)
		fire_all.pressed.connect(func() -> void: batch("fire"))
		buttons["Распустить всех"] = fire_all
		row.add_child(fire_all)
	var close := UI.button("Закрыть", 14)
	close.pressed.connect(func() -> void: close_panel())
	buttons["Закрыть"] = close
	row.add_child(close)
	# Строки: кто здесь и кто свободен. Причина отказа не решается здесь —
	# кнопка ведёт к серверу, а он отвечает словами.
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(720, 220)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_panel_body.add_child(scroll)
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	list.add_theme_constant_override("separation", 4)
	scroll.add_child(list)
	var free: Array = []
	for v in _villagers_of_mine():
		if bool(v.get("hidden", false)) or bool(v.get("warrior", false)) or bool(v.get("trainee", false)):
			continue
		if str(v.get("employerId", "")) != "":
			continue
		free.append(v)
	if free.is_empty():
		list.add_child(UI.ink_label("свободных жителей нет", 13))
	for v in free:
		var r := HBoxContainer.new()
		r.add_theme_constant_override("separation", 8)
		list.add_child(r)
		var label := UI.ink_label("житель %s" % _short_id(v), 14)
		label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		r.add_child(label)
		var act := "Тренировать" if train else "Нанять"
		var b := UI.button(act, 13)
		b.pressed.connect(func() -> void: one_action(act.to_lower(), str(v.get("id", ""))))
		buttons[act + " " + str(v.get("id", ""))] = b
		r.add_child(b)
	for v in here:
		var r2 := HBoxContainer.new()
		r2.add_theme_constant_override("separation", 8)
		list.add_child(r2)
		var t := "воин" if bool(v.get("warrior", false)) else (
			"учится" if bool(v.get("trainee", false)) else "работает")
		var l2 := UI.ink_label("житель %s · %s" % [_short_id(v), t], 14)
		l2.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		r2.add_child(l2)
		if not train:
			var f := UI.button("Уволить", 13)
			f.pressed.connect(func() -> void: one_action("fire", str(v.get("id", ""))))
			buttons["Уволить " + str(v.get("id", ""))] = f
			r2.add_child(f)


func _fill_army(c: Dictionary) -> void:
	_title("Войска · воинов %d" % c["warriors"])
	var ids: Array = []
	for v in _villagers_of_mine():
		if bool(v.get("warrior", false)) and int(v.get("hp", 1)) > 0:
			ids.append(str(v.get("id", "")))
	var groups := _army_groups()
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	_panel_body.add_child(row)
	for g in groups:
		var b := UI.button("%s · %d" % [str(g["name"]), (g["ids"] as Array).size()], 13)
		b.pressed.connect(func() -> void: pick_group(g["ids"]))
		buttons["Группа " + str(g["name"])] = b
		row.add_child(b)
		var half := UI.button("½ группы", 13)
		half.pressed.connect(func() -> void: pick_group((g["ids"] as Array).slice(
			0, maxi(1, (g["ids"] as Array).size() / 2))))
		buttons["½ группы " + str(g["name"])] = half
		row.add_child(half)
		var focus := UI.button("К лагерю", 13)
		focus.pressed.connect(func() -> void: demo.focus_building(str(g.get("campId", ""))))
		focus.disabled = str(g.get("campId", "")) == ""
		row.add_child(focus)
	if groups.is_empty():
		row.add_child(UI.ink_label("дружины пока нет", 14))
	var row2 := HBoxContainer.new()
	row2.add_theme_constant_override("separation", 8)
	_panel_body.add_child(row2)
	var all := UI.button("Всех", 14)
	all.pressed.connect(func() -> void: pick_group(ids))
	buttons["Всех"] = all
	row2.add_child(all)
	var half_all := UI.button("Половина", 14)
	half_all.pressed.connect(func() -> void: pick_group(ids.slice(0, maxi(1, ids.size() / 2))))
	buttons["Половина"] = half_all
	row2.add_child(half_all)
	var reset := UI.button("Сброс", 14)
	reset.pressed.connect(func() -> void: pick_group([]))
	buttons["Сброс"] = reset
	row2.add_child(reset)
	var order := UI.button("Приказ", 14)
	order.disabled = ids.is_empty()
	order.pressed.connect(func() -> void: begin_order())
	buttons["Приказ"] = order
	row2.add_child(order)
	var stop := UI.button("Стоп", 14)
	stop.disabled = ids.is_empty()
	stop.pressed.connect(func() -> void: stop_army(ids))
	buttons["Стоп"] = stop
	row2.add_child(stop)
	var sel: Array = demo.army_selection() if demo != null else []
	_panel_body.add_child(UI.ink_label(
		"Выбрано %d · «Половина» — половина всех, «½ группы» — половина одной. «Приказ» — затем клик по карте." % sel.size(), 12))


func _fill_menu() -> void:
	_title("Меню · игра не останавливается")
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	_panel_body.add_child(row)
	var cont := UI.button("Продолжить", 15)
	cont.pressed.connect(func() -> void: close_panel())
	buttons["Продолжить"] = cont
	row.add_child(cont)
	var again := UI.button("Новый остров", 15)
	again.pressed.connect(func() -> void: restart())
	buttons["Новый остров"] = again
	row.add_child(again)
	var out := UI.button("В главное меню", 15)
	out.pressed.connect(func() -> void: leave())
	buttons["В главное меню"] = out
	row.add_child(out)
	_panel_body.add_child(UI.ink_label(
		"Время мира идёт: сервер продолжает считать, пока меню открыто. Esc — закрыть.", 12))


func _fill_village() -> void:
	_clear(_village_body)
	_prune_buttons()
	var t := _town()
	var c := _counts()
	var houses := 0
	for b in snap.get("buildings", []):
		if int(b.get("owner", 0)) == owner_id and str(b.get("type", "")) == "house" \
				and not bool(b.get("rubble", false)):
			houses += 1
	_village_body.add_child(UI.ink_label("Деревня", 18))
	_village_body.add_child(UI.ink_label("остров %d × %d · сид %s" % [
		int(snap.get("size", 0)), int(snap.get("size", 0)), str(snap.get("seed", "—"))], 12))
	_village_body.add_child(UI.ink_label("брёвна %d · срублено %d · доставлено %d · потеряно %d" % [
		int(t.get("logs", 0)), int(t.get("felled", 0)), int(t.get("deliveries", 0)),
		int(t.get("lost", 0))], 12))
	_village_body.add_child(UI.ink_label("население %d · домов %d · жильё %d" % [
		int(c["villagers"]) + int(c["trainees"]) + int(c["warriors"]), houses, houses * 4], 12))
	_village_body.add_child(UI.hsep(4))
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(300, 330)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_village_body.add_child(scroll)
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	list.add_theme_constant_override("separation", 2)
	scroll.add_child(list)
	for v in _villagers_of_mine():
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 6)
		list.add_child(row)
		var state := _villager_state(v)
		var b := UI.button("житель %s · %s" % [_short_id(v), state], 12)
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.pressed.connect(func() -> void: select_villager(v))
		row.add_child(b)
	var brow := HBoxContainer.new()
	brow.add_theme_constant_override("separation", 6)
	_village_body.add_child(brow)
	var foc := UI.button("К жителю (H)", 12)
	foc.pressed.connect(func() -> void: demo.focus_selected())
	brow.add_child(foc)
	var fol := UI.button("Следить (C)", 12)
	fol.pressed.connect(func() -> void: demo.toggle_follow())
	buttons["Следить (C)"] = fol
	brow.add_child(fol)


func _villager_state(v: Dictionary) -> String:
	if bool(v.get("hidden", false)) or float(v.get("vanishT", 0.0)) > 0.0:
		return "растворяется"
	if bool(v.get("warrior", false)):
		return "воин"
	if bool(v.get("trainee", false)):
		return "учится"
	if bool(v.get("carrying", false)):
		return "несёт бревно"
	if str(v.get("employerId", "")) != "":
		return "лесоруб"
	if int(v.get("hp", 1)) <= 0:
		return "мёртв"
	return "житель"


func _short_id(v: Dictionary) -> String:
	var id := str(v.get("id", ""))
	var parts := id.split(":")
	if parts.size() > 1:
		return parts[parts.size() - 1]
	return id


func _sel_name() -> String:
	if demo == null or selected_id == "":
		return selected_id
	var b: Dictionary = demo.building_by_id(selected_id)
	if b.is_empty():
		return selected_id
	return _type_name(str(b.get("type", "")))


func _selected_camp() -> Dictionary:
	if demo == null or selected_id == "":
		return {}
	var b: Dictionary = demo.building_by_id(selected_id)
	if b.is_empty():
		return {}
	var type := str(b.get("type", ""))
	if type == "lumbercamp" or type == "barracks":
		return b
	return {}


func _work_slots(type: String) -> int:
	var slots: Dictionary = constants.get("slots", {}).get("work", {})
	var n: Variant = slots.get(type, 0)
	return int(n) if n != null else 0


func _train_slots() -> int:
	var slots: Dictionary = constants.get("slots", {}).get("training", {})
	var n: Variant = slots.get("barracks", 0)
	return int(n) if n != null else 0


func _workers_at(camp: Dictionary) -> Array:
	var out: Array = []
	var type := str(camp.get("type", ""))
	for v in _villagers_of_mine():
		if type == "barracks":
			if bool(v.get("trainee", false)) and str(v.get("trainingId", "")) == str(camp.get("id", "")):
				out.append(v)
		elif str(v.get("employerId", "")) == str(camp.get("id", "")):
			out.append(v)
	return out


func _army_groups() -> Array:
	var by: Dictionary = {}
	for v in _villagers_of_mine():
		if not bool(v.get("warrior", false)):
			continue
		var cid := str(v.get("campId", ""))
		if cid == "":
			cid = "без лагеря"
		var g: Dictionary = by.get(cid, {"name": "", "ids": [], "campId": cid})
		if str(g["name"]) == "":
			g["name"] = _type_name("warcamp") if cid != "без лагеря" else "без лагеря"
		(g["ids"] as Array).append(str(v.get("id", "")))
		by[cid] = g
	return by.values()


func _update_place_bar() -> void:
	if _place_bar == null:
		return
	if line_mode:
		_place_bar.visible = true
		_place_label.text = "%s × %d · %d брёвен · поворот %d°" % [
			_type_name(line_type), line_count, line_cost, line_rot]
		_place_state.text = ("место годится" if line_ok else line_reason) \
			if line_to.x >= 0 else "ЛКМ — конец серии · построить · Esc — отмена"
		_place_confirm.visible = true
		_place_bar.custom_minimum_size = Vector2(680, 100)
		return
	if _place_confirm != null:
		_place_confirm.visible = false
	if place_type == "":
		_place_bar.visible = false
		return
	_place_bar.visible = true
	var item := _menu_item(place_type)
	_place_label.text = "%s · %d брёвен · поворот %d°" % [place_name,
		int(item.get("price", 0)), place_rot]
	_place_state.text = "ведите мышью · ЛКМ — поставить · Esc — отменить"
	_place_bar.custom_minimum_size = Vector2(640, 100)


# ---------------------------------------------------------------- действия

## Серия: первый клик карточки «Серия» задаёт начало под курсором, клики по
## карте двигают конец, «Построить» отправляет одну атомарную команду.
func begin_line(type: String) -> void:
	if demo == null:
		return
	_end_line()
	close_panel()
	line_mode = true
	line_type = type
	line_variant = "x" if type == "warcamp" else "a"
	line_rot = 90
	line_from = demo._hover_cell
	line_to = line_from
	line_count = 0
	line_cost = 0
	line_ok = false
	line_reason = "наведите на конец серии"
	status_text = "серия %s: ЛКМ по карте — конец, «Построить» — вся серия" % _type_name(type)
	_update_place_bar()
	refresh()
	await _request_line()


func _end_line() -> void:
	line_mode = false
	line_type = ""
	line_from = Vector2i(-1, -1)
	line_to = Vector2i(-1, -1)
	line_count = 0
	line_cost = 0
	line_ok = false
	line_reason = ""
	if _place_confirm != null:
		_place_confirm.visible = false
	if _place_bar != null:
		_place_bar.visible = false
	if demo != null:
		demo.set_place_hint("", place_rot)


func _request_line() -> void:
	if not line_mode or room == null or line_from.x < 0 or line_to.x < 0:
		return
	line_seq += 1
	var seq := line_seq
	var r: Dictionary = await room.check_place("line", {
		"buildingType": line_type, "variant": line_variant, "rot": line_rot,
		"x": line_from.x, "y": line_from.y, "x2": line_to.x, "y2": line_to.y})
	if seq != line_seq or not line_mode:
		return
	line_ok = bool(r.get("ok", false))
	line_count = int(r.get("count", 0))
	line_cost = int(r.get("cost", 0))
	line_reason = str(r.get("reason", ""))
	_update_place_bar()


func confirm_line() -> void:
	if not line_mode or room == null:
		return
	if not line_ok:
		status_text = "серия: " + (line_reason if line_reason != "" else "место не годится")
		refresh()
		return
	var payload := {"buildingType": line_type, "variant": line_variant, "rot": line_rot,
		"x": line_from.x, "y": line_from.y, "x2": line_to.x, "y2": line_to.y}
	var n := line_count
	_end_line()
	status_text = "серия: %d домов…" % n
	refresh()
	var r: Dictionary = await room.send_command("buildLine", payload)
	_after_command("серия", r)


func begin_place(type: String, name: String) -> void:
	_end_line()
	close_panel()
	place_type = type
	place_name = name
	place_rot = 90
	move_id = ""
	selected_id = ""
	# Панель закрыта, но действие «в руке»: panel НЕ "build", иначе первый же
	# клик по «Стройке» закрывал бы её вместо открытия (toggle).
	panel = ""
	status_text = ""
	if demo != null:
		demo.set_place_hint(type, place_rot)
	_update_place_bar()
	refresh()


func set_place_state(text: String) -> void:
	if _place_state != null:
		_place_state.text = text


func rotate_place(rot: int) -> void:
	place_rot = rot
	_update_place_bar()


func begin_order() -> void:
	close_panel()
	order_mode = true
	panel = ""
	_status.text = "клик по карте — приказ выбранным воинам, ПКМ/Esc — отмена"
	refresh()


func cancel_action() -> void:
	if line_mode:
		_end_line()
		status_text = "серия отменена"
		refresh()
		return
	if place_type != "":
		place_type = ""
		place_name = ""
		status_text = "постановка отменена"
		if demo != null:
			demo.set_place_hint("", place_rot)
		_update_place_bar()
		_panel_sig_last = ""
		refresh()
		return
	if move_id != "":
		move_id = ""
		status_text = "перенос отменён"
		refresh()
		return
	if order_mode:
		order_mode = false
		status_text = "приказ отменён"
		if demo != null:
			demo.set_order_marker(Vector2i(-1, -1))
		refresh()
		return
	if panel != "":
		close_panel()


func clear_selection() -> void:
	selected_id = ""
	selected_villager_id = ""
	move_id = ""
	order_mode = false
	if demo != null:
		demo.set_selected("")
		demo.set_selected_villager("")
		demo.set_order_marker(Vector2i(-1, -1))
	if panel == "edit" or panel == "hire":
		close_panel()
	else:
		refresh()


func select(id: String) -> void:
	selected_id = id
	selected_villager_id = ""
	move_id = ""
	if demo != null:
		var b: Dictionary = demo.building_by_id(id)
		if not b.is_empty():
			edit_prev = {"id": id, "x": int(b.get("x", 0)),
				"y": int(b.get("y", 0)), "rot": int(b.get("rot", 0))}
	open_panel("edit")
	_panel_sig_last = ""
	refresh()


func select_building(b: Dictionary) -> void:
	selected_id = str(b.get("id", ""))
	edit_prev = {"id": selected_id, "x": int(b.get("x", 0)), "y": int(b.get("y", 0)),
		"rot": int(b.get("rot", 0))}
	selected_villager_id = ""
	move_id = ""
	var type := str(b.get("type", ""))
	if (type == "lumbercamp" or type == "barracks") and not bool(b.get("rubble", false)):
		panel = "hire"
		_panel.visible = true
		_village.visible = false
		_panel_sig_last = ""
		refresh()
		return
	open_panel("edit")
	_panel_sig_last = ""
	refresh()


func select_villager(v: Dictionary) -> void:
	selected_villager_id = str(v.get("id", ""))
	selected_id = ""
	_village.visible = true
	_fill_village()
	refresh()


func pick_group(ids: Array) -> void:
	if demo != null:
		demo.set_army_selection(ids)
	_panel_sig_last = ""
	refresh()


func edit_action(kind: String) -> void:
	if selected_id == "" or room == null:
		return
	if kind == "move":
		# close_panel() сбрасывает move_id и снимок для «Отменить», поэтому
		# порядок важен: запоминаем, закрываем, возвращаем снимок.
		var id := selected_id
		var keep: Dictionary = edit_prev.duplicate()
		close_panel()
		edit_prev = keep
		move_id = id
		panel = ""
		_status.text = "клик по карте — новое место постройки, ПКМ/Esc — отмена"
		return
	var act := "rotate" if kind == "rotate" else "delete"
	status_text = "команда: %s…" % act
	refresh()
	var r: Dictionary = await room.send_command("edit", {"action": act, "id": selected_id})
	_after_command("правка", r)
	if kind == "delete" and bool(r.get("ok", false)):
		clear_selection()


## Показать панель правки для уже выбранной постройки, не сбрасывая снимок
## «Отменить» (в отличие от select_building).
func _reopen_edit(id: String) -> void:
	if demo == null or demo.building_by_id(id).is_empty():
		return
	_panel_gen += 1
	selected_id = id
	panel = "edit"
	_panel.visible = true
	_village.visible = false
	_panel_sig_last = ""
	refresh()


func edit_cancel() -> void:
	var gen := _panel_gen
	if selected_id == "" or room == null:
		close_panel()
		return
	# Отмена возвращает состояние на момент ОТКРЫТИЯ правки: место и поворот.
	# Действия уже применены сервером, поэтому откат — это обратные команды
	# (поворот только +90°, поэтому считаем, сколько шагов до прошлого угла).
	var b: Dictionary = demo.building_by_id(selected_id) if demo != null else {}
	var prev := edit_prev
	if b.is_empty() or prev.is_empty() or str(prev.get("id", "")) != selected_id:
		close_panel()
		return
	var r: Dictionary = {}
	if int(b.get("x", 0)) != int(prev["x"]) or int(b.get("y", 0)) != int(prev["y"]):
		r = await room.send_command("edit", {"action": "move", "id": selected_id,
			"x": int(prev["x"]), "y": int(prev["y"])})
	# posmod, а не %: у GDScript остаток сохраняет знак делимого, и
	# (90 - 180) % 360 = -90 давал range(-1) — ни одной обратной команды.
	var diff := posmod(int(prev["rot"]) - int(b.get("rot", 0)), 360)
	var steps := int(round(float(diff) / 90.0)) % 4
	for i in range(steps):
		r = await room.send_command("edit", {"action": "rotate", "id": selected_id})
	_after_command("отмена", r)
	if _panel_gen == gen:
		close_panel()


func one_action(kind: String, vid: String) -> void:
	var camp: Dictionary = _selected_camp()
	if camp.is_empty() or room == null:
		return
	var act := "train" if kind == "train" else ("fire" if kind == "fire" else "hire")
	status_text = "%s…" % ("тренируем" if act == "train" else ("увольняем" if act == "fire" else "нанимаем"))
	refresh()
	# id жителя — ЧИСЛО: сервер сравнивает его строго (`===`), и строка "1"
	# не нашла бы жителя 1. В браузере id приходит числом; в двоичном кадре
	# Godot тоже число, но в текст кнопки он уже попал строкой.
	var r: Dictionary = await room.send_command(act, {
		"campId": str(camp.get("id", "")), "villagerId": int(vid)})
	_after_command("наём", r)


func batch(kind: String) -> void:
	var camp: Dictionary = _selected_camp()
	if camp.is_empty() or room == null:
		return
	var act := "train" if kind == "train" else ("fire" if kind == "fire" else "hire")
	var slots := _train_slots() if act == "train" else _work_slots(str(camp.get("type", "")))
	var here := _workers_at(camp)
	var want := maxi(0, slots - here.size()) if act != "fire" else here.size()
	var targets: Array = []
	if act == "fire":
		for v in here:
			targets.append(str(v.get("id", "")))
	else:
		for v in _villagers_of_mine():
			if targets.size() >= want:
				break
			if bool(v.get("hidden", false)) or bool(v.get("warrior", false)) or bool(v.get("trainee", false)):
				continue
			if str(v.get("employerId", "")) != "":
				continue
			targets.append(str(v.get("id", "")))
	if targets.is_empty():
		status_text = "некому: свободных мест нет или все заняты"
		refresh()
		return
	var label := "наём" if act == "hire" else ("тренировка" if act == "train" else "роспуск")
	status_text = "%s: 0 / %d…" % [label, targets.size()]
	refresh()
	var done := 0
	var last_reason := ""
	for vid in targets:
		var r: Dictionary = await room.send_command(act, {
			"campId": str(camp.get("id", "")), "villagerId": int(vid)})
		if bool(r.get("ok", false)):
			done += 1
		else:
			last_reason = str(r.get("reason", r.get("state", "")))
	status_text = "%s: применено %d / %d%s" % [label, done, targets.size(),
		(" · " + last_reason) if last_reason != "" else ""]
	refresh()


func stop_army(ids: Array) -> void:
	if room == null:
		return
	var sel: Array = demo.army_selection() if demo != null else ids
	var r: Dictionary = await room.send_command("stop", {"ids": sel})
	_after_command("стоп", r)


func restart() -> void:
	if demo != null:
		demo.new_island()


func leave() -> void:
	if demo != null:
		demo.closed.emit()


func _after_command(label: String, r: Dictionary) -> void:
	var st := str(r.get("state", "?"))
	var reason := str(r.get("reason", ""))
	if bool(r.get("ok", false)):
		status_text = "%s: применено" % label
	else:
		status_text = "%s: %s%s" % [label, st, (" · " + reason) if reason != "" else ""]
	if _status != null:
		_status.text = status_text
	_panel_sig_last = ""
	refresh()


# ------------------------------------------------------------ клик по карте

## Клик по карте из демо. Возвращает true, если клик был действием HUD.
func map_click(cell: Vector2i) -> bool:
	if line_mode:
		if line_from.x < 0:
			line_from = cell
		line_to = cell
		await _request_line()
		return true
	if place_type != "":
		if room == null:
			status_text = "нет комнаты"
			refresh()
			return true
		var item := _menu_item(place_type)
		var type := place_type
		var rot := place_rot
		place_type = ""
		place_name = ""
		status_text = "строим…"
		if demo != null:
			demo.set_place_hint("", rot)
		_update_place_bar()
		refresh()
		var r: Dictionary = await room.send_command("build", {
			"buildingType": type, "variant": str(item.get("variant", "a")),
			"rot": rot, "x": cell.x, "y": cell.y})
		_after_command("постройка", r)
		return true
	if move_id != "":
		var id := move_id
		move_id = ""
		status_text = "переносим…"
		var r: Dictionary = await room.send_command("edit", {
			"action": "move", "id": id, "x": cell.x, "y": cell.y})
		_after_command("перенос", r)
		# Перенос не закрывает правку: «Применить»/«Отменить» должны остаться,
		# иначе отменить перенос нечем (снимок edit_prev уже потерян бы).
		_reopen_edit(id)
		return true
	if order_mode:
		var ids: Array = demo.army_selection() if demo != null else []
		order_mode = false
		status_text = "приказ…"
		if demo != null:
			demo.set_order_marker(cell)
		var r: Dictionary = await room.send_command("order", {
			"ids": ids, "x": cell.x, "y": cell.y})
		_after_command("приказ", r)
		return true
	return false


func wants_map() -> bool:
	return line_mode or place_type != "" or move_id != "" or order_mode


func _menu_item(type: String) -> Dictionary:
	for it in _menu_items():
		if str(it["type"]) == type:
			return it
	return {}


# -------------------------------------------------------------------- итог

func _check_end() -> void:
	if _end == null:
		return
	var over := bool(snap.get("over", false))
	var wv: Variant = snap.get("winner", -1)
	var winner := -1 if wv == null else int(wv)
	var mine := _town()
	var fallen := bool(snap.get("over", false)) and not bool(mine.get("alive", true))
	if not over:
		return
	if _end_shown and over:
		return
	_end_shown = true
	_clear(_end_body)
	var win := winner == owner_id
	var title := "Победа" if win else "Поражение"
	var t := UI.ink_label(title, 34)
	t.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_end_body.add_child(t)
	var t2 := _town()
	var text := "Брёвен: %d · срублено: %d · доставлено: %d" % [
		int(t2.get("logs", 0)), int(t2.get("felled", 0)), int(t2.get("deliveries", 0))]
	var l := UI.ink_label(text, 15)
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_end_body.add_child(l)
	if fallen and not win:
		var l2 := UI.ink_label("Ратуша пала. Матч окончен.", 13)
		l2.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_end_body.add_child(l2)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 12)
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	_end_body.add_child(row)
	var again := UI.button("Новый остров", 18)
	again.custom_minimum_size = Vector2(200, 50)
	again.pressed.connect(func() -> void: restart())
	_end_body.add_child(again)
	var out := UI.button("В меню", 18)
	out.custom_minimum_size = Vector2(200, 50)
	out.pressed.connect(func() -> void: leave())
	_end_body.add_child(out)
	_end.visible = true


# ------------------------------------------------------------------- тесты

## Всё, что проверяет структурная приёмка: панель, тексты, кнопки, данные.
func state() -> Dictionary:
	var names: Array = []
	for k in buttons:
		names.append(str(k))
	names.sort()
	return {
		"panel": panel,
		"top": _top_label.text,
		"events": _events_label.text,
		"status": _status.text,
		"buttons": names,
		"place": place_type,
		"selected": selected_id,
		"villager": selected_villager_id,
		"order": order_mode,
		"visible": _panel.visible,
		"village": _village.visible,
		"place_bar": _place_bar.visible,
		"badge": _badge.text if _badge != null else "",
	}


## Нажать кнопку по тексту — так тест проходит тот же путь, что игрок.
func press(text: String) -> bool:
	var b: Variant = buttons.get(text)
	if b == null:
		return false
	(b as Button).pressed.emit()
	return true
