class_name ToxWorldView
extends Node2D

## Isometric view: bakes the terrain once, then draws objects, buildings and
## villagers in depth order. Coordinates: one cell = 64 world units;
## screen_x = (x-y)*32, screen_y = (x+y)*16.

signal building_clicked(b)
signal villager_clicked(v)
signal ground_clicked(cell)
signal building_double_clicked(b)
signal building_held(b)
signal place_clicked(cell)
signal edit_clicked(cell)
signal order_clicked(cell)
signal cancel_requested
signal rotate_requested
signal hover_changed(cell, b, v)

enum Mode { NORMAL, PLACE, EDIT, ORDER }

const HALF_W := 32.0
const HALF_H := 16.0
const WORLD_CELL := 64.0
const ZOOM_MIN := 3.0
const ZOOM_MAX := 120.0

var sim: ToxSim
var input_enabled: bool = true
var camera: Camera2D
var terrain_tex: Texture2D
var water_tex: Texture2D
var terrain_px: int = 32
var terrain_origin := Vector2.ZERO
var terrain_scale := 1.0
var cam_x: float = 0.0
var cam_y: float = 0.0
var zoom_px: float = 40.0
var min_zoom_px: float = 12.0

var mode: int = Mode.NORMAL
var hover_cell := Vector2i(-1, -1)
var force_hover := Vector2i(-1, -1)
var hover_building: Variant = null
var hover_villager: Variant = null
var selected_building: Variant = null
var selected_villager: Variant = null

var ghost_type: String = "house"
var ghost_variant: String = "a"
var ghost_rot: int = 90
var ghost_b: Dictionary = {}
var ghost_ok: bool = false
var ghost_reason: String = ""
var ghost_cell := Vector2i(-1, -1)

var edit_building: Variant = null
var edit_ok: bool = true
var edit_moving: bool = false
var edit_armed: bool = false
var edit_grab := Vector2i.ZERO

var order_ids: Array = []
var order_cell := Vector2i(-1, -1)
var floats: Array = []

var _arrival_t := -1.0
var _arrival_dur := 1.4
var _arrival_from := Vector2.ZERO
var _arrival_to := Vector2.ZERO
var _arrival_from_zoom := 40.0
var _arrival_to_zoom := 40.0

var _lmb_down := false
var _rmb_down := false
var _mmb_down := false
var _lmb_start := Vector2.ZERO
var _lmb_cell := Vector2i(-1, -1)
var _lmb_building: Variant = null
var _lmb_villager: Variant = null
var _lmb_time := 0.0
var _hold_fired := false
var _dragged := false
var _last_click_ms := 0
var _last_click_b: Variant = null
var _press_grab := Vector2i.ZERO

var _cover_key := ""
var _cover: Dictionary = {}

## Заставка меню: природа острова собирается в мировой меш ОДИН раз. Иначе
## кадр на 256-й карте перебирал десятки тысяч деревьев по одному — 6–10 fps
## в меню и ещё хуже в лобби, которое открывалось поверх той же заставки.
var nature_mesh_builds := 0
var static_nature_quads := 0
var nature_draw_calls := 0
var _nature_sim: Variant = null
var _nature_meshes: Array = []
var _shadow_mesh: ArrayMesh = null
var _shadow_tex: Texture2D = null

func _ready() -> void:
	texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
	camera = Camera2D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.position_smoothing_enabled = false
	camera.enabled = true
	set_process_unhandled_input(true)
	set_process(true)

func setup(p_sim: ToxSim) -> void:
	sim = p_sim
	selected_building = null
	selected_villager = null
	hover_building = null
	hover_villager = null
	var baked := ToxTerrain.build(sim.world)
	terrain_tex = baked.texture
	water_tex = load("res://assets/textures/water.png")
	terrain_px = baked.px
	var scale := WORLD_CELL / float(terrain_px)
	terrain_scale = scale
	terrain_origin = Vector2(-sim.world.height * HALF_W, 0.0)
	cam_x = sim.world.width * 0.5
	cam_y = sim.world.height * 0.5
	fit_island()
	min_zoom_px = zoom_px
	var th: Variant = sim.town(sim.player_owner).get("townhall", null)
	if th != null:
		start_arrival(th)
	else:
		_sync_camera()
	queue_redraw()

func start_arrival(th: Dictionary) -> void:
	var fp := ToxBuildings.footprint(int(th.rot), ToxBuildings.type_of(th))
	_arrival_from = Vector2(float(th.x) + fp.x * 0.5, float(th.y) + fp.y * 0.5)
	_arrival_to = Vector2(cam_x, cam_y)
	_arrival_from_zoom = minf(ZOOM_MAX, zoom_px * 2.4)
	_arrival_to_zoom = zoom_px
	zoom_px = _arrival_from_zoom
	cam_x = _arrival_from.x
	cam_y = _arrival_from.y
	_arrival_t = 0.0
	_sync_camera()

func fit_island() -> void:
	if sim == null:
		return
	var vp := get_viewport_rect().size
	var W := sim.world.width
	var H := sim.world.height
	var map_w := (W + H) * HALF_W
	var map_h := (W + H) * HALF_H
	var z := minf(vp.x * 0.90 / map_w, vp.y * 0.90 / map_h) * WORLD_CELL
	zoom_px = clampf(z, ZOOM_MIN, ZOOM_MAX)
	cam_x = W * 0.5
	cam_y = H * 0.5
	_sync_camera()
	queue_redraw()

func center_on(cell: Vector2) -> void:
	cam_x = cell.x
	cam_y = cell.y
	_clamp_camera()
	_sync_camera()
	queue_redraw()

func focus_building(b: Dictionary) -> void:
	center_on(ToxBuildings.center(b))
	if zoom_px < 34.0:
		zoom_px = 42.0
		_sync_camera()

func _sync_camera() -> void:
	_clamp_camera()
	camera.position = Vector2((cam_x - cam_y) * HALF_W, (cam_x + cam_y) * HALF_H)
	camera.zoom = Vector2(zoom_px / WORLD_CELL, zoom_px / WORLD_CELL)
	camera.force_update_scroll()

func _clamp_camera() -> void:
	if sim == null:
		return
	cam_x = clampf(cam_x, 0.0, float(sim.world.width))
	cam_y = clampf(cam_y, 0.0, float(sim.world.height))

func cell_from_world(p: Vector2) -> Vector2i:
	return Vector2i(floori(p.y / HALF_H * 0.5 + p.x / (HALF_W * 2.0)), floori(p.y / HALF_H * 0.5 - p.x / (HALF_W * 2.0)))

func world_from_cell(c: Vector2) -> Vector2:
	return Vector2((c.x - c.y) * HALF_W, (c.x + c.y) * HALF_H)

func mouse_cell() -> Vector2i:
	return cell_from_world(get_global_mouse_position())

func _view_world_rect() -> Rect2:
	var vp := get_viewport_rect().size
	var size := vp / camera.zoom
	return Rect2(camera.position - size * 0.5, size)

func _view_cell_pad() -> float:
	return 6.0 + 100.0 / maxf(1.0, zoom_px)

func view_cell_rect() -> Rect2:
	return _cell_view()

func _process(delta: float) -> void:
	if sim == null:
		return
	# Keyboard pan, physical keys so a Russian layout still works.
	var kx := 0.0
	var ky := 0.0
	if Input.is_physical_key_pressed(KEY_A) or Input.is_physical_key_pressed(KEY_LEFT):
		kx -= 1.0
	if Input.is_physical_key_pressed(KEY_D) or Input.is_physical_key_pressed(KEY_RIGHT):
		kx += 1.0
	if Input.is_physical_key_pressed(KEY_W) or Input.is_physical_key_pressed(KEY_UP):
		ky -= 1.0
	if Input.is_physical_key_pressed(KEY_S) or Input.is_physical_key_pressed(KEY_DOWN):
		ky += 1.0
	if input_enabled and (kx != 0.0 or ky != 0.0):
		var speed := 900.0 / camera.zoom.x
		_move_camera_screen(Vector2(kx, ky) * speed * delta)
	if _arrival_t >= 0.0:
		_arrival_t += delta
		var k := clampf(_arrival_t / _arrival_dur, 0.0, 1.0)
		var e := 1.0 - pow(1.0 - k, 3.0)
		zoom_px = lerpf(_arrival_from_zoom, _arrival_to_zoom, e)
		cam_x = lerpf(_arrival_from.x, _arrival_to.x, e)
		cam_y = lerpf(_arrival_from.y, _arrival_to.y, e)
		_sync_camera()
		if k >= 1.0:
			_arrival_t = -1.0
	# Hold on a building opens the edit bar (browser: 500 ms).
	if _lmb_down and not _dragged and not _hold_fired and mode == Mode.NORMAL and _lmb_building != null:
		if Time.get_ticks_msec() - _lmb_time >= 500:
			_hold_fired = true
			emit_signal("building_held", _lmb_building)
	_update_hover()
	_update_mode_ghost()
	for f in floats:
		f.t -= delta
	floats = floats.filter(func(f: Dictionary) -> bool: return f.t > 0.0)
	queue_redraw()

func _update_hover() -> void:
	if sim == null:
		return
	var c := force_hover if force_hover.x >= 0 else mouse_cell()
	if c != hover_cell:
		hover_cell = c
		hover_building = _building_at(c)
		hover_villager = _villager_at(c)
		emit_signal("hover_changed", c, hover_building, hover_villager)
	else:
		hover_building = _building_at(c)
		hover_villager = _villager_at(c)

func _update_mode_ghost() -> void:
	if mode == Mode.PLACE:
		var fp := ToxBuildings.footprint(ghost_rot, ghost_type)
		var c := hover_cell - Vector2i(fp.x / 2, fp.y / 2)
		ghost_cell = c
		var check := sim.can_build(ghost_type, ghost_rot, c, sim.player_owner)
		if check.ok:
			var b: Dictionary = check.building
			b["_nid"] = -1
			ghost_b = b
		else:
			ghost_b = ToxBuildings.make(ghost_type, ghost_variant, ghost_rot, c.x, c.y, sim.player_owner)
		ghost_ok = check.ok
		ghost_reason = check.reason
	elif mode == Mode.EDIT and edit_building != null:
		if edit_moving and edit_armed:
			var fp := ToxBuildings.footprint(int(edit_building.rot), ToxBuildings.type_of(edit_building))
			var c := hover_cell - edit_grab
			edit_building.x = c.x
			edit_building.y = c.y
		var check := sim.edit_check(edit_building)
		edit_ok = check.ok

func _unhandled_input(event: InputEvent) -> void:
	if sim == null or not input_enabled:
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			_zoom_at(mb.position, 1.12)
			get_viewport().set_input_as_handled()
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			_zoom_at(mb.position, 1.0 / 1.12)
			get_viewport().set_input_as_handled()
		elif mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_lmb_down = true
				_lmb_start = mb.position
				_lmb_cell = mouse_cell()
				_lmb_building = _building_at(_lmb_cell)
				_lmb_villager = _villager_at(_lmb_cell)
				_lmb_time = Time.get_ticks_msec()
				_hold_fired = false
				_dragged = false
				if mode == Mode.EDIT and edit_building != null and edit_moving and get_viewport().gui_get_hovered_control() == null:
					edit_armed = true
				if mode == Mode.EDIT and edit_building != null and edit_moving:
					_press_grab = _lmb_cell - Vector2i(int(edit_building.x), int(edit_building.y))
					edit_grab = _press_grab
			else:
				if _lmb_down:
					_lmb_down = false
					if not _dragged and not _hold_fired:
						_handle_click()
				_lmb_down = false
			get_viewport().set_input_as_handled()
		elif mb.button_index == MOUSE_BUTTON_RIGHT:
			if mb.pressed:
				if mode != Mode.NORMAL:
					emit_signal("cancel_requested")
				else:
					_rmb_down = true
			else:
				_rmb_down = false
			get_viewport().set_input_as_handled()
		elif mb.button_index == MOUSE_BUTTON_MIDDLE:
			_mmb_down = mb.pressed
			get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		if mode == Mode.EDIT and edit_moving and get_viewport().gui_get_hovered_control() == null:
			edit_armed = true
		if _lmb_down and not _dragged:
			if mm.position.distance_to(_lmb_start) > 8.0:
				_dragged = true
				_hold_fired = true
		if _dragged and _lmb_down:
			_move_camera_screen(-mm.relative / camera.zoom.x)
		elif _rmb_down or _mmb_down:
			_move_camera_screen(-mm.relative / camera.zoom.x)
		elif mode == Mode.EDIT and edit_building != null and edit_moving:
			# moving a building follows the cursor even without a held button
			pass
		_update_hover()

func _handle_click() -> void:
	var c := _lmb_cell
	match mode:
		Mode.PLACE:
			emit_signal("place_clicked", ghost_cell)
		Mode.EDIT:
			if edit_building != null:
				if edit_moving:
					edit_moving = false
					emit_signal("edit_clicked", c)
				else:
					emit_signal("edit_clicked", c)
		Mode.ORDER:
			emit_signal("order_clicked", c)
		_:
			if _lmb_building != null:
				var now := Time.get_ticks_msec()
				if _last_click_b == _lmb_building and now - _last_click_ms < 320:
					emit_signal("building_double_clicked", _lmb_building)
				else:
					emit_signal("building_clicked", _lmb_building)
				_last_click_b = _lmb_building
				_last_click_ms = now
			elif _lmb_villager != null:
				emit_signal("villager_clicked", _lmb_villager)
			else:
				emit_signal("ground_clicked", c)

func _cancel_mode() -> void:
	mode = Mode.NORMAL
	edit_building = null
	edit_moving = false
	edit_armed = false
	order_ids = []
	order_cell = Vector2i(-1, -1)
	ghost_b = {}

func reset_mode() -> void:
	mode = Mode.NORMAL
	edit_building = null
	edit_moving = false
	edit_armed = false
	order_ids = []
	order_cell = Vector2i(-1, -1)
	ghost_b = {}
	ghost_cell = Vector2i(-1, -1)

func set_place(type: String, variant: String, rot: int) -> void:
	mode = Mode.PLACE
	ghost_type = type
	ghost_variant = variant
	ghost_rot = rot
	edit_building = null
	edit_moving = false
	edit_armed = false
	order_ids = []
	_update_mode_ghost()

func set_edit(b: Dictionary, moving: bool = false) -> void:
	mode = Mode.EDIT
	edit_building = b
	edit_moving = moving
	edit_armed = moving
	edit_grab = Vector2i(int(hover_cell.x) - int(b.x), int(hover_cell.y) - int(b.y))
	if moving:
		_press_grab = edit_grab
	edit_ok = true
	_update_mode_ghost()

func begin_move() -> void:
	if edit_building == null:
		return
	edit_moving = true
	edit_armed = false
	var fp := ToxBuildings.footprint(int(edit_building.rot), ToxBuildings.type_of(edit_building))
	edit_grab = Vector2i(int(fp.x / 2), int(fp.y / 2))

func rotate_ghost() -> void:
	if mode == Mode.PLACE:
		ghost_rot = (ghost_rot + 90) % 360
		_update_mode_ghost()
	elif mode == Mode.EDIT and edit_building != null:
		edit_building.rot = (int(edit_building.rot) + 90) % 360
		_update_mode_ghost()

func set_order(ids: Array) -> void:
	mode = Mode.ORDER
	order_ids = ids.duplicate()
	edit_building = null
	edit_moving = false

func set_order_target(cell: Vector2i) -> void:
	order_cell = cell

func _zoom_at(screen_pos: Vector2, factor: float) -> void:
	var before := get_global_mouse_position()
	zoom_px = clampf(zoom_px * factor, min_zoom_px, ZOOM_MAX)
	_sync_camera()
	var after := get_global_mouse_position()
	camera.position += before - after
	cam_x = cell_from_world(camera.position).x
	cam_y = cell_from_world(camera.position).y
	_sync_camera()

func _move_camera_screen(v: Vector2) -> void:
	# v is a screen-space drag delta; move the camera by the equivalent world
	# vector, then convert back to cell coordinates.
	var world := v / camera.zoom.x
	cam_x += world.y / HALF_H * 0.5 + world.x / (HALF_W * 2.0)
	cam_y += world.y / HALF_H * 0.5 - world.x / (HALF_W * 2.0)
	_clamp_camera()
	_sync_camera()

func _building_at(cell: Vector2i) -> Variant:
	if sim == null:
		return null
	for b in sim.buildings:
		if b.get("rubble", false):
			continue
		if ToxBuildings.covers_cell(b, cell.x, cell.y):
			return b
	return null

func _villager_at(cell: Vector2i) -> Variant:
	if sim == null:
		return null
	var p := Vector2(cell.x + 0.5, cell.y + 0.5)
	for v in sim.villagers:
		if v.dead or not v.visible():
			continue
		var dx: float = absf(v.x - p.x)
		var dy: float = v.y - p.y
		if dx < 0.62 and dy > -1.25 and dy < 0.55:
			return v
	return null

# ------------------------------------------------------------------ drawing

func _draw() -> void:
	if sim == null or terrain_tex == null:
		return
	var vr := _view_world_rect()
	draw_rect(vr.grow(200.0), Color(0.086, 0.306, 0.502), true)
	if water_tex != null:
		draw_texture_rect(water_tex, vr.grow(200.0), true, Color(0.45, 0.65, 0.9, 0.12))
	var dest := Rect2(terrain_origin, Vector2(terrain_tex.get_width(), terrain_tex.get_height()) * terrain_scale)
	draw_texture_rect(terrain_tex, dest, false)
	ensure_nature_mesh()
	if _shadow_mesh != null and _shadow_tex != null:
		draw_mesh(_shadow_mesh, _shadow_tex)
	for m in _nature_meshes:
		draw_mesh(m["mesh"], m["tex"])
	_draw_buildings_villagers()
	_draw_overlays()
	_draw_waves()

## Собрать природу острова в мировой меш. Мировые координаты переживают
## панораму и зум, поэтому в кадре меш только рисуется.
func ensure_nature_mesh() -> void:
	if sim == null:
		return
	if _nature_sim == sim and (not _nature_meshes.is_empty() or static_nature_quads > 0):
		return
	_nature_sim = sim
	_nature_meshes.clear()
	_shadow_mesh = null
	static_nature_quads = 0
	nature_draw_calls = 0
	var cover := _cover_cells()
	var groups: Dictionary = {}
	var sv := PackedVector3Array()
	var su := PackedVector2Array()
	var si := PackedInt32Array()
	for o in sim.world.objects:
		if o.get("removed", false):
			continue
		var cy := floori(float(o.y))
		var cx := floori(float(o.x))
		if cover.has(Vector2i(cx, cy)) and ToxBuildings.decor(o):
			continue
		var frame := ToxAtlasDB.sprite_frame(o)
		if frame.is_empty():
			continue
		var sc := ToxAtlasDB.sprite_scale() * float(o.get("scale", 1.0))
		var size: Vector2 = frame.size * sc
		var pos := world_from_cell(Vector2(float(o.x), float(o.y)))
		var dest := Rect2(pos - size * Vector2(frame.ax, frame.ay), size)
		var tex: Texture2D = frame.tex
		var key := tex.get_instance_id()
		var g: Dictionary = groups.get(key, {})
		if g.is_empty():
			g = {"tex": tex, "v": PackedVector3Array(),
				"u": PackedVector2Array(), "i": PackedInt32Array()}
			groups[key] = g
		_quad(g, dest, frame.region, tex.get_size())
		static_nature_quads += 1
		var kind := str(o.get("kind", ""))
		var r := 0.0
		if kind == "tree":
			r = 0.36 * float(o.get("scale", 1.0))
		elif kind == "stone":
			r = 0.24 * float(o.get("scale", 1.0))
		elif kind == "bush":
			r = 0.20 * float(o.get("scale", 1.0))
		if r > 0.0:
			var sd := Rect2(pos - Vector2(r * 1.25, r * 0.55), Vector2(r * 2.5, r * 1.1))
			_shadow_quad(sv, su, si, sd)
	for key in groups:
		var g: Dictionary = groups[key]
		if (g["v"] as PackedVector3Array).is_empty():
			continue
		_nature_meshes.append({"tex": g["tex"], "mesh": _make_mesh(g["v"], g["u"], g["i"])})
	if not sv.is_empty():
		_shadow_tex = _shadow_texture()
		_shadow_mesh = _make_mesh(sv, su, si)
	nature_mesh_builds += 1


func _quad(g: Dictionary, dest: Rect2, region: Rect2, tex_size: Vector2) -> void:
	var v: PackedVector3Array = g["v"]
	var u: PackedVector2Array = g["u"]
	var idx: PackedInt32Array = g["i"]
	var n := v.size()
	v.append(Vector3(dest.position.x, dest.position.y, 0))
	v.append(Vector3(dest.end.x, dest.position.y, 0))
	v.append(Vector3(dest.end.x, dest.end.y, 0))
	v.append(Vector3(dest.position.x, dest.end.y, 0))
	var u0 := region.position.x / tex_size.x
	var v0 := region.position.y / tex_size.y
	var u1 := region.end.x / tex_size.x
	var v1 := region.end.y / tex_size.y
	u.append(Vector2(u0, v0))
	u.append(Vector2(u1, v0))
	u.append(Vector2(u1, v1))
	u.append(Vector2(u0, v1))
	idx.append(n)
	idx.append(n + 1)
	idx.append(n + 2)
	idx.append(n)
	idx.append(n + 2)
	idx.append(n + 3)


func _shadow_quad(v: PackedVector3Array, u: PackedVector2Array,
		idx: PackedInt32Array, dest: Rect2) -> void:
	var n := v.size()
	v.append(Vector3(dest.position.x, dest.position.y, 0))
	v.append(Vector3(dest.end.x, dest.position.y, 0))
	v.append(Vector3(dest.end.x, dest.end.y, 0))
	v.append(Vector3(dest.position.x, dest.end.y, 0))
	u.append(Vector2(0, 0))
	u.append(Vector2(1, 0))
	u.append(Vector2(1, 1))
	u.append(Vector2(0, 1))
	idx.append(n)
	idx.append(n + 1)
	idx.append(n + 2)
	idx.append(n)
	idx.append(n + 2)
	idx.append(n + 3)


func _make_mesh(v: PackedVector3Array, u: PackedVector2Array,
		idx: PackedInt32Array) -> ArrayMesh:
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = v
	arrays[Mesh.ARRAY_TEX_UV] = u
	arrays[Mesh.ARRAY_INDEX] = idx
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _shadow_texture() -> Texture2D:
	if _shadow_tex != null:
		return _shadow_tex
	var img := Image.create_empty(64, 32, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	for y in range(32):
		for x in range(64):
			var dx := (float(x) - 31.5) / 31.5
			var dy := (float(y) - 15.5) / 15.5
			var d := sqrt(dx * dx + dy * dy)
			var a := clampf(1.0 - d, 0.0, 1.0)
			a = a * a * 0.55
			if a > 0.0:
				img.set_pixel(x, y, Color(0.03, 0.07, 0.03, a))
	return ImageTexture.create_from_image(img)


## Постройки и жители поверх статичной природы — их единицы, поштучная
## отрисовка здесь дешевле отдельных мешей и сохраняет порядок по глубине.
func _draw_buildings_villagers() -> void:
	var blds: Array = sim.buildings.duplicate()
	blds.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return ToxBuildings.depth(a) < ToxBuildings.depth(b))
	var vils: Array = []
	for v in sim.villagers:
		if not v.dead and v.visible():
			vils.append(v)
	vils.sort_custom(func(a: ToxVillager, b: ToxVillager) -> bool:
		return (a.x + a.y) < (b.x + b.y))
	var j := 0
	var k := 0
	while j < blds.size() or k < vils.size():
		var b: Variant = blds[j] if j < blds.size() else null
		var v: Variant = vils[k] if k < vils.size() else null
		var kb: float = ToxBuildings.depth(b) if b != null else INF
		var kv: float = (float(v.x) + float(v.y)) if v != null else INF
		if b != null and kb <= kv:
			_draw_building(b)
			j += 1
		else:
			_draw_villager(v)
			k += 1


func _draw_plots() -> void:
	for b in sim.buildings:
		if b.get("rubble", false):
			continue
		var fp := ToxBuildings.footprint(int(b.rot), ToxBuildings.type_of(b))
		for j in range(fp.y):
			for i in range(fp.x):
				var c := Vector2i(int(b.x) + i, int(b.y) + j)
				var p := world_from_cell(Vector2(c.x + 0.5, c.y + 0.5))
				var pts := PackedVector2Array([p + Vector2(0, -HALF_H), p + Vector2(HALF_W, 0), p + Vector2(0, HALF_H), p + Vector2(-HALF_W, 0)])
				draw_colored_polygon(pts, Color(0.53, 0.82, 0.38, 0.13))

func _draw_entities(vr: Rect2) -> void:
	var view := _cell_view()
	var cover := _cover_cells()
	var objects: Array = sim.world.objects
	var blds: Array = []
	for b in sim.buildings:
		blds.append(b)
	blds.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return ToxBuildings.depth(a) < ToxBuildings.depth(b))
	var vils: Array = []
	for v in sim.villagers:
		if not v.dead and v.visible():
			vils.append(v)
	vils.sort_custom(func(a: ToxVillager, b: ToxVillager) -> bool: return (a.x + a.y) < (b.x + b.y))
	var i := 0
	var j := 0
	var k := 0
	while i < objects.size() or j < blds.size() or k < vils.size():
		var o: Variant = null
		while i < objects.size():
			var cand: Dictionary = objects[i]
			if cand.get("removed", false):
				i += 1
				continue
			var key := Vector2i(floori(float(cand.x)), floori(float(cand.y)))
			if cover.has(key) and ToxBuildings.decor(cand):
				i += 1
				continue
			o = cand
			break
		var b: Variant = blds[j] if j < blds.size() else null
		var v: Variant = vils[k] if k < vils.size() else null
		var ko := INF if o == null else float(o.x) + float(o.y)
		var kb := INF if b == null else ToxBuildings.depth(b)
		var kv: float = INF if v == null else float(v.x) + float(v.y)
		if b != null and kb <= ko and kb <= kv:
			_draw_building(b)
			j += 1
		elif v != null and kv <= ko:
			_draw_villager(v)
			k += 1
		elif o != null:
			_draw_object(o, view)
			i += 1
		else:
			break

func _cell_view() -> Rect2:
	var vr := _view_world_rect()
	var corners := [
		vr.position, Vector2(vr.end.x, vr.position.y),
		vr.end, Vector2(vr.position.x, vr.end.y)
	]
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for p in corners:
		var c := _cell_float(p)
		lo.x = minf(lo.x, c.x)
		lo.y = minf(lo.y, c.y)
		hi.x = maxf(hi.x, c.x)
		hi.y = maxf(hi.y, c.y)
	var pad := _view_cell_pad()
	return Rect2(lo - Vector2(pad, pad), hi - lo + Vector2(pad, pad) * 2.0)

func _cell_float(p: Vector2) -> Vector2:
	return Vector2(p.y / HALF_H * 0.5 + p.x / (HALF_W * 2.0), p.y / HALF_H * 0.5 - p.x / (HALF_W * 2.0))

func _cover_cells() -> Dictionary:
	var key := "%d:%d" % [sim.world.build_rev, sim.buildings.size()]
	if _cover_key == key:
		return _cover
	_cover_key = key
	_cover = {}
	for b in sim.buildings:
		if b.get("rubble", false):
			continue
		var fp := ToxBuildings.footprint(int(b.rot), ToxBuildings.type_of(b))
		for j in range(-1, fp.y + 1):
			for i in range(-1, fp.x + 1):
				_cover[Vector2i(int(b.x) + i, int(b.y) + j)] = true
	return _cover

func _draw_object(o: Dictionary, view: Rect2) -> void:
	if o.x < view.position.x or o.x > view.end.x or o.y < view.position.y or o.y > view.end.y:
		return
	var frame := ToxAtlasDB.sprite_frame(o)
	if frame.is_empty():
		return
	var sc := ToxAtlasDB.sprite_scale() * float(o.get("scale", 1.0))
	var size: Vector2 = frame.size * sc
	if size.x * zoom_px / WORLD_CELL < 2.5:
		return
	var pos := world_from_cell(Vector2(float(o.x), float(o.y)))
	if o.get("kind", "") == "tree":
		pos.x += sin(sim.time * 0.9 + float(o.get("phase", 0.0))) * 0.45
	var angle := 0.0
	if o.get("kind", "") == "tree" and float(o.get("shake_until", 0.0)) > sim.time:
		var left := float(o.shake_until) - sim.time
		angle = sin(sim.time * TAU * 7.0) * 0.038 * clampf(left / 0.35, 0.0, 1.0)
	var dest := Rect2(pos - size * Vector2(frame.ax, frame.ay), size)
	var kind := str(o.get("kind", ""))
	if kind == "tree":
		_draw_ground_shadow(pos, 0.36 * float(o.get("scale", 1.0)), 0.09)
	elif kind == "stone":
		_draw_ground_shadow(pos, 0.24 * float(o.get("scale", 1.0)), 0.08)
	elif kind == "bush":
		_draw_ground_shadow(pos, 0.20 * float(o.get("scale", 1.0)), 0.06)
	if absf(angle) > 0.0001:
		draw_set_transform(pos, angle, Vector2.ONE)
		draw_texture_rect_region(frame.tex, Rect2(-size * Vector2(frame.ax, frame.ay), size), frame.region)
		draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	else:
		draw_texture_rect_region(frame.tex, dest, frame.region)

func _draw_building(b: Dictionary) -> void:
	var type := ToxBuildings.type_of(b)
	var set: Dictionary = ToxAtlasDB.buildings.get(type, {})
	if set.is_empty():
		return
	var frame: Dictionary
	var set_mul := float(set.get("mul", 1.0))
	if b.get("rubble", false):
		frame = ToxAtlasDB.ruin_frame(type, int(b.rot))
	else:
		frame = ToxAtlasDB.building_frame(type, str(b.variant), int(b.rot))
	if frame.is_empty():
		return
	var sc: Vector2 = ToxAtlasDB.building_scale(set)
	var size: Vector2 = frame.size * sc
	var c := ToxBuildings.center(b)
	var shift := Vector2.ZERO
	var ground: Variant = frame.get("ground", null)
	if ground is Array and ground.size() >= 4:
		shift = Vector2((float(ground[0]) + float(ground[1])) * 0.5, (float(ground[2]) + float(ground[3])) * 0.5) * set_mul
	var pos := world_from_cell(c - shift)
	var dest := Rect2(pos - size * Vector2(frame.ax, frame.ay), size)
	var alpha := 1.0
	if b == edit_building:
		alpha = 0.55 + 0.45 * (0.5 + 0.5 * sin(sim.time * TAU / 0.9))
	var team: Color = ToxAtlasDB.TEAM_COLORS[int(b.get("owner", 0)) % 4]
	if not b.get("rubble", false):
		_draw_outline(frame, dest, team, alpha)
	draw_texture_rect_region(frame.tex, dest, frame.region, Color(1, 1, 1, alpha))
	if float(b.get("hp", 1)) < float(b.get("max_hp", 1)) and not b.get("rubble", false):
		_draw_bar(dest, float(b.hp) / maxf(1.0, float(b.max_hp)))

func _draw_villager(v: ToxVillager) -> void:
	var frame := ToxAtlasDB.character_frame(v.warrior, v.anim, v.frame_index(), v.rot)
	if frame.is_empty():
		return
	var ch: Dictionary = ToxAtlasDB.characters.get("warrior" if v.warrior else "villager", {})
	var sc := ToxAtlasDB.villager_scale(ch)
	var size: Vector2 = frame.size * sc
	var pos := world_from_cell(Vector2(v.x, v.y))
	var alpha := 1.0
	if v.appear_t > 0.0:
		alpha = 1.0 - clampf(v.appear_t / 0.5, 0.0, 1.0)
		size *= 0.85 + 0.15 * alpha
	if v.emerge_t > 0.0:
		alpha *= 1.0 - clampf(v.emerge_t / 0.55, 0.0, 1.0)
	if v.vanish_t > 0.0 and v.state != "entering":
		alpha *= 1.0 - clampf(v.vanish_t / 0.45, 0.0, 1.0)
	if alpha <= 0.02:
		return
	var dest := Rect2(pos - size * Vector2(frame.ax, frame.ay), size)
	var team: Color = ToxAtlasDB.TEAM_COLORS[v.owner % 4]
	if v.flinch > 0.0:
		dest.position.x += sin(sim.time * 140.0) * 2.0
	if v.selected:
		_draw_ring(pos, team, 0.36)
	_draw_outline(frame, dest, team, alpha)
	draw_texture_rect_region(frame.tex, dest, frame.region, Color(1, 1, 1, alpha))
	if v.hp < v.max_hp and v.warrior:
		_draw_bar(dest, v.hp / maxf(1.0, v.max_hp))

func _draw_outline(frame: Dictionary, dest: Rect2, color: Color, alpha: float) -> void:
	var sil := ToxAtlasDB.silhouette(frame)
	if sil == null:
		return
	var o := 1.4 / maxf(0.01, camera.zoom.x)
	for d in [Vector2(-o, 0), Vector2(o, 0), Vector2(0, -o), Vector2(0, o),
			Vector2(-o, -o), Vector2(o, -o), Vector2(-o, o), Vector2(o, o)]:
		draw_texture_rect(sil, Rect2(dest.position + d, dest.size), false, Color(color.r, color.g, color.b, alpha))

func _draw_ground_shadow(pos: Vector2, r: float, a: float) -> void:
	draw_set_transform(pos, 0.0, Vector2(1.25, 0.55))
	draw_circle(Vector2.ZERO, r, Color(0.03, 0.07, 0.03, a))
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)

func _draw_bar(dest: Rect2, ratio: float) -> void:
	var w := 34.0 / maxf(0.01, camera.zoom.x)
	var h := 4.0 / maxf(0.01, camera.zoom.x)
	var p := Vector2(dest.position.x + dest.size.x * 0.5 - w * 0.5, dest.position.y - h * 2.0)
	draw_rect(Rect2(p, Vector2(w, h)), Color(0.1, 0.07, 0.04, 0.75), true)
	draw_rect(Rect2(p, Vector2(maxf(0.0, w * clampf(ratio, 0.0, 1.0)), h)), Color("#7dc75e"), true)

func _draw_ring(pos: Vector2, color: Color, r: float) -> void:
	draw_set_transform(pos, 0.0, Vector2(1.4, 0.7))
	draw_circle(Vector2.ZERO, r, Color(color.r, color.g, color.b, 0.20))
	draw_arc(Vector2.ZERO, r, 0.0, TAU, 40, color, 1.6 / maxf(0.01, camera.zoom.x), true)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)

func add_float(text: String, cell: Vector2, color: Color = Color("#fdf6e3")) -> void:
	floats.append({"text": text, "pos": world_from_cell(cell), "t": 1.6, "color": color})

func _draw_overlays() -> void:
	for f in floats:
		var p: Vector2 = f.pos + Vector2(0, -34.0 * (1.6 - float(f.t)) / 1.6)
		var font := ThemeDB.fallback_font
		var a := clampf(float(f.t) / 0.8, 0.0, 1.0)
		var col: Color = f.color
		col.a = a
		draw_string(font, p - Vector2(0, 16), str(f.text), HORIZONTAL_ALIGNMENT_CENTER, 80, 16, col)
	if selected_building != null:
		_draw_footprint(selected_building, Color(1, 1, 1, 0.10), Color(1, 0.96, 0.8, 0.95), 1.6)
		if selected_building.get("rubble", false):
			pass
	if selected_villager != null and not selected_villager.dead:
		_draw_ring(world_from_cell(Vector2(selected_villager.x, selected_villager.y)), Color("#fdf6e3"), 0.42)
	if mode == Mode.PLACE and not ghost_b.is_empty():
		_draw_footprint(ghost_b, Color(0.32, 0.92, 0.48, 0.24) if ghost_ok else Color(0.95, 0.34, 0.27, 0.28),
			Color(0.42, 1.0, 0.58, 0.95) if ghost_ok else Color(1.0, 0.48, 0.4, 0.95), 1.8)
		_draw_building_alpha(ghost_b, 0.62)
	elif mode == Mode.EDIT and edit_building != null:
		_draw_footprint(edit_building, Color(0.32, 0.92, 0.48, 0.20) if edit_ok else Color(0.95, 0.34, 0.27, 0.24),
			Color(0.42, 1.0, 0.58, 0.95) if edit_ok else Color(1.0, 0.48, 0.4, 0.95), 1.8)
	if mode == Mode.ORDER and order_cell.x >= 0:
		_draw_diamond(order_cell, Color(0.5, 0.95, 0.65, 0.22), Color(0.8, 1.0, 0.86, 0.9), 1.6)
	if hover_cell.x >= 0 and mode == Mode.NORMAL:
		_draw_diamond(hover_cell, Color(1, 1, 1, 0.035), Color(1, 1, 1, 0.42), 1.0)

func _draw_building_alpha(b: Dictionary, alpha: float) -> void:
	var type := ToxBuildings.type_of(b)
	var set: Dictionary = ToxAtlasDB.buildings.get(type, {})
	if set.is_empty():
		return
	var frame := ToxAtlasDB.building_frame(type, str(b.variant), int(b.rot))
	if frame.is_empty():
		return
	var sc: Vector2 = ToxAtlasDB.building_scale(set)
	var size: Vector2 = frame.size * sc
	var c := ToxBuildings.center(b)
	var shift := Vector2.ZERO
	var ground: Variant = frame.get("ground", null)
	if ground is Array and ground.size() >= 4:
		shift = Vector2((float(ground[0]) + float(ground[1])) * 0.5, (float(ground[2]) + float(ground[3])) * 0.5) * float(set.get("mul", 1.0))
	var pos := world_from_cell(c - shift)
	var dest := Rect2(pos - size * Vector2(frame.ax, frame.ay), size)
	draw_texture_rect_region(frame.tex, dest, frame.region, Color(1, 1, 1, alpha))

func _draw_footprint(b: Dictionary, fill: Color, line: Color, width: float) -> void:
	for c in ToxBuildings.cells(b):
		_draw_diamond(c, fill, line, width)

func _draw_diamond(cell: Vector2i, fill: Color, line: Color, width: float) -> void:
	var c := world_from_cell(Vector2(cell.x + 0.5, cell.y + 0.5))
	var pts := PackedVector2Array([
		c + Vector2(0, -HALF_H), c + Vector2(HALF_W, 0),
		c + Vector2(0, HALF_H), c + Vector2(-HALF_W, 0)
	])
	draw_colored_polygon(pts, fill)
	var closed := pts.duplicate()
	closed.append(pts[0])
	draw_polyline(closed, line, width / maxf(0.01, camera.zoom.x))

func _draw_waves() -> void:
	# A few low-poly wave crests near the coast, deterministic and cheap.
	var set: Dictionary = ToxAtlasDB.waves
	if set.is_empty():
		return
	var frames: Dictionary = set.get("frames", {})
	if frames.is_empty():
		return
	var att := ToxAtlasDB.characters
	var count := 0
	for o in sim.world.objects:
		if count > 80:
			break
		var x := floori(float(o.x))
		var y := floori(float(o.y))
		if sim.world.tile_at(x, y) != ToxWorldGen.T_SHALLOW:
			continue
		if int(float(o.x) * 13.0 + float(o.y) * 7.0) % 7 != 0:
			continue
		var key := "wave_%d_%d" % [int(fmod(float(o.x) + float(o.y), 5.0)), 0 if int(o.x) % 2 == 0 else 90]
		var f: Dictionary = frames.get(key, frames.values()[0])
		var sc := 64.0 / float(set.get("ppu", 120.0)) * 0.55
		var size: Vector2 = f.size * sc
		var pos := world_from_cell(Vector2(float(o.x) + 0.2, float(o.y) + 0.2))
		pos.y += sin(sim.time * 1.4 + float(o.x)) * 1.2
		draw_texture_rect_region(f.tex, Rect2(pos - size * Vector2(f.ax, f.ay), size), f.region, Color(1, 1, 1, 0.52))
		count += 1
