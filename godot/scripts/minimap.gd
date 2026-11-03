class_name ToxMinimap
extends Control

signal cell_clicked(cell: Vector2i)

var sim: ToxSim
var view: ToxWorldView
var _tex: Texture2D
var _key := ""
var _map_rect := Rect2()

func _ready() -> void:
	custom_minimum_size = Vector2(190, 190)
	mouse_filter = Control.MOUSE_FILTER_STOP

func bind(p_sim: ToxSim, p_view: ToxWorldView) -> void:
	sim = p_sim
	view = p_view
	_tex = null
	_key = ""
	queue_redraw()

func _world_texture() -> void:
	if sim == null:
		return
	var w := sim.world
	var key := "%s:%d" % [w.seed_text, w.build_rev]
	if _key == key and _tex != null:
		return
	_key = key
	var img := Image.create_empty(w.width, w.height, false, Image.FORMAT_RGBA8)
	for y in range(w.height):
		for x in range(w.width):
			var t := w.tile[y * w.width + x]
			var c := Color("#164e80")
			match t:
				ToxWorldGen.T_GRASS:
					c = Color("#7dc75e")
					if w.forestness[y * w.width + x] > 0.35:
						c = Color("#4e9a34")
				ToxWorldGen.T_SAND:
					c = Color("#f0dca2")
				ToxWorldGen.T_SHALLOW:
					c = Color("#56b0cd")
				ToxWorldGen.T_WATER:
					c = Color("#2670a6")
				ToxWorldGen.T_DEEP:
					c = Color("#164e80")
			img.set_pixel(x, y, c)
	_tex = ImageTexture.create_from_image(img)

func _process(_dt: float) -> void:
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color(0.04, 0.1, 0.16, 0.9), true)
	if sim == null:
		return
	_world_texture()
	var pad := 8.0
	var avail := size - Vector2(pad * 2, pad * 2)
	var w := float(sim.world.width)
	var h := float(sim.world.height)
	var sc := minf(avail.x / w, avail.y / h)
	var mw := w * sc
	var mh := h * sc
	_map_rect = Rect2((size - Vector2(mw, mh)) * 0.5, Vector2(mw, mh))
	draw_texture_rect(_tex, _map_rect, false)
	# Buildings
	for b in sim.buildings:
		if b.get("rubble", false):
			continue
		var r := ToxBuildings.bounds(b)
		var col: Color = ToxAtlasDB.TEAM_COLORS[int(b.get("owner", 0)) % 4]
		var p := _map_rect.position + Vector2(r.position.x * sc, r.position.y * sc)
		draw_rect(Rect2(p, Vector2(maxf(2.0, r.size.x * sc), maxf(2.0, r.size.y * sc))), col, true)
	# Villagers
	for v in sim.villagers:
		if v.dead:
			continue
		var col: Color = ToxAtlasDB.TEAM_COLORS[v.owner % 4]
		var p := _map_rect.position + Vector2(v.x * sc, v.y * sc)
		draw_circle(p, 1.3, Color(0.05, 0.04, 0.03))
		draw_circle(p, 0.9, col)
	# Frame
	draw_rect(Rect2(Vector2.ZERO, size), Color("#4a3220"), false, 3.0)

func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		if _map_rect.has_point(event.position):
			var u: float = (event.position.x - _map_rect.position.x) / _map_rect.size.x
			var v: float = (event.position.y - _map_rect.position.y) / _map_rect.size.y
			emit_signal("cell_clicked", Vector2i(int(u * sim.world.width), int(v * sim.world.height)))
			accept_event()
