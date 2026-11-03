extends SceneTree

## Ground + plots + buildings at a browser reference camera. No nature, no
## villagers: this slice checks building scale, anchor, ground shift and draw
## order, and the plot turf now included in the browser reference.
##
## Run: Godot --path . -s res://tests/render_build.gd -- build_z40

const WorldData = preload("res://scripts/world_data.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")
var DIR := "res://tests/fixtures"

const VIGNETTE := """
shader_type canvas_item;
void fragment() {
	vec2 sz = vec2(1440.0, 900.0);
	vec2 p = SCREEN_UV * sz - sz * 0.5;
	float r = length(p);
	float r0 = min(sz.x, sz.y) * 0.35;
	float r1 = max(sz.x, sz.y) * 0.75;
	float a = clamp((r - r0) / (r1 - r0), 0.0, 1.0) * 0.42;
	COLOR = vec4(vec3(4.0, 16.0, 24.0) / 255.0, a);
}
"""


func _init() -> void:
	var env := OS.get_environment("TOX_FIXTURES")
	if env != "":
		DIR = env
	_run()


func _run() -> void:
	var tag := "build_z40"
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		tag = args[0]
	var scene: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/scene.json"))
	if scene == null:
		print("нет scene.json")
		quit(1)
		return
	var shot: Dictionary = {}
	for s in scene["shots"]:
		if str(s["file"]) == "ref_" + tag + ".png":
			shot = s
			break
	if shot.is_empty():
		print("в scene.json нет кадра ref_" + tag)
		quit(1)
		return
	var cam: Dictionary = shot["cam"]

	var world = WorldData.new()
	var lr: Dictionary = world.load_json(FileAccess.get_file_as_string(DIR + "/world.json"))
	if not lr.get("ok", false):
		print("мир не загрузился")
		quit(1)
		return
	var bj: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/scene_buildings.json"))
	var buildings: Array = bj["buildings"] if bj != null else []
	var bdata = BuildingsData.new()

	var cache: Dictionary = await GroundCache.build_async(world, self)
	root.size = Vector2i(1440, 900)

	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(cache["image"])
	sprite.centered = false
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	var z := float(cam["zoom"])
	var px := float(cache["px"])
	var k := z / px
	var cam_px := (0.0 - float(cam["x"]) + float(cam["y"])) * z * 0.5
	var cam_py := (0.0 - float(cam["x"]) - float(cam["y"])) * z * 0.25
	var mid_x := float(cache["off_x"])
	sprite.scale = Vector2(k, k)
	sprite.position = Vector2(720.0 + cam_px - mid_x * k, 450.0 + cam_py)
	root.add_child(sprite)

	var layer = WorldLayer.new()
	layer.buildings = buildings
	layer.bdata = bdata
	layer.cam = cam
	layer.show_plots = true
	layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	layer.lod = 1.0 if z < 32.0 else 0.0
	root.add_child(layer)
	print("построек %d, первый кадр %s" % [buildings.size(), str(bdata.frame_for(
		str(buildings[0].get("type", "townhall")), str(buildings[0].get("variant", "a")),
		int(buildings[0].get("rot", 0))).get("w", -1)) if buildings.size() > 0 else "нет"])

	var veil_layer := CanvasLayer.new()
	root.add_child(veil_layer)
	var veil := ColorRect.new()
	veil.size = Vector2(1440, 900)
	veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var mat := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = VIGNETTE
	mat.shader = sh
	veil.material = mat
	veil_layer.add_child(veil)

	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var out := root.get_texture().get_image()
	var path := DIR + "/out_" + tag + ".png"
	var err := out.save_png(path)
	print("кадр сохранён: ", path, " err=", err)
	quit(0)
