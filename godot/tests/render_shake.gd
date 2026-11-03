extends SceneTree

## Кадр удара по дереву: тот же мир и камера, что в эталоне, одно дерево
## трясётся в первой четверти периода. Смотреть глазами: ствол наклонён/
## сдвинут, остальные стоят. Запуск: Godot --path . -s res://tests/render_shake.gd

const WorldData = preload("res://scripts/world_data.gd")
const Nature = preload("res://scripts/nature.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")


func _init() -> void:
	_run()


func _run() -> void:
	var world = WorldData.new()
	var lr: Dictionary = world.load_json(FileAccess.get_file_as_string("res://tests/fixtures/world.json"))
	if not lr.get("ok", false):
		print("мир не загрузился")
		quit(1)
		return
	var scene: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/scene.json"))
	var cam := {"x": float(world.width) * 0.5, "y": float(world.height) * 0.5, "zoom": 40.0}
	for s in scene["shots"]:
		if str(s["file"]) == "ref_full_z40.png":
			cam = s["cam"]
			break
	var layer = WorldLayer.new()
	layer.objects = world.objects
	layer.nature = Nature.new()
	layer.nature.load_atlas()
	layer.show_plots = false
	layer.cam = cam
	layer.css = Vector2(1440, 900)
	layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	# Дерево ближе к центру кадра.
	var best := ""
	var best_d := INF
	for o in world.objects:
		if str(o.get("kind", "")) != "tree":
			continue
		var d: float = abs(float(o["x"]) - float(cam["x"])) + abs(float(o["y"]) - float(cam["y"]))
		if d < best_d:
			best_d = d
			best = str(o.get("id", ""))
	var now := Time.get_ticks_msec()
	layer.set_shake({best: now - 35}, now)
	root.add_child(layer)
	var cache: Dictionary = await GroundCache.build_async(world, self)
	root.size = Vector2i(1440, 900)
	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(cache["image"])
	sprite.centered = false
	var z := float(cam["zoom"])
	var k := z / float(cache["px"])
	sprite.scale = Vector2(k, k)
	sprite.position = Vector2(720.0 + (float(cam["y"]) - float(cam["x"])) * z * 0.5 - float(cache["off_x"]) * k,
		450.0 - (float(cam["x"]) + float(cam["y"])) * z * 0.25)
	root.add_child(sprite)
	root.move_child(sprite, 0)
	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	var err := img.save_png("res://shots/shake.png")
	print("кадр тряски: res://shots/shake.png err=", err, " дерево ", best)
	quit(0)
