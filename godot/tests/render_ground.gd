extends SceneTree

## Renders the ground cache of the reference scene at the same camera and zoom
## as the browser, applies the same screen-space vignette and saves a PNG.
## Then test_render.gd diffs it against the browser frame.
##
## Run: Godot --path . -s res://tests/render_ground.gd -- z40

const WorldData = preload("res://scripts/world_data.gd")
const GroundCache = preload("res://scripts/ground_cache.gd")
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
	var tag := "z40"
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		tag = args[0]

	var scene: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/scene.json"))
	if scene == null:
		print("нет scene.json: node godot/tests/capture_reference.js")
		quit(1)
		return
	var shot: Dictionary = {}
	for s in scene["shots"]:
		if str(s["file"]).begins_with("ref_" + tag):
			shot = s
			break
	if shot.is_empty():
		print("в scene.json нет кадра " + tag)
		quit(1)
		return
	var cam: Dictionary = shot["cam"]

	var world = WorldData.new()
	var lr: Dictionary = world.load_json(FileAccess.get_file_as_string(DIR + "/world.json"))
	if not lr.get("ok", false):
		print("мир не загрузился: ", lr.get("error", ""))
		quit(1)
		return

	var cache: Dictionary = await GroundCache.build_async(world, self)
	var img: Image = cache["image"]
	print("кэш %dx%d, px %d, off_x %.0f" % [img.get_width(), img.get_height(), cache["px"], cache["off_x"]])

	root.size = Vector2i(1440, 900)
	var sprite := Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(img)
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

	var layer := CanvasLayer.new()
	root.add_child(layer)
	var veil := ColorRect.new()
	veil.size = Vector2(1440, 900)
	veil.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var mat := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = VIGNETTE
	mat.shader = sh
	veil.material = mat
	layer.add_child(veil)

	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var out := root.get_texture().get_image()
	var path := DIR + "/out_" + tag + ".png"
	var err := out.save_png(path)
	print("кадр сохранён: ", path, " err=", err, " ", out.get_width(), "x", out.get_height(),
		" k=", k, " pos=", sprite.position)
	quit(0)
