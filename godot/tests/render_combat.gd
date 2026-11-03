extends SceneTree

## Кадр боевого состояния: повреждённая ратуша (HP-полоса), руина дома,
## раненый воин с флинчем. Геометрия и атласы те же, что в игре; снимок
## синтетический — правила боя здесь не проверяются, проверяется КАРТИНКА.
## Запуск: Godot --path . -s res://tests/render_combat.gd

const WorldData = preload("res://scripts/world_data.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const VillagersData = preload("res://scripts/villagers_data.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")
const MatchFx = preload("res://scripts/match_fx.gd")


func _init() -> void:
	_run()


func _run() -> void:
	var scene: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/scene.json"))
	var cam := {"x": 104.0, "y": 93.5, "zoom": 40.0}
	for s in scene["shots"]:
		if str(s["file"]) == "ref_full_z40.png":
			cam = s["cam"]
			break
	var world = WorldData.new()
	world.load_json(FileAccess.get_file_as_string("res://tests/fixtures/world.json"))
	var bj: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/scene_buildings.json"))
	var vj: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/scene_villagers.json"))
	var buildings: Array = bj["buildings"] if bj != null else []
	var villagers: Array = vj["villagers"] if vj != null else []
	# Камера — на деревню игрока, иначе HP-полоса и руина теряются в общем плане.
	for b in buildings:
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == 0:
			cam = {"x": float(b["x"]) + 2.0, "y": float(b["y"]) + 1.5, "zoom": 64.0}
			break
	var hurt_hall := false
	var made_ruin := false
	for b in buildings:
		if not hurt_hall and str(b.get("type", "")) == "townhall":
			b["hp"] = 42.0
			b["maxHp"] = 120.0
			hurt_hall = true
		elif not made_ruin and str(b.get("type", "")) == "lumbercamp":
			b["rubble"] = true
			b["hp"] = 0.0
			made_ruin = true
	var hurt_warrior := false
	for v in villagers:
		if not bool(v.get("warrior", false)):
			v["warrior"] = 1
			v["anim"] = "idle"
			v["hp"] = 8.0
			v["flinch"] = 1.0
			hurt_warrior = true
			break

	var cache: Dictionary = await GroundCache.build_async(world, self)
	root.size = Vector2i(1440, 900)
	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(cache["image"])
	sprite.centered = false
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	var z := float(cam["zoom"])
	var k := z / float(cache["px"])
	sprite.scale = Vector2(k, k)
	sprite.position = Vector2(720.0 + (float(cam["y"]) - float(cam["x"])) * z * 0.5 - float(cache["off_x"]) * k,
		450.0 - (float(cam["x"]) + float(cam["y"])) * z * 0.25)
	root.add_child(sprite)
	var layer = WorldLayer.new()
	layer.buildings = buildings
	layer.villagers = villagers
	layer.bdata = BuildingsData.new()
	layer.vdata = VillagersData.new()
	layer.cam = cam
	layer.css = Vector2(1440, 900)
	layer.show_plots = false
	layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	root.add_child(layer)
	var fx = MatchFx.new()
	fx.cam = cam
	fx.css = Vector2(1440, 900)
	fx.zoom = z
	fx.buildings = buildings
	fx.villagers = villagers
	fx.team_color = Color("#4a90d9")
	fx.selected_villagers = [str(villagers[0].get("id", ""))] if villagers.size() > 0 else []
	root.add_child(fx)
	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	var err := img.save_png("res://shots/combat.png")
	print("кадр боя: res://shots/combat.png err=", err,
		" · ратуша ", hurt_hall, " · руина ", made_ruin, " · воин ", hurt_warrior)
	quit(0)
