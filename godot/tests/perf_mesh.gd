extends SceneTree

## Batching probe: all visible nature quads in ONE ArrayMesh draw.
## Answers whether a canvas mesh removes the per-sprite wall.

const WorldData = preload("res://scripts/world_data.gd")
const Nature = preload("res://scripts/nature.gd")
const DIR := "res://tests/fixtures"
const FRAMES := 120

var _meshes: Array = []
var _drawn := 0


class MeshLayer:
	extends Node2D
	var meshes: Array = []
	func _draw() -> void:
		for m in meshes:
			draw_mesh(m[0], m[1])


func _init() -> void:
	_run()


func _run() -> void:
	var world = WorldData.new()
	world.load_json(FileAccess.get_file_as_string(DIR + "/world.json"))
	var sj: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/scene_objects.json"))
	var objects: Array = sj["objects"]
	var nature = Nature.new()
	nature.load_atlas()
	var cam := {"x": 104.0, "y": 93.5, "zoom": 40.0}
	var z := 40.0
	var base := z / float(nature.ppu) * float(nature.mul)
	var hw := 720.0
	var hh := 450.0
	var cx := float(cam["x"])
	var cy := float(cam["y"])

	# Один меш на пачку до 6000 квадов: индексы u32.
	var verts := PackedVector3Array()
	var uvs := PackedVector2Array()
	var idx := PackedInt32Array()
	var n := 0
	for o in objects:
		var ox := float(o["x"])
		var oy := float(o["y"])
		var vx := (ox - oy - cx + cy) * z * 0.5
		var vy := (ox + oy - cx - cy) * z * 0.25
		if absf(vx) > hw + 200.0 or absf(vy) > hh + 200.0:
			continue
		var spr: Dictionary = nature.pick(o)
		if spr.is_empty():
			continue
		var sc := base * float(o.get("scale", 1.0))
		var dw := float(spr["w"]) * sc
		var dh := float(spr["h"]) * sc
		var px := 720.0 + vx - dw * float(spr["ax"])
		var py := 450.0 + vy - dh * float(spr["ay"])
		var tw := float(nature.atlas.get_width())
		var th := float(nature.atlas.get_height())
		var u0 := float(spr["x"]) / tw
		var v0 := float(spr["y"]) / th
		var u1 := float(spr["x"] + spr["w"]) / tw
		var v1 := float(spr["y"] + spr["h"]) / th
		var b := verts.size()
		verts.append(Vector3(px, py, 0))
		verts.append(Vector3(px + dw, py, 0))
		verts.append(Vector3(px + dw, py + dh, 0))
		verts.append(Vector3(px, py + dh, 0))
		uvs.append(Vector2(u0, v0))
		uvs.append(Vector2(u1, v0))
		uvs.append(Vector2(u1, v1))
		uvs.append(Vector2(u0, v1))
		idx.append_array([b, b + 1, b + 2, b, b + 2, b + 3])
		n += 1

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = idx
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

	var layer := MeshLayer.new()
	layer.meshes = [[mesh, nature.atlas]]
	root.add_child(layer)
	_drawn = n
	root.size = Vector2i(1440, 900)

	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	for i in range(10):
		layer.queue_redraw()
		await process_frame
	var t0 := Time.get_ticks_usec()
	for i in range(FRAMES):
		layer.queue_redraw()
		await process_frame
	var total := float(Time.get_ticks_usec() - t0) / 1000.0
	print("квадов %d, кадр %.2f мс (%.0f fps)" % [_drawn, total / FRAMES, 1000.0 * FRAMES / total])
	quit(0)
