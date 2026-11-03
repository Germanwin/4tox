extends SceneTree

## Кадр руин: пять типов завалов одним проходом WorldLayer — проверка, что
## атлас `ruins` берётся по типу, а ppu/mul кадра не сдвигают завал с пятна.
## В пиксельный гейт не входит: эталона браузера для руин в фикстурах нет.
##
## Запуск: Godot --path . -s res://tests/render_ruins.gd

const WorldData = preload("res://scripts/world_data.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")

const TYPES := ["townhall", "house", "lumbercamp", "barracks", "warcamp"]


func _init() -> void:
	_run()


func _run() -> void:
	var world = WorldData.new()
	var lr: Dictionary = world.load_json(FileAccess.get_file_as_string("res://tests/fixtures/world.json"))
	if not lr.get("ok", false):
		print("мир не загрузился")
		quit(1)
		return
	var bdata = BuildingsData.new()
	var buildings: Array = []
	var x0 := 96
	var x := x0
	var y := 92
	var i := 0
	for t in TYPES:
		var f: Dictionary = bdata.frame_for("ruins", t, 90)
		var fp: Array = f["fp"] if not f.is_empty() else [3, 3]
		buildings.append({
			"id": "ruin:%d" % i, "type": t, "variant": "a", "rot": 90,
			"x": x, "y": y, "owner": 0, "town": 0, "rubble": true,
			"hp": 0, "maxHp": 100
		})
		x += int(fp[0]) + 2
		i += 1
	# Камера — на середину ряда завалов.
	var cam := {"x": float(x0 + x) * 0.5, "y": float(y) + 1.5, "zoom": 64.0}
	var cache: Dictionary = await GroundCache.build_async(world, self)
	root.size = Vector2i(1440, 900)
	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(cache["image"])
	sprite.centered = false
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	var z := float(cam["zoom"])
	var px := float(cache["px"])
	var k := z / px
	sprite.scale = Vector2(k, k)
	sprite.position = Vector2(720.0 + (float(cam["y"]) - float(cam["x"])) * z * 0.5 - float(cache["off_x"]) * k,
		450.0 - (float(cam["x"]) + float(cam["y"])) * z * 0.25)
	root.add_child(sprite)
	var layer = WorldLayer.new()
	layer.buildings = buildings
	layer.bdata = bdata
	layer.cam = cam
	layer.show_plots = false
	layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	root.add_child(layer)
	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	var err := img.save_png("res://shots/ruins.png")
	print("кадр руин: res://shots/ruins.png err=", err, " завалов ", buildings.size())
	quit(0)
