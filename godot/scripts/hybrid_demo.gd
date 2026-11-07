class_name ToxHybridDemo
extends Node2D

## Гибридная партия: мир считает Node-сервер, здесь — камера, ввод, призрак,
## кольца и связь с HUD. Ни одного правила игры: можно ли ставить дом, сколько
## брёвен, кто победил — отвечает сервер (снимок и ответ команды).
##
## Ввод повторяет браузерное управление (game/js/play.js): дрожь считается
## расстоянием от точки нажатия (CLICK_SLOP 8, HOLD_SLOP 18, PAN_SLOP 8,
## PLACE_SLOP 18), удержание 0,5 с открывает правку, колесо — зум 3..120 к
## курсору, камера ограничена сушей как в render.js.

signal closed
signal match_started
signal status(text)

const DIR := "res://tests/fixtures"
const WorldData = preload("res://scripts/world_data.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
const Nature = preload("res://scripts/nature.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const VillagersData = preload("res://scripts/villagers_data.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")
const Wire = preload("res://scripts/wire.gd")
const LiveRoom = preload("res://scripts/live_room.gd")
const HybridHud = preload("res://scripts/hybrid_hud.gd")
const HybridGhost = preload("res://scripts/hybrid_ghost.gd")
const MatchFx = preload("res://scripts/match_fx.gd")
const UI = preload("res://scripts/ui_theme.gd")

const MIN_ZOOM := 3.0
const MAX_ZOOM := 120.0
const CLICK_SLOP := 8.0
const HOLD_SLOP := 18.0
const PAN_SLOP := 8.0
const PLACE_SLOP := 18.0
const HOLD_MS := 500
const DOUBLE_MS := 500
const ARRIVAL := 1.4
const PAN_SPEED := 900.0
const INTERP_DELAY_MS := 150.0
## Зум: шаг мягче браузерного (1.17 за щелчок), но с плавным доведением.
## Слишком крупный шаг на трекпаде давал «телепорт» через пол-карты.
const ZOOM_STEP := 1.10
const ZOOM_EASE := 16.0
const ZOOM_IMPULSE := 0.28

var cam := {"x": 104.0, "y": 93.5, "zoom": 40.0}
var zoom := 40.0
## Куда едет зум. Сам `zoom` доводится до цели в `_process`, а камера держит
## точку под курсором на месте — как `Renderer.zoomAt` в браузере.
var zoom_target := 40.0
var _zoom_focus := Vector2(-1, -1)
var _zoom_focus_world := Vector2.ZERO

var _ui: CanvasLayer
var _hint: Label
var _loading: PanelContainer
var _loading_label: Label
var _match_emitted := false
var _canvas: CanvasLayer
var _ground: Sprite2D
var _layer = null
var _fx = null
var _cache: Dictionary = {}
var _world = null
var _fixture_loaded := false
var _snapshot_seq := -1
var _live = null
var _live_objects: Array = []
## Полный список природы, каким его прислал сервер. Битовая карта `removed`
## адресует именно его индексы, поэтому фильтровать надо от базы, а не от
## уже отфильтрованного списка (иначе второе срубленное дерево оставалось).
var _base_objects: Array = []
var _removed_hex := ""
var _live_hall_done := false
## Оптимистичные действия: дом стоит и живёт в кадре сразу, команда
## подтверждается сервером параллельно. В мир эти объекты не входят — только
## в отображение; снимок и результат команды снимают ожидание.
var _pending_builds: Array = []
var _pending_edits: Dictionary = {}
var _pending_seq := 0
var _hud = null
var _ghost = null
var _selected := ""
var _selected_villager := ""
var _army_ids: Array = []
var _hover_cell := Vector2i(-1, -1)
var _live_url := ""
var _place_type := ""
var _place_rot := 90
# Перенос постройки: локальный призрак, команда — по «Применить».
var _move_id := ""
var _move_building: Dictionary = {}
var _move_cell := Vector2i(-1, -1)
var _move_grab := Vector2i.ZERO
var _move_placed := false
var _move_valid := true
var _move_reason := ""
var _move_check_cell := Vector2i(-999, -999)
var _move_check_seq := 0
var _move_check_at := 0
var _last_snap: Dictionary = {}
var _mode := "solo"                 # solo | bot | multi
var _bot := false
## Комнату создал этот экран (solo) или её передал экран лобби (mult).
var _owns_live := true

# ввод
var _pressed := false
var _press_pos := Vector2.ZERO
var _press_ms := 0
var _press_cell := Vector2i(-1, -1)
var _panning := false
var _hold_fired := false
var _last := Vector2.ZERO
## Последняя точка мыши по событиям, а не по OS: в headless/на синтетических
## InputEvent get_viewport().get_mouse_position() не двигается.
var _last_mouse := Vector2.ZERO
var _last_click_ms := 0
var _last_click_id := ""
var _keys: Dictionary = {}
var _follow_id := ""
var _arrival = null
var _land: Array = []
var _land_box := Rect2()
var _shift := false

# проверка места (дебаунс, как в браузере: 50 мс)
var _check_at := 0
var _check_seq := 0
var _check_cell := Vector2i(-999, -999)
var _check_kind := ""
var _ghost_valid := true
var _ghost_reason := ""

# интерполяция жителей
var _samples: Dictionary = {}
var _view_villagers: Array = []
var _last_sim_ms := 0
var _sim_recv_ms := 0
var _anim_cfg: Dictionary = {}
## treeHits: id дерева → время удара по часам клиента (мс).
var _tree_shake: Dictionary = {}
var _ping_t := 0.0


func _ready() -> void:
	visible = false
	set_process(false)
	set_process_input(true)
	set_process_unhandled_input(false)


## Потеря фокуса окна — отпускание кнопки, которого мы не увидим: иначе
## панорама оставалась включённой после Alt+Tab.
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_WINDOW_FOCUS_OUT:
		_pressed = false
		_panning = false
		_hold_fired = false


## Отпускание над панелью HUD не доходит до `_unhandled_input`: сбрасываем
## панораму здесь, иначе карта продолжала бы ехать после отпускания.
func _input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT and not mb.pressed \
				and (_pressed or _panning):
			var hover := get_viewport().gui_get_hovered_control()
			if hover != null:
				_pressed = false
				_panning = false
				_hold_fired = false


func open() -> void:
	visible = true
	if _ui != null:
		_ui.visible = true
	set_process(true)
	set_process_unhandled_input(true)
	_ensure_ui()
	if not _fixture_loaded:
		await _load_fixture()
		_fixture_loaded = true
	_update_view()


## opts: {seed, size, bot, mode, base}
func open_live(url: String, opts := {}) -> void:
	visible = true
	if _ui != null:
		_ui.visible = true
	set_process(true)
	set_process_unhandled_input(true)
	_ensure_ui()
	# Старый HUD живёт в CanvasLayer и не наследует visible у Node2D: без
	# явного удаления он остался бы поверх меню после выхода.
	if _hud != null:
		_hud.queue_free()
		_hud = null
	_ensure_hud()
	_clear_shell()
	_mode = str(opts.get("mode", "bot" if bool(opts.get("bot", false)) else "solo"))
	_bot = _mode == "bot"
	_live_url = url
	_live_hall_done = false
	_snapshot_seq = -1
	_last_snap = {}
	_samples.clear()
	_view_villagers = []
	_tree_shake.clear()
	_match_emitted = false
	_army_ids = []
	_selected = ""
	_selected_villager = ""
	_hud.reset()
	_show_loading("Подключаемся к локальному серверу…\n" + url)
	_detach_live()
	_live = LiveRoom.new()
	_owns_live = true
	add_child(_live)
	_live.status.connect(_on_live_status)
	_live.world_ready.connect(_on_live_world)
	_live.snapshot.connect(_on_live_snapshot)
	_live.failed.connect(_on_live_failed)
	_live.command_done.connect(_on_command_done)
	_hud.room = _live
	if not _live.connection.is_connected(_on_live_connection):
		_live.connection.connect(_on_live_connection)
	if not _live.latency.is_connected(_on_live_latency):
		_live.latency.connect(_on_live_latency)
	if not _live.net_event.is_connected(_on_net_event):
		_live.net_event.connect(_on_net_event)
	_live.begin_solo(url, str(opts.get("seed", "")), int(opts.get("size", 0)),
		bool(opts.get("bot", false)))


## Принять уже созданную комнату из экрана сети: тот же путь, что open_live,
## но лобби, старт и токены остались у ToxNetLobby.
func open_room(room, opts := {}) -> void:
	visible = true
	if _ui != null:
		_ui.visible = true
	set_process(true)
	set_process_unhandled_input(true)
	_ensure_ui()
	if _hud != null:
		_hud.queue_free()
		_hud = null
	_ensure_hud()
	_clear_shell()
	_mode = "multi"
	_bot = false
	if _live != null and _live != room:
		_detach_live()
	_owns_live = false
	_live = room
	_live_url = str(room.base)
	_live_hall_done = false
	_snapshot_seq = -1
	_last_snap = {}
	_samples.clear()
	_view_villagers = []
	_army_ids = []
	_selected = ""
	_selected_villager = ""
	_match_emitted = false
	_hud.reset()
	_hud.room = room
	_hud.set_spectator(bool(room.get("is_spectator")))
	_show_loading("Ждём мир от сервера…")
	if not room.status.is_connected(_on_live_status):
		room.status.connect(_on_live_status)
	if not room.world_ready.is_connected(_on_live_world):
		room.world_ready.connect(_on_live_world)
	if not room.snapshot.is_connected(_on_live_snapshot):
		room.snapshot.connect(_on_live_snapshot)
	if not room.failed.is_connected(_on_live_failed):
		room.failed.connect(_on_live_failed)
	if not room.command_done.is_connected(_on_command_done):
		room.command_done.connect(_on_command_done)
	if not room.connection.is_connected(_on_live_connection):
		room.connection.connect(_on_live_connection)
	if not room.latency.is_connected(_on_live_latency):
		room.latency.connect(_on_live_latency)
	if not room.net_event.is_connected(_on_net_event):
		room.net_event.connect(_on_net_event)
	if room.world != null:
		_on_live_world(room.world)
	if not room.latest_snapshot.is_empty():
		_on_live_snapshot(room.latest_snapshot)


func close() -> void:
	visible = false
	if _ui != null:
		_ui.visible = false
	if _canvas != null:
		_canvas.visible = false
	set_process(false)
	set_process_unhandled_input(false)
	_detach_live()
	_hud = null
	_ghost = null
	_fx = null
	_clear_shell()


## Отцепить прошлую комнату: снять ВСЕ её сигналы, закрыть сессию и, если
## комната наша (solo), освободить. Иначе старая комната продолжает присылать
## снимки в тот же _layer: мир прыгает между двумя партиями, газоны
## перепекаются на каждом снимке, fps падает до 1–3.
func _detach_live() -> void:
	var old = _live
	_live = null
	if old == null:
		return
	for spec in [["status", _on_live_status], ["world_ready", _on_live_world],
			["snapshot", _on_live_snapshot], ["failed", _on_live_failed],
			["command_done", _on_command_done], ["connection", _on_live_connection],
			["latency", _on_live_latency], ["net_event", _on_net_event]]:
		var sig: String = str(spec[0])
		var cb: Callable = spec[1]
		if old.has_signal(sig) and old.is_connected(sig, cb):
			old.disconnect(sig, cb)
	old.leave()
	if _owns_live:
		old.queue_free()


func _ensure_ui() -> void:
	if _ui != null:
		return
	_ui = CanvasLayer.new()
	_ui.layer = 5
	add_child(_ui)
	_hint = Label.new()
	_hint.position = Vector2(18, 104)
	_hint.add_theme_color_override("font_color", Color(0.96, 0.93, 0.84))
	_hint.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.6))
	_hint.add_theme_constant_override("shadow_offset_x", 2)
	_hint.add_theme_constant_override("shadow_offset_y", 2)
	_ui.add_child(_hint)
	_loading = null


func _set_hint(text: String) -> void:
	if _hint != null:
		_hint.text = text


func _show_loading(text: String) -> void:
	_ensure_ui()
	if _loading != null:
		_loading.queue_free()
	_loading = UI.panel(18)
	_loading.position = Vector2(380, 300)
	_loading.custom_minimum_size = Vector2(680, 200)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	_loading.add_child(box)
	var t := UI.label("Готовим остров…", 30, UI.CREAM, 6)
	t.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(t)
	_loading_label = UI.ink_label(text, 16)
	_loading_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_loading_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_loading_label.custom_minimum_size = Vector2(620, 0)
	box.add_child(_loading_label)
	_ui.add_child(_loading)


func _hide_loading() -> void:
	if _loading != null:
		_loading.queue_free()
		_loading = null
	_loading_label = null


func _clear_shell() -> void:
	cancel_move()
	if _canvas != null:
		_canvas.queue_free()
	_canvas = null
	_ground = null
	_layer = null
	_fx = null
	_cache = {}
	_world = null
	_land = []
	_show_hover(false)


func _show_hover(v: bool) -> void:
	if _fx != null:
		_fx.show_hover = v


func _build_shell(world, objects: Array, buildings: Array, villagers: Array,
		colors: Array) -> void:
	_clear_shell()
	_world = world
	var nature = Nature.new()
	nature.load_atlas()
	_cache = await GroundCache.build_async(world, get_tree())
	_canvas = CanvasLayer.new()
	_canvas.layer = 0
	_canvas.visible = visible
	add_child(_canvas)

	_ground = Sprite2D.new()
	_ground.texture = ImageTexture.create_from_image(_cache["image"])
	_ground.centered = false
	_ground.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	_canvas.add_child(_ground)

	_layer = WorldLayer.new()
	_layer.objects = objects
	_layer.buildings = buildings
	_layer.villagers = villagers
	_layer.nature = nature
	_layer.bdata = BuildingsData.new()
	_layer.vdata = VillagersData.new()
	_layer.town_colors = colors if not colors.is_empty() else ["#4a90d9"]
	_layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	_canvas.add_child(_layer)

	_fx = MatchFx.new()
	_fx.css = get_viewport_rect().size
	_canvas.add_child(_fx)

	_ghost = HybridGhost.new()
	_ghost.visible = false
	_canvas.add_child(_ghost)
	_build_land()
	_fit_island()
	_update_view()


## Список суши нужен ограничению камеры: как render.js, камера стоит на суше,
## а не уезжает в бесконечное море.
func _build_land() -> void:
	_land = []
	if _world == null:
		return
	var minx := 1e9
	var miny := 1e9
	var maxx := -1e9
	var maxy := -1e9
	for y in range(_world.height):
		for x in range(_world.width):
			if _world.is_land_at(x, y):
				_land.append(Vector2(x + 0.5, y + 0.5))
				minx = minf(minx, x)
				maxx = maxf(maxx, x)
				miny = minf(miny, y)
				maxy = maxf(maxy, y)
	if _land.is_empty():
		_land_box = Rect2(0, 0, _world.width, _world.height)
	else:
		_land_box = Rect2(minx, miny, maxx - minx + 1, maxy - miny + 1)


## Общий план: как Renderer.fitIsland — остров целиком и по половине диаметра
## моря с каждой стороны.
func _fit_island() -> void:
	if _world == null:
		return
	var size := get_viewport_rect().size
	var map_w := float(_world.width + _world.height) * 0.5
	var map_h := float(_world.width + _world.height) * 0.25
	var z := minf((size.x - 40.0) / map_w, (size.y - 40.0) / map_h)
	zoom = clampf(z, MIN_ZOOM, MAX_ZOOM)
	zoom_target = zoom
	_zoom_focus = Vector2(-1, -1)
	cam["x"] = float(_world.width) * 0.5
	cam["y"] = float(_world.height) * 0.5
	_clamp()


func _load_fixture() -> void:
	var world = WorldData.new()
	var lr: Dictionary = world.load_json(FileAccess.get_file_as_string(DIR + "/world.json"))
	if not lr.get("ok", false):
		return
	var objects: Array = world.objects
	var buildings: Array = []
	var villagers: Array = []
	var colors: Array = ["#4a90d9"]
	var fbytes := FileAccess.get_file_as_bytes(DIR + "/frame.bin")
	if not fbytes.is_empty():
		var fres: Dictionary = Wire.unpack(fbytes)
		if fres.get("ok", false):
			var snap: Dictionary = fres["snapshot"]
			_snapshot_seq = int(snap.get("seq", 0))
			buildings = snap.get("buildings", [])
			villagers = snap.get("villagers", [])
			objects = _filter_removed(objects, str(snap.get("removed", "")))
			colors.clear()
			for t in snap.get("towns", []):
				colors.append(str(t.get("color", "#4a90d9")))
			if colors.is_empty():
				colors = ["#4a90d9"]
			for b in buildings:
				if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == 0:
					cam["x"] = float(b["x"]) + 2.0
					cam["y"] = float(b["y"]) + 1.5
					break
	await _build_shell(world, objects, buildings, villagers, colors)
	_set_hint("Новый рендер · снимок №%d · %d домов · %d жителей · ЛКМ — панорама, колесо — зум, Esc — меню" % [
		_snapshot_seq, buildings.size(), villagers.size()])


func _ensure_hud() -> void:
	if _hud != null:
		return
	_hud = HybridHud.new()
	_hud.demo = self
	_hud.room = _live
	_ui.add_child(_hud)


func hud():
	return _hud


# ------------------------------------------------------------------ комната

## Текст в загрузочном экране (статус супервизора и комнаты).
func set_status(text: String) -> void:
	# После старта партии экран загрузки больше не показываем: статус идёт в
	# строку HUD. Иначе поздний «в комнате…» снова накрывал игру дощечкой
	# «Готовим остров», и интерфейс выглядел сломанным.
	if _match_emitted or _layer != null:
		if _hud != null:
			_hud.status_text = text
			_hud.refresh()
		_set_hint(text)
		return
	if _loading_label != null:
		_loading_label.text = text
	else:
		_set_hint(text)


## Честный экран сбоя: мир явно не начался, причина названа, лог указан.
func show_error(text: String) -> void:
	_show_loading("Партия не началась.\n" + text)


func _on_live_connection(state: String, detail: String) -> void:
	if _hud == null:
		return
	if state == "online":
		if _hud.status_text.begins_with("связь"):
			_hud.status_text = ""
		_hud.set_net_note("")
	elif state == "reconnecting":
		_hud.status_text = "связь: " + detail
	elif state == "lost":
		_hud.status_text = "связь потеряна"
	elif state == "migrating":
		_snapshot_seq = -1
		_last_snap = {}
		_samples.clear()
		_show_loading("Восстанавливаем подключение…")
		_hud.status_text = "Восстанавливаем подключение…"
	_hud.refresh()


## Сетевое событие комнаты: словами в строку статуса HUD, без всплывашек
## (правило 2026-10-24: в сети только бейдж/строка).
func _on_net_event(kind: String, data: Dictionary) -> void:
	if _hud == null:
		return
	match kind:
		"peer-left":
			_hud.status_text = "%s покинул игру" % str(data.get("name", "игрок"))
			_hud.set_net_note("%s вышел" % str(data.get("name", "игрок")))
		"host-left":
			_hud.status_text = "хост вышел · мир продолжается"
			_hud.set_net_note("хост вышел")
		"peer-back":
			_hud.status_text = "%s вернулся" % str(data.get("name", "игрок"))
			_hud.set_net_note("")
		"host-back":
			_hud.status_text = "хост вернулся"
			_hud.set_net_note("")
		"room-fault":
			_hud.status_text = "сбой комнаты: " + str(data.get("message", ""))
			_hud.set_net_note("сбой")
		"room-recovered":
			_hud.status_text = "комната восстановлена"
			_hud.set_net_note("")
		_:
			return
	_hud.refresh()


func _on_live_latency(ms: int) -> void:
	if _hud != null and _live != null:
		_hud.set_net(_live.transport, ms, _live.is_host, _live.connected)


func _on_live_status(text: String) -> void:
	if _match_emitted or _layer != null or (_hud != null and not _hud.snap.is_empty()):
		_set_hint(text)
		if _hud != null:
			_hud.refresh()
		return
	_show_loading(text)
	_set_hint("живая комната · " + text)


func _on_live_world(world) -> void:
	_base_objects = world.objects
	_removed_hex = ""
	_live_objects = world.objects
	await _build_shell(world, world.objects, [], [], ["#4a90d9"])
	if not _last_snap.is_empty():
		_on_live_snapshot(_last_snap)
	_set_hint("мир получен, ждём кадр…")


func _on_live_snapshot(s: Dictionary) -> void:
	_last_snap = s
	if _layer == null:
		return
	var prev_seq := _snapshot_seq
	_snapshot_seq = int(s.get("revision", s.get("seq", 0)))
	if _snapshot_seq < prev_seq:
		return
	_apply_removed(str(s.get("removed", "")))
	var auth_buildings: Array = s.get("buildings", [])
	_reconcile_pending(auth_buildings)
	_layer.buildings = _display_buildings(auth_buildings)
	var colors: Array = []
	for t in s.get("towns", []):
		colors.append(str(t.get("color", "#4a90d9")))
	if not colors.is_empty():
		_layer.town_colors = colors
	_apply_villagers(s)
	_apply_tree_hits(s)
	if not _live_hall_done:
		for b in _layer.buildings:
			if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == 0:
				_start_arrival(b)
				_live_hall_done = true
				break
	_hide_loading()
	_set_hint("")
	if _hud != null:
		_hud.set_mode(_mode)
		_hud.set_player_owner(0 if (_live != null and _live.is_spectator) \
			else (_live.my_owner if _live != null else 0))
		_hud.set_net(_live.transport if _live != null else "none",
			_live.latency_ms if _live != null else -1,
			_live.is_host if _live != null else false,
			_live.connected if _live != null else false)
		_hud.on_snapshot(_display_snapshot(s))
	if not _match_emitted:
		_match_emitted = true
		match_started.emit()
	_update_view()


## Камера приезжает от ратуши к общему плану за 1.4 с — как startArrival в
## браузере (Session ставит общий план, затем Renderer летит к нему).
func _start_arrival(hall: Dictionary) -> void:
	var to := {"zoom": zoom, "x": float(cam["x"]), "y": float(cam["y"])}
	var fp := Vector2i(4, 3)
	if _layer != null and _layer.bdata != null:
		var f: Dictionary = _layer.bdata.frame_for(str(hall.get("type", "townhall")),
			str(hall.get("variant", "a")), int(hall.get("rot", 0)))
		if not f.is_empty():
			var a: Array = f["fp"]
			fp = Vector2i(int(a[0]), int(a[1]))
	var from := {
		"zoom": minf(to["zoom"] * 2.6, MAX_ZOOM),
		"x": float(hall.get("x", 0.0)) + float(fp.x) * 0.5,
		"y": float(hall.get("y", 0.0)) + float(fp.y) * 0.5,
	}
	zoom = float(from["zoom"])
	zoom_target = zoom
	_zoom_focus = Vector2(-1, -1)
	cam["x"] = float(from["x"])
	cam["y"] = float(from["y"])
	_clamp()
	_arrival = {"t": 0.0, "dur": ARRIVAL, "from": from, "to": to, "skip": false}


func _on_live_failed(text: String) -> void:
	_show_loading("Нет связи с локальным сервером.\n" + text)
	_set_hint("нет связи: " + text)


## Применить битовую карту срубленного. Карта только растёт, поэтому
## сравниваем строку целиком и фильтруем ОТ ПОЛНОГО списка: так второе,
## десятое и сотое дерево исчезают так же, как первое.
func _apply_removed(hex: String) -> void:
	if hex == _removed_hex:
		return
	if _base_objects.is_empty():
		_base_objects = _live_objects.duplicate()
	_removed_hex = hex
	var filtered := _filter_removed(_base_objects, hex)
	_live_objects = filtered
	if _layer != null:
		_layer.objects = filtered
		_layer.reset_objects()


func _filter_removed(objects: Array, hex: String) -> Array:
	if hex.is_empty() or objects.is_empty():
		return objects
	var bytes := PackedByteArray()
	bytes.resize(hex.length() / 2)
	for i in range(bytes.size()):
		bytes[i] = ("0x" + hex.substr(i * 2, 2)).hex_to_int()
	var out: Array = []
	for i in range(objects.size()):
		var bi := i >> 3
		var bit := i & 7
		if bi < bytes.size() and (bytes[bi] & (1 << bit)) != 0:
			continue
		out.append(objects[i])
	return out


# ------------------------------------------------- оптимистичные действия

## Поставить дом в отображение СРАЗУ. Возвращает словарь ожидания с id.
## Правил места здесь нет: `/api/check` уже покрасил ромб, а команду всё равно
## проверит сервер; при отказе ожидание снимается и дом исчезает.
func add_pending_build(spec: Dictionary, owner: int) -> Dictionary:
	_pending_seq += 1
	var b := {
		"id": "pend:%d" % _pending_seq,
		"type": str(spec.get("type", "house")),
		"variant": str(spec.get("variant", "a")),
		"rot": int(spec.get("rot", 90)),
		"x": int(spec.get("x", 0)), "y": int(spec.get("y", 0)),
		"owner": owner, "town": owner,
		"hp": int(spec.get("hp", 100)), "maxHp": int(spec.get("maxHp", 100)),
		"rubble": false, "pending": true,
		"pendingCost": int(spec.get("cost", 0)),
		"pendingAt": Time.get_ticks_msec(),
	}
	_pending_builds.append(b)
	_refresh_pending_view()
	return b


func drop_pending_build(id: String) -> void:
	for i in range(_pending_builds.size() - 1, -1, -1):
		if str(_pending_builds[i].get("id", "")) == id:
			_pending_builds.remove_at(i)
	_refresh_pending_view()


func pending_builds() -> Array:
	return _pending_builds.duplicate()


## Сколько брёвен занято ожидающими постройками: витрина казны не должна
## показывать деньги, которые уже потрачены клиентом.
func reserved_logs(owner: int) -> int:
	var sum := 0
	for b in _pending_builds:
		if int(b.get("owner", 0)) == owner:
			sum += int(b.get("pendingCost", 0))
	return sum


## Показать перенос/поворот/снос сразу. Цель запоминается до снимка: грязный
## снимок может прийти со старым местом, и ожидание перекроет его.
func apply_pending_edit(id: String, action: String, x := 0, y := 0, rot := 0) -> void:
	if id == "":
		return
	_pending_edits[id] = {"action": action, "x": int(x), "y": int(y),
		"rot": int(rot), "at": Time.get_ticks_msec()}
	_refresh_pending_view()


func drop_pending_edit(id: String) -> void:
	if _pending_edits.has(id):
		_pending_edits.erase(id)
		_refresh_pending_view()


func pending_edits() -> Dictionary:
	return _pending_edits.duplicate(true)


## Снимок — правда. Ожидание живёт, пока правда его не подтвердит; отказ
## снимается HUD-ом по результату команды, просрочка — по времени.
func _reconcile_pending(auth: Array) -> void:
	var now := Time.get_ticks_msec()
	for i in range(_pending_builds.size() - 1, -1, -1):
		var p: Dictionary = _pending_builds[i]
		var matched := false
		for b in auth:
			if int(b.get("x", -999)) == int(p.get("x", 0)) \
					and int(b.get("y", -999)) == int(p.get("y", 0)) \
					and str(b.get("type", "")) == str(p.get("type", "")) \
					and int(b.get("rot", 0)) == int(p.get("rot", 0)) \
					and int(b.get("owner", -1)) == int(p.get("owner", 0)):
				matched = true
				break
		if matched or now - int(p.get("pendingAt", now)) > 12000:
			_pending_builds.remove_at(i)
	for id in _pending_edits.keys():
		var e: Dictionary = _pending_edits[id]
		var found: Dictionary = {}
		for b in auth:
			if str(b.get("id", "")) == str(id):
				found = b
				break
		var act := str(e.get("action", ""))
		var done := false
		if act == "delete":
			done = found.is_empty()
		elif act == "move":
			done = not found.is_empty() and int(found.get("x", -999)) == int(e.get("x", 0)) \
				and int(found.get("y", -999)) == int(e.get("y", 0))
		elif act == "rotate":
			done = not found.is_empty() and int(found.get("rot", -1)) == int(e.get("rot", 0))
		if done or now - int(e.get("at", now)) > 12000:
			_pending_edits.erase(id)


## Список для отрисовки: авторитетные постройки с наложенными ожиданиями.
func _display_buildings(auth: Array) -> Array:
	var out: Array = []
	for b in auth:
		var e: Variant = _pending_edits.get(str(b.get("id", "")))
		if e == null:
			out.append(b)
			continue
		var act := str(e.get("action", ""))
		if act == "delete":
			continue
		var copy: Dictionary = b.duplicate()
		if act == "move":
			copy["x"] = int(e.get("x", copy.get("x", 0)))
			copy["y"] = int(e.get("y", copy.get("y", 0)))
		elif act == "rotate":
			copy["rot"] = int(e.get("rot", copy.get("rot", 0)))
		copy["pendingEdit"] = act
		out.append(copy)
	for p in _pending_builds:
		out.append(p)
	return out


## Снимок для отображения: ожидающие дома уже стоят, а их брёвна уже
## зарезервированы в казне — игрок видит правду клиента, не дожидаясь сервера.
func _display_snapshot(s: Dictionary) -> Dictionary:
	if _pending_builds.is_empty() and _pending_edits.is_empty():
		return s
	var d: Dictionary = s.duplicate()
	if _layer != null:
		d["buildings"] = _layer.buildings
	if not _pending_builds.is_empty():
		var towns: Array = (s.get("towns", []) as Array).duplicate(true)
		for t in towns:
			var who := int(t.get("owner", 0))
			t["logs"] = maxi(0, int(t.get("logs", 0)) - reserved_logs(who))
		d["towns"] = towns
	return d


## Пересобрать кадр после ожидания, не дожидаясь следующего снимка.
func _refresh_pending_view() -> void:
	if _layer == null:
		return
	var auth: Array = _last_snap.get("buildings", [])
	_layer.buildings = _display_buildings(auth)
	if _hud != null and not _last_snap.is_empty():
		_hud.on_snapshot(_display_snapshot(_last_snap))


# -------------------------------------------------------------- жители/поза

## Ломаная движений: сервер присылает очередь `motion` (точки в будущем) и
## текущую точку. Держим историю 2 с и рисуем на 150 мс позади снимка — так
## ходьба не дёргается на 10 кадрах в секунду.
func _apply_villagers(s: Dictionary) -> void:
	var t := int(s.get("simulationTimeMs", 0))
	_last_sim_ms = t
	_sim_recv_ms = Time.get_ticks_msec()
	var list: Array = s.get("villagers", [])
	_view_villagers = []
	for v in list:
		var id := str(v.get("id", ""))
		if id == "":
			continue
		if bool(v.get("teleport", false)):
			_samples.erase(id)
		var arr: Array = _samples.get(id, [])
		for m in v.get("motion", []):
			arr.append({"t": int(m.get("t", t)), "x": float(m.get("x", 0.0)),
				"y": float(m.get("y", 0.0)), "rot": int(m.get("rot", 0))})
		arr.append({"t": t, "x": float(v.get("x", 0.0)), "y": float(v.get("y", 0.0)),
			"rot": int(v.get("rot", 0))})
		_samples[id] = _trim_samples(arr, t - 2000)
		var view: Dictionary = v.duplicate()
		view["_t0"] = t
		_view_villagers.append(view)
	_layer.villagers = _view_villagers
	_interpolate_villagers()


## Удары по деревьям: сервер уже посчитал, КАКОЕ дерево и КОГДА ударили;
## клиент только заводит тряску на те же id. Возраст из кадра переносит фазу,
## если кадр приехал с задержкой.
func _apply_tree_hits(s: Dictionary) -> void:
	var hits: Array = s.get("treeHits", [])
	if hits.is_empty():
		return
	var now_ms := Time.get_ticks_msec()
	for h in hits:
		var id := str(h.get("id", ""))
		if id == "":
			continue
		_tree_shake[id] = now_ms - int(h.get("age", 0))
	if _tree_shake.size() > 64:
		for id in _tree_shake.keys():
			if now_ms - int(_tree_shake[id]) > 440:
				_tree_shake.erase(id)
	if _layer != null:
		_layer.set_shake(_tree_shake, now_ms)


func _trim_samples(arr: Array, cutoff: int) -> Array:
	var out: Array = []
	for s in arr:
		if int(s["t"]) >= cutoff:
			out.append(s)
	return out


func _interpolate_villagers() -> void:
	if _view_villagers.is_empty():
		return
	var render_ms := float(_last_sim_ms) + float(Time.get_ticks_msec() - _sim_recv_ms) \
		- INTERP_DELAY_MS
	for v in _view_villagers:
		var id := str(v.get("id", ""))
		var list: Array = _samples.get(id, [])
		if list.size() >= 2:
			var a: Dictionary = list[0]
			var b: Dictionary = list[list.size() - 1]
			for i in range(list.size() - 1):
				if float(list[i]["t"]) <= render_ms and float(list[i + 1]["t"]) >= render_ms:
					a = list[i]
					b = list[i + 1]
					break
			var span := float(b["t"]) - float(a["t"])
			if span > 0.0:
				var alpha := clampf((render_ms - float(a["t"])) / span, 0.0, 1.0)
				v["x"] = float(a["x"]) + (float(b["x"]) - float(a["x"])) * alpha
				v["y"] = float(a["y"]) + (float(b["y"]) - float(a["y"])) * alpha
				var d := ((int(b["rot"]) - int(a["rot"]) + 540) % 360) - 180
				v["rot"] = int(round(float(a["rot"]) + float(d) * alpha)) % 360
		if _anim_cfg.is_empty():
			continue
		var prof := "warrior" if bool(v.get("warrior", false)) else "villager"
		var anim := str(v.get("anim", "idle"))
		var info: Variant = (_anim_cfg.get(prof, {}) as Dictionary).get(anim)
		if info == null:
			continue
		var dur := float(info.get("duration", 0.0))
		if dur <= 0.0:
			continue
		var dt := (render_ms - float(v.get("_t0", _last_sim_ms))) / 1000.0
		var phase := float(v.get("phase", 0.0)) + dt / dur
		var loops := bool(info.get("loop", true)) or anim == "work"
		v["phase"] = fposmod(phase, 1.0) if loops else clampf(phase, 0.0, 1.0)


# ------------------------------------------------------------------ команды

# ------------------------------------------------------------- перенос

## Начать ведение постройки. grab — за какую клетку пятна взялись (при
## удержании); у кнопки «Двигать» его нет, и пятно встаёт углом под курсор.
func begin_move(id: String, grab := Vector2i(-1, -1)) -> bool:
	var b := building_by_id(id)
	if b.is_empty() or bool(b.get("pending", false)):
		# Ожидающий дом ещё не имеет серверного id — двигать нечего.
		return false
	cancel_place_only()
	_move_id = id
	_move_building = b.duplicate()
	_move_cell = Vector2i(int(b.get("x", 0)), int(b.get("y", 0)))
	_move_grab = grab if grab.x >= 0 and grab.y >= 0 else Vector2i.ZERO
	_move_placed = false
	_move_valid = true
	_move_reason = ""
	_move_check_cell = Vector2i(-999, -999)
	_update_move_ghost()
	_request_move_check()
	return true


func move_active() -> bool:
	return _move_id != ""


func move_placed() -> bool:
	return _move_placed


func move_target() -> Vector2i:
	return _move_cell


func move_valid() -> bool:
	return _move_valid


func move_reason() -> String:
	return _move_reason


func move_id() -> String:
	return _move_id


## Курсор ведёт призрак. same-cell и Drag не дёргают сервер каждую клетку.
func move_follow(cell: Vector2i) -> void:
	if _move_id == "" or _move_placed:
		return
	var target := cell - _move_grab
	if target == _move_cell:
		return
	_move_cell = target
	_update_move_ghost()
	var now := Time.get_ticks_msec()
	if now - _move_check_at >= 50:
		_move_check_at = now
		_request_move_check()


## Клик по карте: постройка встала, но сервер ещё не тронут — команда уйдёт
## только по «Применить».
func place_move(cell: Vector2i) -> void:
	if _move_id == "":
		return
	if not _move_placed:
		_move_cell = cell - _move_grab
	_move_placed = true
	_update_move_ghost()
	_request_move_check()


## Забрать место для команды. Пустой словарь — перенос не выбран.
func commit_move() -> Dictionary:
	if _move_id == "" or not _move_placed:
		return {}
	var out := {"id": _move_id, "x": _move_cell.x, "y": _move_cell.y}
	cancel_move()
	return out


func cancel_move() -> void:
	_move_id = ""
	_move_building = {}
	_move_cell = Vector2i(-1, -1)
	_move_placed = false
	_move_valid = true
	_move_reason = ""
	_move_check_cell = Vector2i(-999, -999)
	if _ghost != null:
		_ghost.sprite_tex = null
		_ghost.visible = _place_type != ""
		_ghost.queue_redraw()


func cancel_place_only() -> void:
	_place_type = ""
	_place_rot = 90
	if _ghost != null and _move_id == "":
		_ghost.visible = false


func _update_move_ghost() -> void:
	if _ghost == null or _move_id == "" or _layer == null:
		return
	var fake := _move_building.duplicate()
	fake["x"] = _move_cell.x
	fake["y"] = _move_cell.y
	var info: Dictionary = _layer.building_screen(fake, zoom)
	if info.is_empty():
		return
	var f: Dictionary = info["f"]
	var fp_a: Array = f["fp"]
	_ghost.cell = _move_cell
	_ghost.footprint = Vector2i(int(fp_a[0]), int(fp_a[1]))
	_ghost.sprite_tex = info["tex"]
	_ghost.sprite_region = info["region"]
	_ghost.sprite_dst = info["dst"]
	_ghost.sprite_tint = Color(1.0, 0.72, 0.68, 0.62) if not _move_valid \
		else Color(1, 1, 1, 0.58 if _move_placed else 0.48)
	_ghost.valid = _move_valid
	_ghost.valid_known = true
	_ghost.reason = _move_reason
	_ghost.zoom = zoom
	_ghost.cam = cam
	_ghost.css = get_viewport_rect().size
	_ghost.visible = true
	_ghost.queue_redraw()


func _request_move_check() -> void:
	if _live == null or _move_id == "":
		return
	if _move_cell == _move_check_cell:
		return
	_move_check_cell = _move_cell
	_move_check_seq += 1
	var seq := _move_check_seq
	var asked := _move_cell
	_move_valid = true
	_move_reason = ""
	var r: Dictionary = await _live.check_place("move", {
		"id": _move_id, "x": asked.x, "y": asked.y})
	if seq != _move_check_seq or asked != _move_cell or _move_id == "":
		return
	_move_valid = bool(r.get("ok", false))
	_move_reason = str(r.get("reason", ""))
	_update_move_ghost()


func set_place_hint(type: String, rot: int) -> void:
	if type != "" and _move_id != "":
		cancel_move()
	if _ghost == null:
		return
	_ghost.visible = type != ""
	_place_type = type
	_place_rot = rot
	_ghost.valid = _ghost_valid
	_ghost.reason = _ghost_reason
	_ghost.valid_known = false
	_check_cell = Vector2i(-999, -999)
	_ghost_update()


func set_ghost_valid(valid: bool, reason: String) -> void:
	_ghost_valid = valid
	_ghost_reason = reason
	if _ghost != null:
		_ghost.valid = valid
		_ghost.reason = reason
		_ghost.valid_known = true
		_ghost.queue_redraw()
	if _hud != null:
		_hud.set_place_state("место годится" if valid else reason)


func _ghost_update() -> void:
	if _fx != null:
		_fx.hover_cell = _hover_cell
		_fx.zoom = zoom
		_fx.cam = cam
		_fx.css = get_viewport_rect().size
		_fx.queue_redraw()
	if _ghost == null or not _ghost.visible:
		return
	var fp := Vector2i(2, 3)
	if _layer != null and _layer.bdata != null and _place_type != "":
		var f: Dictionary = _layer.bdata.frame_for(_place_type, "a", _place_rot)
		if f.is_empty():
			f = _layer.bdata.frame_for(_place_type, "x", _place_rot)
		if not f.is_empty():
			var a: Array = f["fp"]
			fp = Vector2i(int(a[0]), int(a[1]))
	_ghost.cell = _hover_cell
	_ghost.footprint = fp
	_ghost.zoom = zoom
	_ghost.cam = cam
	_ghost.css = get_viewport_rect().size
	_ghost.queue_redraw()


func _request_check() -> void:
	if _live == null or _place_type == "":
		return
	if _hover_cell.x < 0:
		return
	if _hover_cell == _check_cell and _check_kind == "build":
		return
	_check_cell = _hover_cell
	_check_kind = "build"
	_check_seq += 1
	var seq := _check_seq
	var asked := _hover_cell
	# Пока ответа нет, ромб НЕ зелёный: иначе дрогнувшая мышь оставляла
	# «место годится» от прошлой клетки, и клик уходил в занятое место.
	if _ghost != null:
		_ghost.valid_known = false
		_ghost.queue_redraw()
	var r: Dictionary = await _live.check_place("build", {
		"buildingType": _place_type, "variant": "x" if _place_type == "warcamp" else "a",
		"rot": _place_rot, "x": _hover_cell.x, "y": _hover_cell.y})
	if seq != _check_seq or asked != _hover_cell:
		return
	set_ghost_valid(bool(r.get("ok", false)), str(r.get("reason", "")))


func _process(dt: float) -> void:
	_step_zoom(dt)
	_update_view()
	# Пинг сети раз в 2,5 с — только для бейджа, на игру не влияет.
	if _mode == "multi" and _live != null and _live.is_started():
		_ping_t -= dt
		if _ping_t <= 0.0:
			_ping_t = 2.5
			_live.ping()
	if _arrival != null and not bool(_arrival.get("skip", false)):
		_arrival["t"] = float(_arrival["t"]) + dt
		var k := minf(1.0, float(_arrival["t"]) / float(_arrival["dur"]))
		var e := 1.0 - pow(1.0 - k, 3.0)
		zoom = lerpf(float(_arrival["from"]["zoom"]), float(_arrival["to"]["zoom"]), e)
		zoom_target = zoom
		cam["x"] = lerpf(float(_arrival["from"]["x"]), float(_arrival["to"]["x"]), e)
		cam["y"] = lerpf(float(_arrival["from"]["y"]), float(_arrival["to"]["y"]), e)
		_clamp()
		if k >= 1.0:
			_arrival = null
	# WASD и стрелки: 900 px/с в экранных направлениях, как в play.js.
	var vx := 0.0
	var vy := 0.0
	if _keys.get(KEY_A, false) or _keys.get(KEY_LEFT, false):
		vx += 1.0
	if _keys.get(KEY_D, false) or _keys.get(KEY_RIGHT, false):
		vx -= 1.0
	if _keys.get(KEY_W, false) or _keys.get(KEY_UP, false):
		vy += 1.0
	if _keys.get(KEY_S, false) or _keys.get(KEY_DOWN, false):
		vy -= 1.0
	if vx != 0.0 or vy != 0.0:
		_arrival = null
		_follow_id = ""
		_zoom_focus = Vector2(-1, -1)
		var l := sqrt(vx * vx + vy * vy)
		_pan_screen(vx / l * PAN_SPEED * dt, vy / l * PAN_SPEED * dt)
		_hover_cell = screen_to_cell(get_viewport().get_mouse_position())
	# Слежение за жителем: камера едет к нему, но не прыгает.
	if _follow_id != "":
		_zoom_focus = Vector2(-1, -1)
		zoom_target = zoom
		for v in _view_villagers:
			if str(v.get("id", "")) == _follow_id:
				var k := clampf(dt * 8.0, 0.0, 1.0)
				cam["x"] = lerpf(float(cam["x"]), float(v.get("x", 0.0)), k)
				cam["y"] = lerpf(float(cam["y"]), float(v.get("y", 0.0)), k)
				_clamp()
				break
	# Удержание ЛКМ: правка открывается, пока кнопка ещё нажата (5.5 с не
	# нужны — 0,5 с, как EDIT_HOLD_MS в браузере).
	var now := Time.get_ticks_msec()
	if _pressed and not _panning and not _hold_fired:
		var reach := _last_mouse.distance_to(_press_pos)
		if now - _press_ms >= HOLD_MS and reach <= HOLD_SLOP:
			_hold_fired = true
			_open_edit_at(_press_cell)
	# Проверка места с дебаунсом 50 мс: не дёргаем сервер каждый пиксель.
	if _place_type != "" and now - _check_at >= 50:
		_check_at = now
		_request_check()
	_interpolate_villagers()


## Плавное доведение зума до цели. Камера при этом держит точку, которая была
## под курсором в момент щелчка, — иначе плавность уводила бы карту из-под
## руки. `_zoom_focus = (-1,-1)` значит «якоря нет»: панорама/полёт его снимают.
func _step_zoom(dt: float) -> void:
	if is_equal_approx(zoom_target, zoom):
		zoom = zoom_target
		_zoom_focus = Vector2(-1, -1)
		return
	var k := 1.0 - exp(-dt * ZOOM_EASE)
	zoom = lerpf(zoom, zoom_target, k)
	if absf(zoom - zoom_target) < 0.01:
		zoom = zoom_target
	if _zoom_focus.x >= 0.0:
		var after := screen_to_world(_zoom_focus)
		cam["x"] = float(cam["x"]) + (_zoom_focus_world.x - after.x)
		cam["y"] = float(cam["y"]) + (_zoom_focus_world.y - after.y)
		_clamp()
	if is_equal_approx(zoom_target, zoom):
		_zoom_focus = Vector2(-1, -1)


func _update_view() -> void:
	if _ground == null or _cache.is_empty():
		return
	var z := zoom
	cam["zoom"] = z
	var size := get_viewport_rect().size
	var px := float(_cache["px"])
	var k := z / px
	var cam_px := (0.0 - float(cam["x"]) + float(cam["y"])) * z * 0.5
	var cam_py := (0.0 - float(cam["x"]) - float(cam["y"])) * z * 0.25
	var mid_x := float(_cache["off_x"])
	_ground.scale = Vector2(k, k)
	_ground.position = Vector2(size.x * 0.5 + cam_px - mid_x * k, size.y * 0.5 + cam_py)
	_layer.cam = cam
	_layer.css = size
	_layer.lod = 1.0 if z < 32.0 else 0.0
	_layer.queue_redraw()
	if _fx != null:
		_fx.cam = cam
		_fx.css = size
		_fx.zoom = z
		_fx.buildings = _layer.buildings if _layer != null else []
		_fx.villagers = _view_villagers
		_fx.team_color = _team_color(0, 1.0)
		_fx.my_owner = _live.my_owner if _live != null else 0
		_fx.show_patrol = _hud != null and _hud.panel == "army"
		_fx.queue_redraw()
	_ghost_update()
	if _move_id != "":
		_update_move_ghost()
	if _hud != null:
		_hud.set_zoom(z)
		_hud.set_minimap_camera(float(cam["x"]), float(cam["y"]), z, size)


func _team_color(owner: int, alpha: float) -> Color:
	var hex := "#4a90d9"
	if _layer != null and owner >= 0 and owner < _layer.town_colors.size():
		hex = str(_layer.town_colors[owner])
	hex = hex.replace("#", "")
	if hex.length() != 6:
		hex = "4a90d9"
	var c := Color8(("0x" + hex.substr(0, 2)).hex_to_int(),
		("0x" + hex.substr(2, 2)).hex_to_int(),
		("0x" + hex.substr(4, 2)).hex_to_int())
	c.a = alpha
	return c


# --------------------------------------------------------------------- ввод

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		_last_mouse = mm.position
		_hover_cell = screen_to_cell(mm.position)
		if _move_id != "" and not _move_placed:
			# Ведём постройку: это не панорама, карта стоит под курсором.
			_panning = false
			move_follow(_hover_cell)
		else:
			if _pressed and not _panning:
				var reach := mm.position.distance_to(_press_pos)
				if reach > _slop():
					_panning = true
			# Панорама живёт только пока кнопка нажата. Без `_pressed` камера
			# продолжала ехать за курсором после отпускания — та самая жалоба.
			if _pressed and _panning:
				var d := mm.position - _last
				if d.length() > 0.0:
					_pan_screen(d.x, d.y)
		_last = mm.position
		_ghost_update()
	elif event is InputEventPanGesture:
		# macOS: два пальца по трекпаду — это PanGesture, а не колесо. Без
		# этой ветки на маке зум не работал вовсе.
		var pg := event as InputEventPanGesture
		if absf(pg.delta.y) > 0.001:
			# Шаг на одно событие трекпада маленький: раньше 1.17 в степени
			# delta за один жест перескакивал через пол-карты.
			_zoom_at(pg.position, clampf(pow(1.06, -pg.delta.y), 0.92, 1.08))
	elif event is InputEventMagnifyGesture:
		# Щипок двумя пальцами: усилие щипка сглаживаем, чтобы не было рывка.
		var mg := event as InputEventMagnifyGesture
		_zoom_at(mg.position, clampf(pow(mg.factor, 0.72), 0.85, 1.18))
	elif event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			_zoom_at(mb.position, ZOOM_STEP)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			_zoom_at(mb.position, 1.0 / ZOOM_STEP)
		elif mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_pressed = true
				_panning = false
				_hold_fired = false
				_press_pos = mb.position
				_last_mouse = mb.position
				_press_ms = Time.get_ticks_msec()
				# Клетка нажатия — по самой точке нажатия, а не по последнему
				# движению: иначе удержание без движения брало старую клетку.
				_hover_cell = screen_to_cell(mb.position)
				_press_cell = _hover_cell
				_last = mb.position
			else:
				_pressed = false
				var was_panning := _panning
				_panning = false
				var reach := mb.position.distance_to(_press_pos)
				var limit := _slop()
				if not was_panning and not _hold_fired and reach <= limit:
					_left_click(mb.position)
		elif mb.button_index == MOUSE_BUTTON_RIGHT and mb.pressed:
			_cancel_action()
	elif event is InputEventKey:
		var k := event as InputEventKey
		if k.pressed and not k.echo:
			_shift = k.shift_pressed
			_keys[k.physical_keycode] = true
			_key_down(k.physical_keycode)
		elif not k.pressed:
			_keys.erase(k.physical_keycode)


func _slop() -> float:
	if _hud != null and _hud.wants_map():
		return PLACE_SLOP
	return CLICK_SLOP


func _left_click(pos: Vector2) -> void:
	var cell := screen_to_cell(pos)
	if _hud != null and _hud.wants_map():
		_hud.map_click(cell)
		return
	var b := building_at(cell)
	if not b.is_empty():
		_select_building(b)
		return
	var v := villager_at(cell)
	if not v.is_empty():
		_select_villager(v)
		return
	_clear_selection()


func _key_down(key: int) -> void:
	if key == KEY_ESCAPE:
		_escape()
	elif key == KEY_R:
		if _place_type != "":
			rotate_place()
	elif key == KEY_V:
		_arrival = null
		_fit_island()
	elif key == KEY_T:
		if _hud != null:
			_hud.toggle_panel("village")
	elif key == KEY_O:
		if _hud != null:
			_hud.toggle_panel("army")
	elif key == KEY_N:
		new_island()
	elif key == KEY_H:
		focus_selected()
	elif key == KEY_C:
		toggle_follow()
	elif key == KEY_EQUAL or key == KEY_PLUS or key == KEY_KP_ADD:
		zoom_step(1)
	elif key == KEY_MINUS or key == KEY_KP_SUBTRACT:
		zoom_step(-1)


func _escape() -> void:
	if _hud != null and _hud.wants_map():
		_hud.cancel_action()
		return
	if _hud != null and _hud.panel != "":
		_hud.close_panel()
		return
	if _hud != null:
		_hud.toggle_panel("menu")


func _cancel_action() -> void:
	if _hud != null:
		_hud.cancel_action()


func rotate_place() -> void:
	if _place_type == "":
		return
	_place_rot = (_place_rot + 90) % 360
	if _hud != null:
		_hud.rotate_place(_place_rot)
	_check_cell = Vector2i(-999, -999)
	_ghost_update()


## Шаг зума кнопками/клавишами — к центру экрана, а не к мыши.
func zoom_step(dir: int) -> void:
	var size := get_viewport_rect().size
	_zoom_at(size * 0.5, ZOOM_STEP if dir > 0 else 1.0 / ZOOM_STEP)


func _zoom_at(pos: Vector2, factor: float) -> void:
	var target := clampf(zoom_target * factor, MIN_ZOOM, MAX_ZOOM)
	if is_equal_approx(target, zoom_target) and absf(zoom - target) < 0.001:
		return
	_zoom_focus = pos
	_zoom_focus_world = screen_to_world(pos)
	zoom_target = target
	# Первый маленький шаг делаем сразу: щелчок отзывается в том же кадре, а
	# остаток доводится плавно в `_step_zoom`.
	zoom = lerpf(zoom, zoom_target, ZOOM_IMPULSE)
	if absf(zoom - zoom_target) < 0.01:
		zoom = zoom_target
	var after := screen_to_world(pos)
	cam["x"] = float(cam["x"]) + (_zoom_focus_world.x - after.x)
	cam["y"] = float(cam["y"]) + (_zoom_focus_world.y - after.y)
	cam["zoom"] = zoom
	_arrival = null
	_clamp()
	_update_view()


func _pan_screen(vx: float, vy: float) -> void:
	var z := zoom
	_zoom_focus = Vector2(-1, -1)
	cam["x"] = float(cam["x"]) - (vy * 2.0 + vx) / z
	cam["y"] = float(cam["y"]) - (vy * 2.0 - vx) / z
	_clamp()


func _clamp() -> void:
	if _world == null:
		return
	var size := get_viewport_rect().size
	var h := minf(size.x / (2.0 * zoom), size.y / zoom)
	if _land.is_empty():
		cam["x"] = clampf(float(cam["x"]), -h, float(_world.width) + h)
		cam["y"] = clampf(float(cam["y"]), -h, float(_world.height) + h)
		return
	# Камера может стоять на любом участке суши; ближайшая точка ищется только
	# когда она уже вышла за остров — иначе это был бы проход по 65 000 клеткам
	# на каждый кадр панорамы.
	var cx := float(cam["x"])
	var cy := float(cam["y"])
	if _land_box.grow(h).has_point(Vector2(cx, cy)):
		return
	var bx := cx
	var by := cy
	var best := INF
	for p in _land:
		var dx := maxf(0.0, absf(cx - p.x) - h)
		var dy := maxf(0.0, absf(cy - p.y) - h)
		var d := dx * dx + dy * dy
		if d < best:
			best = d
			bx = p.x
			by = p.y
			if d == 0.0:
				return
	cam["x"] = clampf(cx, bx - h, bx + h)
	cam["y"] = clampf(cy, by - h, by + h)


func screen_to_world(pos: Vector2) -> Vector2:
	var size := get_viewport_rect().size
	var a := pos.x - size.x * 0.5
	var b := pos.y - size.y * 0.5
	return Vector2(float(cam["x"]) + (a + 2.0 * b) / zoom,
		float(cam["y"]) + (2.0 * b - a) / zoom)


func screen_to_cell(pos: Vector2) -> Vector2i:
	var w := screen_to_world(pos)
	return Vector2i(int(floor(w.x)), int(floor(w.y)))


func cell_to_screen(cell: Vector2i) -> Vector2:
	var size := get_viewport_rect().size
	var wx := float(cell.x) + 0.5
	var wy := float(cell.y) + 0.5
	return Vector2(
		size.x * 0.5 + (wx - wy - float(cam["x"]) + float(cam["y"])) * zoom * 0.5,
		size.y * 0.5 + (wx + wy - float(cam["x"]) - float(cam["y"])) * zoom * 0.25)


# --------------------------------------------------------------- выделение

func set_selected(id: String) -> void:
	_selected = id
	if _fx != null:
		_fx.selected_building = id
		var b := building_by_id(id)
		_fx.footprint = Vector2i(0, 0)
		if not b.is_empty() and _layer != null and _layer.bdata != null:
			var f: Dictionary = _layer.bdata.frame_for(str(b.get("type", "townhall")),
				str(b.get("variant", "a")), int(b.get("rot", 0)))
			if not f.is_empty():
				var a: Array = f["fp"]
				_fx.footprint = Vector2i(int(a[0]), int(a[1]))
		_fx.queue_redraw()


func set_selected_villager(id: String) -> void:
	_selected_villager = id
	if _fx != null:
		_fx.selected_villagers = [id] if id != "" else []
		_fx.queue_redraw()


func set_army_selection(ids: Array) -> void:
	_army_ids = ids.duplicate()
	if _fx != null:
		_fx.selected_villagers = _army_ids.duplicate()
		_fx.queue_redraw()


func army_selection() -> Array:
	return _army_ids


func set_order_marker(cell: Vector2i) -> void:
	if _fx == null:
		return
	_fx.order_marker = {} if cell.x < 0 else {"x": cell.x, "y": cell.y}
	_fx.queue_redraw()


func _select_building(b: Dictionary) -> void:
	set_selected(str(b.get("id", "")))
	set_selected_villager("")
	if _hud != null:
		_hud.select_building(b)


func _select_villager(v: Dictionary) -> void:
	set_selected("")
	set_selected_villager(str(v.get("id", "")))
	if _hud != null:
		_hud.select_villager(v)


func _open_edit_at(cell: Vector2i) -> void:
	var b := building_at(cell)
	if b.is_empty():
		return
	if bool(b.get("pending", false)):
		select_building_info(b)
		_set_hint("дом ещё подтверждается сервером")
		return
	var own: bool = int(b.get("owner", 0)) == (_live.my_owner if _live != null else 0)
	if not own or bool(b.get("rubble", false)):
		select_building_info(b)
		return
	_select_building(b)
	# Удержание сразу берёт постройку в руку, как в браузере: дом не прыгает,
	# потому что запоминается клетка, за которую взялись.
	var grab := Vector2i.ZERO
	if _layer != null and _layer.bdata != null:
		var f: Dictionary = _layer.bdata.frame_for(str(b.get("type", "townhall")),
			str(b.get("variant", "a")), int(b.get("rot", 0)))
		if not f.is_empty():
			var fp: Array = f["fp"]
			grab = Vector2i(
				clampi(cell.x - int(b.get("x", 0)), 0, maxi(0, int(fp[0]) - 1)),
				clampi(cell.y - int(b.get("y", 0)), 0, maxi(0, int(fp[1]) - 1)))
	if _hud != null:
		_hud.begin_move_hold(str(b.get("id", "")), grab)


func _clear_selection() -> void:
	set_selected("")
	set_selected_villager("")
	set_order_marker(Vector2i(-1, -1))
	if _hud != null:
		_hud.clear_selection()


func select_building_info(b: Dictionary) -> void:
	set_selected(str(b.get("id", "")))
	if _hud != null:
		_hud.select_building(b)


# ------------------------------------------------------------------ запросы

func building_by_id(id: String) -> Dictionary:
	if _layer == null:
		return {}
	for b in _layer.buildings:
		if str(b.get("id", "")) == id:
			return b
	return {}


func building_at(cell: Vector2i) -> Dictionary:
	if _layer == null or _layer.bdata == null:
		return {}
	for b in _layer.buildings:
		var f: Dictionary = _layer.bdata.frame_for(str(b.get("type", "townhall")),
			str(b.get("variant", "a")), int(b.get("rot", 0)))
		if f.is_empty():
			continue
		var fp: Array = f["fp"]
		if cell.x >= int(b["x"]) and cell.x < int(b["x"]) + int(fp[0]) \
				and cell.y >= int(b["y"]) and cell.y < int(b["y"]) + int(fp[1]):
			return b
	return {}


## Житель под клеткой: сначала точное попадание в клетку, затем ближайший в
## радиусе 0.75 — иначе по маленькому спрайту трудно попасть.
func villager_at(cell: Vector2i) -> Dictionary:
	var best: Dictionary = {}
	var best_d := 0.85
	var p := Vector2(float(cell.x) + 0.5, float(cell.y) + 0.5)
	for v in _view_villagers:
		if bool(v.get("hidden", false)):
			continue
		var d := p.distance_to(Vector2(float(v.get("x", 0.0)), float(v.get("y", 0.0))))
		if d < best_d:
			best_d = d
			best = v
	return best


func villager_by_id(id: String) -> Dictionary:
	for v in _view_villagers:
		if str(v.get("id", "")) == id:
			return v
	return {}


func my_owner() -> int:
	return _live.my_owner if _live != null else 0


func mode() -> String:
	return _mode


# ------------------------------------------------------------------- камера

func focus_cell(cell: Vector2i, z := -1.0) -> void:
	_arrival = null
	_zoom_focus = Vector2(-1, -1)
	cam["x"] = float(cell.x) + 0.5
	cam["y"] = float(cell.y) + 0.5
	if z > 0.0:
		zoom = clampf(z, MIN_ZOOM, MAX_ZOOM)
		zoom_target = zoom
	_clamp()
	_update_view()


func focus_building(id: String) -> void:
	var b := building_by_id(id)
	if b.is_empty():
		return
	focus_cell(Vector2i(int(b["x"]), int(b["y"])), maxf(zoom, 40.0))


func focus_selected() -> void:
	if _selected_villager != "":
		var v := villager_by_id(_selected_villager)
		if not v.is_empty():
			focus_cell(Vector2i(int(v["x"]), int(v["y"])), maxf(zoom, 64.0))
	elif _selected != "":
		focus_building(_selected)


func toggle_follow() -> void:
	if _selected_villager == "":
		return
	_follow_id = "" if _follow_id == _selected_villager else _selected_villager
	if _hud != null:
		_hud.set_follow(_follow_id != "")


func fit_island() -> void:
	_arrival = null
	_fit_island()
	_update_view()


func minimap_to(cell: Vector2i) -> void:
	focus_cell(cell)


# ---------------------------------------------------------------- смена мира

func restart_live(new_seed := "") -> void:
	var url := _live_url
	var opts := {"seed": new_seed, "size": int(_last_snap.get("size", 0)), "bot": _bot,
		"mode": _mode}
	if _live != null:
		_live.leave()
		if _owns_live:
			_live.queue_free()
		_live = null
	open_live(url if url != "" else "http://127.0.0.1:8787", opts)


func new_island() -> void:
	if _mode == "multi":
		if _hud != null:
			_hud.status_text = "в сети новый остров создаёт хост: выйдите в меню и создайте новую игру"
			_hud.refresh()
		return
	if _hud != null:
		_hud.close_panel()
	restart_live(_random_seed())


func _random_seed() -> String:
	var words := ["тихая", "вольная", "светлая", "каменная", "дальняя", "зелёная"]
	var places := ["долина", "заводь", "пойма", "бухта", "гавань", "грива"]
	var rng := RandomNumberGenerator.new()
	rng.randomize()
	return "%s-%s-%d" % [words[rng.randi() % words.size()],
		places[rng.randi() % places.size()], 100 + rng.randi() % 900]


func _on_command_done(result: Dictionary) -> void:
	if _hud != null:
		_hud.refresh()


func loading_text() -> String:
	return _loading_label.text if _loading_label != null else ""
