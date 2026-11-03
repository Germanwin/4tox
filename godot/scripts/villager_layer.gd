class_name ToxVillagerLayer
extends Node2D

## People: frame by animation phase, nearest of eight rotations, SHRINK 2.2,
## depth by x+y, 1.1 px rim in the owner's colour clipped above the baked
## shadow. Alpha of the rim is 0.9, as teamColorFor(v.owner, 0.9).

var villagers: Array = []
var data = null
var cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var css := Vector2(1440, 900)
var town_colors: Array = ["#4a90d9"]
var lod := 1.0

const Outline = preload("res://scripts/outline.gd")

var _edges: Dictionary = {}
var _order: Array = []

const LOD_SHADER := """
shader_type canvas_item;
uniform float lod = 1.0;
void fragment() {
	COLOR = textureLod(TEXTURE, UV, lod);
}
"""


func _ready() -> void:
	var mat := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = LOD_SHADER
	mat.shader = sh
	mat.set_shader_parameter("lod", lod)
	material = mat


func _draw() -> void:
	if data == null:
		return
	var z := float(cam["zoom"])
	var sc: float = data.scale_at(false, z)
	if sc <= 0.0:
		return
	var list: Array = villagers.duplicate()
	list.sort_custom(func(a, b): return _key(a) < _key(b))
	var center := css * 0.5
	for v in list:
		if bool(v.get("hidden", false)):
			continue
		var spr: Dictionary = data.frame_for(false, str(v.get("anim", "idle")),
			float(v.get("phase", 0.0)), int(v.get("rot", 0)))
		if spr.is_empty():
			continue
		var dw: float = float(spr["w"]) * sc
		var dh: float = float(spr["h"]) * sc
		if dw < 3.0:
			continue
		var px := (float(v["x"]) - float(v["y"]) - float(cam["x"]) + float(cam["y"])) * z * 0.5
		var py := (float(v["x"]) + float(v["y"]) - float(cam["x"]) - float(cam["y"])) * z * 0.25
		var dst := Rect2(center.x + px - dw * float(spr["ax"]),
			center.y + py - dh * float(spr["ay"]), dw, dh)
		var src := Rect2(float(spr["x"]), float(spr["y"]), float(spr["w"]), float(spr["h"]))
		var set: Dictionary = data.set_for(false)
		draw_texture_rect_region(set["tex"], dst, src, Color.WHITE)
		var edge_px := maxi(1, roundi(1.1 / sc))
		var clip := roundi(float(spr["ay"]) * float(spr["h"])) + 1
		var color := _team_color(int(v.get("owner", 0)), 0.9)
		var edge := _edge(set, spr, color, edge_px, clip)
		if edge != null:
			draw_texture_rect(edge, dst, false, Color.WHITE)


func _key(v: Dictionary) -> float:
	return float(v["x"]) + float(v["y"])


func _team_color(owner: int, alpha: float) -> Color:
	var hex := "#4a90d9"
	if owner >= 0 and owner < town_colors.size():
		hex = str(town_colors[owner])
	hex = hex.replace("#", "")
	if hex.length() != 6:
		hex = "4a90d9"
	var c := Color8(
		("0x" + hex.substr(0, 2)).hex_to_int(),
		("0x" + hex.substr(2, 2)).hex_to_int(),
		("0x" + hex.substr(4, 2)).hex_to_int())
	c.a = alpha
	return c


func _edge(set: Dictionary, f: Dictionary, color: Color, px: int, clip: int) -> Texture2D:
	var key := "%d|%d|%d|%d|%d|%d" % [int(f["x"]), int(f["y"]), px, clip, color.to_rgba32(), int(lod * 10.0)]
	if _edges.has(key):
		return _edges[key]
	var tex = Outline.build(set["img"], f, color, color.a, px, clip)
	_edges[key] = tex
	return tex
