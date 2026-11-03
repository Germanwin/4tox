class_name ToxMatchMinimap
extends Control

## Обзор острова: та же карта, что в браузере (`minimap.gd` прототипа рисовал
## по ToxSim, здесь — по статическому миру WLD1 и снимку). Клик по обзору
## переносит камеру; прямоугольник показывает, что видно сейчас.

signal cell_clicked(cell: Vector2i)

var world = null
var buildings: Array = []
var villagers: Array = []
var cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var css := Vector2(1440, 900)
var town_colors: Array = ["#4a90d9"]

var _base: ImageTexture = null
var _base_key := ""


func _ready() -> void:
	custom_minimum_size = Vector2(196, 168)
	mouse_filter = Control.MOUSE_FILTER_STOP
	clip_contents = true


func set_world(w) -> void:
	world = w
	_base = null
	queue_redraw()


func set_snapshot(buildings_list: Array, villagers_list: Array, colors: Array) -> void:
	buildings = buildings_list
	villagers = villagers_list
	if not colors.is_empty():
		town_colors = colors
	queue_redraw()


func set_camera(x: float, y: float, z: float, viewport: Vector2) -> void:
	cam["x"] = x
	cam["y"] = y
	cam["zoom"] = z
	css = viewport
	queue_redraw()


func _build_base() -> void:
	if world == null:
		return
	var w := int(world.width)
	var h := int(world.height)
	var key := "%d|%d|%s" % [w, h, str(world.worldgen_hash)]
	if key == _base_key and _base != null:
		return
	_base_key = key
	var img := Image.create_empty(w, h, false, Image.FORMAT_RGBA8)
	var grass := Color("#7dc75e")
	var grass_dark := Color("#5aa844")
	var sand := Color("#f0dca2")
	var shallow := Color("#6fc3d8")
	var water := Color("#3f8fbf")
	var deep := Color("#1f4f78")
	for y in range(h):
		for x in range(w):
			var t: int = world.tile_at(x, y)
			var c := deep
			if t == 4:
				c = grass if ((x + y) % 7) != 0 else grass_dark
			elif t == 3:
				c = sand
			elif t == 2:
				c = shallow
			elif t == 1:
				c = water
			img.set_pixel(x, y, c)
	_base = ImageTexture.create_from_image(img)


func _map_rect() -> Rect2:
	if world == null:
		return Rect2(Vector2.ZERO, size)
	var ww := float(world.width)
	var wh := float(world.height)
	var k := minf(size.x / ww, size.y / wh)
	return Rect2(Vector2((size.x - ww * k) * 0.5, (size.y - wh * k) * 0.5),
		Vector2(ww * k, wh * k))


func _draw() -> void:
	if world == null:
		return
	_build_base()
	var r := _map_rect()
	if _base != null:
		draw_texture_rect(_base, r, false, Color.WHITE)
	# Постройки: 4 px цветом команды; ратуша крупнее.
	for b in buildings:
		if bool(b.get("rubble", false)):
			continue
		var p := r.position + Vector2(float(b["x"]) / float(world.width) * r.size.x,
			float(b["y"]) / float(world.height) * r.size.y)
		var sz := 6.0 if str(b.get("type", "")) == "townhall" else 4.0
		var c := _team(int(b.get("owner", 0)))
		draw_rect(Rect2(p - Vector2(sz * 0.5, sz * 0.5), Vector2(sz, sz)), c)
		draw_rect(Rect2(p - Vector2(sz * 0.5, sz * 0.5), Vector2(sz, sz)),
			Color(0.05, 0.03, 0.02, 0.8), false, 1.0)
	# Жители: точка в 2 px.
	for v in villagers:
		if bool(v.get("hidden", false)):
			continue
		var p := r.position + Vector2(float(v["x"]) / float(world.width) * r.size.x,
			float(v["y"]) / float(world.height) * r.size.y)
		var c := Color("#fdf6e3") if bool(v.get("warrior", false)) else Color("#2f2216")
		draw_circle(p, 1.6, c)
	# Прямоугольник камеры: границы экрана, переведённые в клетки.
	var hw := css.x * 0.5 / (float(cam["zoom"]) * 0.5)
	var hh := css.y * 0.5 / (float(cam["zoom"]) * 0.25)
	var cx := float(cam["x"])
	var cy := float(cam["y"])
	# Экранный прямоугольник в изометрии — ромб; для обзора достаточно
	# описанного прямоугольника по четырём углам.
	var pts: Array[Vector2] = []
	for p in [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]:
		var wx: float = cx + (float(p[1]) * 2.0 + float(p[0])) / float(cam["zoom"])
		var wy: float = cy + (float(p[1]) * 2.0 - float(p[0])) / float(cam["zoom"])
		pts.append(r.position + Vector2(wx / float(world.width) * r.size.x,
			wy / float(world.height) * r.size.y))
	var view := PackedVector2Array([pts[0], pts[1], pts[2], pts[3], pts[0]])
	draw_polyline(view, Color(1.0, 0.97, 0.86, 0.9), 1.5)
	draw_rect(Rect2(Vector2.ZERO, size), Color(0.25, 0.16, 0.08, 0.55), false, 2.0)


func _team(owner: int) -> Color:
	var hex := "#4a90d9"
	if owner >= 0 and owner < town_colors.size():
		hex = str(town_colors[owner])
	hex = hex.replace("#", "")
	if hex.length() != 6:
		hex = "4a90d9"
	return Color8(("0x" + hex.substr(0, 2)).hex_to_int(),
		("0x" + hex.substr(2, 2)).hex_to_int(),
		("0x" + hex.substr(4, 2)).hex_to_int())


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed \
			and (event as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT:
		var pos := (event as InputEventMouseButton).position
		var r := _map_rect()
		if not r.has_point(pos) or world == null:
			return
		var cell := Vector2i(
			int((pos.x - r.position.x) / r.size.x * float(world.width)),
			int((pos.y - r.position.y) / r.size.y * float(world.height)))
		cell_clicked.emit(cell)
		accept_event()
