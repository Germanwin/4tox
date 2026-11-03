extends SceneTree

## Performance gate: 600 villagers plus the whole island through the merged
## layer, 1440x900, zoom 40. Reports CPU draw time and real frame throughput
## with vsync off. This is the "60 fps at 600 villagers" criterion, measured.

const WorldData = preload("res://scripts/world_data.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
const Nature = preload("res://scripts/nature.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const VillagersData = preload("res://scripts/villagers_data.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")
const DIR := "res://tests/fixtures"
const COUNT := 600
const FRAMES := 120


func _init() -> void:
	_run()


func _run() -> void:
	var world = WorldData.new()
	world.load_json(FileAccess.get_file_as_string(DIR + "/world.json"))
	var sj: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/scene_objects.json"))
	var objects: Array = sj["objects"]
	var bj: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/scene_buildings.json"))
	var buildings: Array = bj["buildings"]

	var nature = Nature.new()
	nature.load_atlas()
	var bdata = BuildingsData.new()
	var vdata = VillagersData.new()

	var hall := {"x": 102.0, "y": 92.0}
	for b in buildings:
		if str(b.get("type", "")) == "townhall":
			hall = {"x": float(b["x"]), "y": float(b["y"])}
	var villagers: Array = []
	var args := OS.get_cmdline_user_args()
	if args.has("noobj"):
		objects = []
	if args.has("novill"):
		villagers = []
	var n := 0
	var ring := 0
	while n < COUNT and not args.has("novill"):
		ring += 1
		for dy in range(-ring, ring + 1):
			for dx in range(-ring, ring + 1):
				if absi(dx) != ring and absi(dy) != ring:
					continue
				var x := float(hall["x"]) + 3.0 + float(dx) * 1.1
				var y := float(hall["y"]) + 3.0 + float(dy) * 1.1
				if not world.is_land_at(int(x), int(y)):
					continue
				villagers.append({
					"id": 1000 + n, "x": x, "y": y, "rot": (n % 8) * 45,
					"anim": "walk", "phase": float(n % 100) / 100.0,
					"owner": 0, "hidden": false
				})
				n += 1
				if n >= COUNT:
					break
			if n >= COUNT:
				break

	var cache: Dictionary = GroundCache.build(world)
	root.size = Vector2i(1440, 900)
	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(cache["image"])
	sprite.centered = false
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	var cam := {"x": float(hall["x"]) + 2.0, "y": float(hall["y"]) + 1.5, "zoom": 40.0}
	var z := 40.0
	var k := z / float(cache["px"])
	var cam_px := (0.0 - float(cam["x"]) + float(cam["y"])) * z * 0.5
	var cam_py := (0.0 - float(cam["x"]) - float(cam["y"])) * z * 0.25
	var mid_x := float(cache["off_x"])
	sprite.scale = Vector2(k, k)
	sprite.position = Vector2(720.0 + cam_px - mid_x * k, 450.0 + cam_py)
	root.add_child(sprite)

	var layer = WorldLayer.new()
	layer.objects = objects
	layer.buildings = buildings
	layer.villagers = villagers
	layer.nature = nature
	layer.bdata = bdata
	layer.vdata = vdata
	layer.cam = cam
	layer.show_plots = false
	layer.lod = 0.0
	layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	root.add_child(layer)
	if OS.get_cmdline_user_args().has("noshader"):
		layer.material = null

	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	# Прогрев: первые кадры собирают кэши кадров, каймы и текстур.
	for i in range(10):
		layer.queue_redraw()
		await process_frame
	var t0 := Time.get_ticks_usec()
	var pan := OS.get_cmdline_user_args().has("pan")
	for i in range(FRAMES):
		if pan:
			layer.cam["x"] = float(layer.cam["x"]) + 0.01
		layer.queue_redraw()
		await process_frame
	var total := float(Time.get_ticks_usec() - t0) / 1000.0
	print("жителей %d, объектов %d, нарисовано %d, pick %d, сборок меша %d" % [COUNT, objects.size(), layer.drawn, layer.picks, layer.mesh_builds])
	print("кадр: %.2f мс (%.0f fps), отрисовка слоя: %.2f мс" % [
		total / FRAMES, 1000.0 * FRAMES / total, layer.draw_ms])
	quit(0)
