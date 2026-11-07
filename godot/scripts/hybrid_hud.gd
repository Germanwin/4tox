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
## Подпись панели деревни: при 600 жителях пересобирать список на каждый
## снимок (10 раз в секунду) — это сотни новых Control-нод и просадка кадра.
var _village_sig := ""
var _village_fill_ms := 0
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
var spectator := false
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
var _logs_word: Label
var _village_btn: Button
var _top_stats := ""
var _events: PanelContainer
var _events_label: Label
var _status: Label
var _hints: PanelContainer
var _mm_panel: PanelContainer
var _mm_bar: HBoxContainer
var _zoom_out: Button
var _zoom_in: Button
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
var _badge_panel: PanelContainer
var _dim: ColorRect
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
	# Затемнение под модальными экранами (меню, итог): карта остаётся видна,
	# но центр внимания — на доске. Один ColorRect, в кадре ничего не стоит.
	_dim = ColorRect.new()
	_dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_dim.color = Color(0.02, 0.05, 0.08, 0.42)
	_dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_dim.visible = false
	add_child(_dim)
	move_child(_dim, 0)
	# Верх слева — ровно как в браузере: «Добыто», охапка, число, «брёвен»
	# и кнопка «Деревня». Остальные счётчики живут в панели деревни.
	_top = UI.panel(8)
	_top.custom_minimum_size = Vector2(286, 54)
	add_child(_top)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 7)
	_top.add_child(row)
	var cap := UI.label("ДОБЫТО", 9, Color("#f0dcb4"), 1)
	row.add_child(cap)
	var icon := TextureRect.new()
	icon.texture = load("res://assets/wood.png") as Texture2D
	icon.custom_minimum_size = Vector2(40, 32)
	icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	icon.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	row.add_child(icon)
	_top_label = UI.label("0", 22, Color("#fff6d8"), 2)
	row.add_child(_top_label)
	_logs_word = UI.label("брёвен", 11, Color("#f0dcb4"), 1)
	row.add_child(_logs_word)

	_village_btn = UI.button("☰ Деревня", 14)
	_village_btn.custom_minimum_size = Vector2(124, 44)
	_village_btn.pressed.connect(func() -> void: toggle_panel("village"))
	add_child(_village_btn)
	buttons["Деревня"] = _village_btn

	_events = UI.panel(6)
	_events.custom_minimum_size = Vector2(360, 30)
	add_child(_events)
	var erow := HBoxContainer.new()
	erow.add_theme_constant_override("separation", 5)
	_events.add_child(erow)
	# Живая точка ленты: пульсирует, но это одна Tween-анимация на весь HUD.
	var dot := UI.label("●", 9, UI.MOSS_LITE, 0)
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	erow.add_child(dot)
	UI.pulse(dot, 2.2)
	_events_label = UI.ink_label("событий пока нет", 12)
	_events_label.add_theme_color_override("font_color", UI.INK_SOFT)
	erow.add_child(_events_label)

	# Верх справа — три кнопки, как в браузере: войска, стройка, меню.
	_bottom = HBoxContainer.new()
	_bottom.add_theme_constant_override("separation", 8)
	add_child(_bottom)
	for spec in [["army", "Войска", "secondary"], ["build", "Стройка", "primary"],
			["menu", "Меню", "ghost"]]:
		var b := UI.button(str(spec[1]), 15, str(spec[2]))
		b.custom_minimum_size = Vector2(112, 44)
		b.pressed.connect(func() -> void: toggle_panel(str(spec[0])))
		_bottom.add_child(b)
		buttons[str(spec[1])] = b

	_status = UI.label("", 13, UI.CREAM, 2)
	# Ответ сервера и так виден в ленте событий сверху; отдельная строка поверх
	# карты в браузере не нужна и только налезала на подсказки.
	_status.visible = false
	add_child(_status)

	# Низ слева — тёмная доска подсказок, как в браузере. Это не декор:
	# игрок должен видеть, что удержание — правка, а H/C — камера.
	_hints = PanelContainer.new()
	var hb := UI.panel_style(true)
	hb.content_margin_left = 14
	hb.content_margin_right = 14
	hb.content_margin_top = 9
	hb.content_margin_bottom = 9
	_hints.add_theme_stylebox_override("panel", hb)
	add_child(_hints)
	var hbox := VBoxContainer.new()
	hbox.add_theme_constant_override("separation", 2)
	_hints.add_child(hbox)
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 7)
	hbox.add_child(head)
	head.add_child(UI.label("✦", 13, UI.GOLD, 1))
	var hcap := UI.label("ПОДСКАЗКИ", 10, Color(0.96, 0.84, 0.56, 0.95), 1)
	head.add_child(hcap)
	head.add_child(UI.hsep(2))
	for line in [
		"Тянуть — панорама · колесо/два пальца — зум",
		"Клик — выбрать постройку или жителя",
		"Удержать — правка постройки",
		"H — к выбранному жителю · C — следить за ним",
		"T — сведения о деревне · O — войска · V — общий план",
		"N — новый остров · Esc — снять выбор · меню"]:
		hbox.add_child(UI.label(line, 12, Color(0.96, 0.94, 0.86, 0.92), 1))
	_hint = UI.label("", 11, Color(0.94, 0.92, 0.84, 0.8))
	hbox.add_child(_hint)

	_panel = UI.panel(12)
	_panel.custom_minimum_size = Vector2(360, 0)
	_panel.visible = false
	add_child(_panel)
	_panel_body = VBoxContainer.new()
	_panel_body.add_theme_constant_override("separation", 6)
	_panel.add_child(_panel_body)

	_place_bar = UI.panel(10)
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

	# Низ справа — обзор в деревянной раме, с «−», «ОБЗОР», «+», как в браузере.
	_mm_panel = UI.panel(6)
	_mm_panel.custom_minimum_size = Vector2(212, 236)
	add_child(_mm_panel)
	var mm_box := VBoxContainer.new()
	mm_box.add_theme_constant_override("separation", 4)
	_mm_panel.add_child(mm_box)
	_minimap = Minimap.new()
	_minimap.custom_minimum_size = Vector2(192, 192)
	mm_box.add_child(_minimap)
	_minimap.cell_clicked.connect(func(cell: Vector2i) -> void:
		if demo != null:
			demo.minimap_to(cell))
	# Компас на обзоре: маленькая деталь, но карта сразу читается как карта.
	var north := UI.label("С", 10, UI.GOLD, 2)
	north.position = Vector2(88, 3)
	north.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_minimap.add_child(north)
	var east := UI.label("В", 9, Color(0.96, 0.86, 0.62, 0.72), 1)
	east.position = Vector2(174, 86)
	east.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_minimap.add_child(east)
	_mm_bar = HBoxContainer.new()
	_mm_bar.add_theme_constant_override("separation", 4)
	mm_box.add_child(_mm_bar)
	_zoom_out = UI.button("−", 14)
	_zoom_out.custom_minimum_size = Vector2(28, 28)
	_zoom_out.tooltip_text = "Отдалить"
	_zoom_out.pressed.connect(func() -> void:
		if demo != null:
			demo.zoom_step(-1))
	_mm_bar.add_child(_zoom_out)
	buttons["Зум −"] = _zoom_out
	var mm_cap := UI.ink_label("ОБЗОР", 10)
	mm_cap.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	mm_cap.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_mm_bar.add_child(mm_cap)
	_zoom_in = UI.button("+", 14)
	_zoom_in.custom_minimum_size = Vector2(28, 28)
	_zoom_in.tooltip_text = "Приблизить"
	_zoom_in.pressed.connect(func() -> void:
		if demo != null:
			demo.zoom_step(1))
	_mm_bar.add_child(_zoom_in)
	buttons["Зум +"] = _zoom_in

	_village = UI.panel(12)
	_village.custom_minimum_size = Vector2(320, 520)
	_village.visible = false
	add_child(_village)
	_village_body = VBoxContainer.new()
	_village_body.add_theme_constant_override("separation", 6)
	_village.add_child(_village_body)

	_badge_panel = UI.panel(5, UI.PANEL_DARK)
	_badge_panel.visible = false
	add_child(_badge_panel)
	_badge = UI.label("", 14, UI.CREAM, 2)
	_badge_panel.add_child(_badge)

	_end = UI.panel(20)
	_end.visible = false
	add_child(_end)
	_end_body = VBoxContainer.new()
	_end_body.add_theme_constant_override("separation", 10)
	_end.add_child(_end_body)


func _on_resized() -> void:
	_viewport = get_viewport_rect().size
	# Раскладка снята с браузера: ресурсы и «Деревня» сверху слева, события
	# под ними, действия сверху справа, подсказки снизу слева, обзор снизу
	# справа. Ни одна панель не закрывает центр карты без нужды.
	_top.position = Vector2(16, 16)
	_top.size = Vector2(286, 54)
	_village_btn.position = Vector2(310, 16)
	_village_btn.size = Vector2(124, 44)
	_events.position = Vector2(16, 80)
	_events.size = Vector2(360, 30)
	_bottom.position = Vector2(_viewport.x - 16 - 352, 16)
	_bottom.size = Vector2(352, 44)
	_status.position = Vector2(_viewport.x * 0.5 - 260, _viewport.y - 126)
	_status.size = Vector2(520, 22)
	_hints.position = Vector2(16, _viewport.y - 190)
	_hints.size = Vector2(470, 174)
	_mm_panel.position = Vector2(_viewport.x - 228, _viewport.y - 252)
	_mm_panel.size = Vector2(212, 236)
	_badge_panel.position = Vector2(_viewport.x - 228, _viewport.y - 286)
	_badge_panel.size = Vector2(212, 30)
	_place_bar.position = Vector2(_viewport.x * 0.5 - 320, _viewport.y - 218)
	_village.position = Vector2(16, 120)
	_village.size = Vector2(330, 520)
	_end.position = Vector2(_viewport.x * 0.5 - 300, _viewport.y * 0.5 - 150)
	_end.size = Vector2(600, 300)
	_place_panel()
	_panel_sig_last = ""


## Панель — на своё место: стройка справа (как в браузере), правка внизу по
## центру, наём/войска слева, меню по центру.
func _place_panel() -> void:
	if _panel == null:
		return
	var w := 360.0
	match panel:
		"build":
			w = 360.0
			_panel.position = Vector2(_viewport.x - 16 - w, 80)
		"edit":
			w = 760.0
			_panel.position = Vector2(_viewport.x * 0.5 - w * 0.5, _viewport.y - 300)
		"hire":
			w = 360.0
			_panel.position = Vector2(16, 120)
		"army":
			w = 560.0
			_panel.position = Vector2(16, 120)
		"menu":
			w = 600.0
			_panel.position = Vector2(_viewport.x * 0.5 - 300, _viewport.y * 0.5 - 150)
		_:
			w = 760.0
			_panel.position = Vector2(_viewport.x * 0.5 - 380, 120)
	# PanelContainer не уменьшается сам при смене панели: после «Правки» (760)
	# карточки стройки оставались за правым краем экрана. Ширину задаём явно.
	_panel.custom_minimum_size = Vector2(w, 0)
	_panel.size = Vector2(w, _panel.size.y)
	_panel.reset_size()


# ------------------------------------------------------------------ данные

func reset() -> void:
	snap = {}
	_village_sig = ""
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


func set_spectator(v: bool) -> void:
	spectator = v
	if _bottom != null:
		for text in ["Стройка", "Правка", "Войска"]:
			if buttons.has(text):
				(buttons[text] as Button).visible = not v
	refresh()


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
	_top_stats = "Брёвна %d · Жители %d · Воины %d · Учатся %d · Срублено %d · Доставлено %d" % [
		logs, int(c["villagers"]) + int(c["trainees"]), c["warriors"], c["trainees"],
		felled, delivered]
	_top_label.text = str(logs)
	_logs_word.text = "брёвен"
	var mode_text := "одиночная партия"
	if mode == "bot":
		mode_text = "против деревни"
	elif mode == "multi":
		mode_text = "сетевая партия"
	_events_label.text = status_text if status_text != "" else \
		("событий пока нет · потеряно брёвен %d · кадр №%d · %s" % [
			lost, int(snap.get("revision", 0)), mode_text])
	if _badge != null:
		if spectator:
			_badge.text = "наблюдатель"
			_badge.add_theme_color_override("font_color", UI.CREAM)
		elif mode == "multi":
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
		if _badge_panel != null:
			_badge_panel.visible = _badge.text != ""
	if _dim != null:
		_dim.visible = panel == "menu" or (_end != null and _end.visible)
	_update_place_bar()
	if panel != "":
		var sig := _panel_sig(logs, c)
		if sig != _panel_sig_last:
			_panel_sig_last = sig
			_fill_current(logs, c)
	if _village.visible:
		var vs := _village_signature()
		var now_ms := Time.get_ticks_msec()
		if vs != _village_sig and now_ms - _village_fill_ms >= 400:
			_village_sig = vs
			_village_fill_ms = now_ms
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


## Дёшево: только поля, которые видно в списке. Меняется состояние или
## состав — пересобираем; иначе панель не трогаем.
func _village_signature() -> String:
	var t := _town()
	var parts: Array = [int(t.get("logs", 0)), int(t.get("felled", 0)),
		int(t.get("deliveries", 0)), int(t.get("lost", 0))]
	for v in _villagers_of_mine():
		parts.append("%s:%s:%s:%s:%s" % [str(v.get("id", "")),
			_villager_state(v), str(v.get("employerId", "")),
			int(v.get("hp", 0)), int(v.get("tileX", -1))])
	return "|".join(parts)


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
		_village_sig = _village_signature()
		_village_fill_ms = Time.get_ticks_msec()
		_fill_village()
		_village.reset_size()
		UI.pop_in(_village, 0.22)
		refresh()
		return
	if name == "hire":
		pass
	_panel.visible = true
	_village.visible = false
	_panel_sig_last = ""
	_panel.reset_size()
	UI.pop_in(_panel, 0.22)
	refresh()


func close_panel() -> void:
	if move_id != "" and demo != null:
		demo.cancel_move()
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
	if _dim != null:
		_dim.visible = false
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


## Пояснение в панели: переносится по словам и не выезжает за дощечку.
func _note(text: String, size: int = 12, width: int = 300) -> Label:
	var l := UI.ink_label(text, size)
	l.add_theme_color_override("font_color", UI.INK_SOFT)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# Ширина нужна и для МИНИМАЛЬНОГО размера: при нулевой ширине Label с
	# переносом считает по слову на строку и раздувает панель на весь экран.
	l.custom_minimum_size = Vector2(float(width), 0.0)
	return l


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
	_place_panel()


func _fill_build(logs: int) -> void:
	_title("Постройки · брёвен %d" % logs)
	# Карточки столбиком справа, как в браузере: картинка, название с
	# описанием, цена и две кнопки. Раньше четыре карточки лежали в ряд по
	# центру и закрывали карту.
	var bdata = null
	if demo != null and demo.get("_layer") != null:
		bdata = demo.get("_layer").bdata
	for item in _menu_items():
		var type := str(item["type"])
		var variant := str(item.get("variant", "a"))
		var card := UI.panel(6)
		card.custom_minimum_size = Vector2(336, 76)
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)
		card.add_child(row)
		var prev := TextureRect.new()
		prev.custom_minimum_size = Vector2(58, 58)
		prev.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		prev.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		prev.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
		if bdata != null:
			var f: Dictionary = bdata.frame_for(type, variant, 90)
			if not f.is_empty():
				var at := AtlasTexture.new()
				at.atlas = bdata.set_for(type)["tex"]
				at.region = Rect2(float(f["x"]), float(f["y"]),
					float(f["w"]), float(f["h"]))
				prev.texture = at
		row.add_child(prev)
		var info := VBoxContainer.new()
		info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		info.add_theme_constant_override("separation", 0)
		row.add_child(info)
		info.add_child(UI.ink_label(_type_name(type), 15))
		var note := UI.ink_label(str(item.get("note", "")), 11)
		note.add_theme_color_override("font_color", UI.INK_SOFT)
		note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		note.custom_minimum_size = Vector2(150, 0)
		info.add_child(note)
		var right := VBoxContainer.new()
		right.custom_minimum_size = Vector2(104, 0)
		right.add_theme_constant_override("separation", 2)
		row.add_child(right)
		var price := UI.ink_label("%d брёвен" % int(item["price"]), 12)
		price.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		right.add_child(price)
		var b := UI.button("Построить", 12)
		b.custom_minimum_size = Vector2(104, 28)
		b.disabled = logs < int(item["price"])
		b.pressed.connect(func() -> void: begin_place(type, _type_name(type)))
		right.add_child(b)
		buttons["Построить " + type] = b
		var line := UI.button("Линия", 11)
		line.custom_minimum_size = Vector2(104, 24)
		line.disabled = logs < int(item["price"]) * 2
		line.pressed.connect(func() -> void: begin_line(type))
		right.add_child(line)
		buttons["Серия " + type] = line
		_panel_body.add_child(card)
	_panel_body.add_child(_note(
		"Стройка тратит брёвна: их приносят лесорубы из лагеря.", 11, 280))
	_panel_body.add_child(UI.hsep(3))


func _fill_edit() -> void:
	var name := _sel_name()
	_title(("Правка · " + name) if selected_id != "" else "Правка · выберите постройку")
	var state := "удержание или «Двигать» — вести · клик — поставить"
	if move_id != "":
		if demo != null and demo.move_placed():
			state = "место выбрано · «Применить» отправит перенос"
		else:
			state = "ведите мышью · клик — поставить · «Применить»/«Отменить»"
		if demo != null and not demo.move_valid() and str(demo.move_reason()) != "":
			state = str(demo.move_reason())
		elif demo != null and not demo.move_valid():
			state = "место не годится"
	_panel_body.add_child(_note(state, 12, 680))
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
	apply.pressed.connect(func() -> void: apply_edit())
	buttons["Применить"] = apply
	row.add_child(apply)
	var cancel := UI.button("Отменить", 14)
	cancel.pressed.connect(func() -> void: edit_cancel())
	buttons["Отменить правку"] = cancel
	row.add_child(cancel)
	_panel_body.add_child(_note(
		"сервер проверяет место и выходы соседей; отказ придёт словами", 12, 680))


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
	scroll.custom_minimum_size = Vector2(320, 300)
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
	_panel_body.add_child(_note(
		"Выбрано %d · «Половина» — половина всех, «½ группы» — половина одной. «Приказ» — затем клик по карте." % sel.size(), 12, 500))
	_panel_body.add_child(UI.hsep(4))


func _fill_menu() -> void:
	_panel_body.add_child(UI.ink_label("Меню", 26))
	var note := UI.ink_label("игра не останавливается · сервер продолжает считать", 12)
	note.add_theme_color_override("font_color", UI.INK_SOFT)
	_panel_body.add_child(note)
	_panel_body.add_child(UI.hsep(2))
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	_panel_body.add_child(row)
	var cont := UI.button("Продолжить", 15, "primary")
	cont.custom_minimum_size = Vector2(0, 44)
	cont.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	cont.pressed.connect(func() -> void: close_panel())
	buttons["Продолжить"] = cont
	row.add_child(cont)
	var again := UI.button("Новый остров", 15)
	again.custom_minimum_size = Vector2(0, 44)
	again.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	again.pressed.connect(func() -> void: restart())
	buttons["Новый остров"] = again
	row.add_child(again)
	var out := UI.button("В главное меню", 15, "ghost")
	out.custom_minimum_size = Vector2(0, 44)
	out.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	out.pressed.connect(func() -> void: leave())
	buttons["В главное меню"] = out
	row.add_child(out)
	_panel_body.add_child(UI.hsep(2))
	var hint := UI.ink_label("Esc — закрыть. Мир за меню живёт.", 12)
	hint.add_theme_color_override("font_color", UI.INK_SOFT)
	_panel_body.add_child(hint)


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
	if move_id != "" and demo != null:
		demo.cancel_move()
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
	status_text = "клик по карте — приказ выбранным воинам, ПКМ/Esc — отмена"
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
		if demo != null:
			demo.cancel_move()
		move_id = ""
		status_text = "перенос отменён"
		close_panel()
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
	_village_sig = _village_signature()
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
		begin_move_hold(selected_id, Vector2i(-1, -1))
		return
	# Поворот/снос во время ведения: сначала убираем призрак, иначе он
	# остался бы висеть после команды и «Отменить» отменяла бы не то.
	if move_id != "":
		if demo != null:
			demo.cancel_move()
		move_id = ""
	var act := "rotate" if kind == "rotate" else "delete"
	var gen := _panel_gen
	status_text = "команда: %s…" % act
	# Поворот/снос видны сразу: снимок подтвердит их параллельно.
	if demo != null and demo.has_method("apply_pending_edit"):
		if act == "delete":
			demo.apply_pending_edit(selected_id, "delete")
		else:
			var b: Dictionary = demo.building_by_id(selected_id) if demo != null else {}
			demo.apply_pending_edit(selected_id, "rotate",
				0, 0, (int(b.get("rot", 0)) + 90) % 360)
	refresh()
	var r: Dictionary = await room.send_command("edit", {"action": act, "id": selected_id})
	if not bool(r.get("ok", false)) and demo != null and demo.has_method("drop_pending_edit"):
		demo.drop_pending_edit(selected_id)
	_after_command("правка", r)
	# Снос закрывает правку только если игрок не открыл другую панель, пока
	# команда ходила на сервер. Иначе поздний ответ закрывал «Стройку».
	if kind == "delete" and bool(r.get("ok", false)) and gen == _panel_gen:
		clear_selection()


## Взять постройку в руку. grab — клетка пятна, за которую взялись
## удержанием (у «Двигать» её нет).
func begin_move_hold(id: String, grab: Vector2i) -> void:
	if id == "":
		return
	var keep: Dictionary = edit_prev.duplicate()
	if str(keep.get("id", "")) != id:
		var b: Dictionary = demo.building_by_id(id) if demo != null else {}
		keep = {"id": id, "x": int(b.get("x", 0)), "y": int(b.get("y", 0)),
			"rot": int(b.get("rot", 0))} if not b.is_empty() else {}
	edit_prev = keep
	_panel_gen += 1
	selected_id = id
	move_id = id
	place_type = ""
	place_name = ""
	if _place_bar != null:
		_place_bar.visible = false
	panel = "edit"
	_panel.visible = true
	_village.visible = false
	_panel_sig_last = ""
	status_text = ""
	if demo != null:
		demo.begin_move(id, grab)
	refresh()
	_panel.reset_size()


## «Применить»: перенос уже показан призраком, серверу уходит только место.
## Пока место не годно — не отправляем и говорим причину.
func apply_edit() -> void:
	if move_id != "":
		var wid := move_id
		if demo != null and not demo.move_valid():
			var why := str(demo.move_reason())
			status_text = "перенос: " + (why if why != "" else "место не годится")
			refresh()
			return
		var target: Dictionary = demo.commit_move() if demo != null else {}
		move_id = ""
		if target.is_empty():
			close_panel()
			return
		if room == null:
			close_panel()
			return
		status_text = "переносим…"
		if demo != null and demo.has_method("apply_pending_edit"):
			demo.apply_pending_edit(wid, "move",
				int(target.get("x", 0)), int(target.get("y", 0)))
		refresh()
		var gen := _panel_gen
		var r: Dictionary = await room.send_command("edit", {
			"action": "move", "id": wid,
			"x": int(target.get("x", 0)), "y": int(target.get("y", 0))})
		if not bool(r.get("ok", false)) and demo != null and demo.has_method("drop_pending_edit"):
			demo.drop_pending_edit(wid)
		_after_command("перенос", r)
		# Пока ответ шёл, игрок мог открыть другую панель — её не закрываем.
		if gen == _panel_gen:
			close_panel()
		return
	close_panel()


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
	if move_id != "":
		if demo != null:
			demo.cancel_move()
		move_id = ""
		status_text = "перенос отменён"
		close_panel()
		refresh()
		return
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
	if demo != null and demo.has_method("drop_pending_edit"):
		demo.drop_pending_edit(selected_id)
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
		# Дом встаёт в кадр до ответа сервера: подтверждение идёт параллельно.
		var pending: Dictionary = {}
		if demo != null and demo.has_method("add_pending_build"):
			pending = demo.add_pending_build({
				"type": type, "variant": str(item.get("variant", "a")),
				"rot": rot, "x": cell.x, "y": cell.y,
				"cost": int(item.get("price", 0))}, owner_id)
		refresh()
		var r: Dictionary = await room.send_command("build", {
			"buildingType": type, "variant": str(item.get("variant", "a")),
			"rot": rot, "x": cell.x, "y": cell.y})
		if not bool(r.get("ok", false)) and not pending.is_empty() \
				and demo != null and demo.has_method("drop_pending_build"):
			demo.drop_pending_build(str(pending.get("id", "")))
		_after_command("постройка", r)
		return true
	if move_id != "":
		var id := move_id
		if demo != null:
			demo.place_move(cell)
		status_text = "место выбрано · «Применить» отправит перенос"
		# Перенос не закрывает правку: «Применить»/«Отменить» должны остаться.
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
	# Первый Label — ровно «Победа»/«Поражение»: по нему приёмка читает итог.
	var t := UI.label(title, 36, UI.MOSS_LITE if win else Color("#ff9f8a"), 8)
	t.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_end_body.add_child(t)
	var ribbon := UI.label("✦ матч выигран ✦" if win else "✕ матч проигран ✕", 12,
		Color(0.96, 0.88, 0.66, 0.9), 1)
	ribbon.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_end_body.add_child(ribbon)
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
	var again := UI.button("Новый остров", 18, "primary")
	again.custom_minimum_size = Vector2(200, 50)
	again.pressed.connect(func() -> void: restart())
	row.add_child(again)
	var out := UI.button("В меню", 18, "ghost")
	out.custom_minimum_size = Vector2(200, 50)
	out.pressed.connect(func() -> void: leave())
	row.add_child(out)
	_end.visible = true
	UI.pop_in(_end, 0.28)


# ------------------------------------------------------------------- тесты

## Всё, что проверяет структурная приёмка: панель, тексты, кнопки, данные.
func state() -> Dictionary:
	var names: Array = []
	var vis: Array = []
	for k in buttons:
		names.append(str(k))
		var b: Variant = buttons[k]
		if b != null and is_instance_valid(b) and (b as Button).is_visible_in_tree():
			vis.append(str(k))
	names.sort()
	vis.sort()
	var end_title := ""
	if _end_body.get_child_count() > 0:
		var first: Node = _end_body.get_child(0)
		if first is Label:
			end_title = (first as Label).text
	return {
		"panel": panel,
		"top": _top_stats,
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
		"spectator": spectator,
		"visible_buttons": vis,
		"end": _end.visible,
		"end_title": end_title,
	}


## Нажать кнопку по тексту — так тест проходит тот же путь, что игрок.
func press(text: String) -> bool:
	var b: Variant = buttons.get(text)
	if b == null:
		return false
	(b as Button).pressed.emit()
	return true
