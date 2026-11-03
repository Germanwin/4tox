class_name ToxNatureLayer
extends Node2D

## Draws nature objects in the array order the browser uses, with the same
## sprite scale, anchor and sway. One _draw call keeps the order explicit:
## child nodes would add their own sort keys.

var objects: Array = []
var nature = null
var cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var css := Vector2(1440, 900)

var _drawn := {}
var lod := -1.0

const LOD_SHADER := """
shader_type canvas_item;
uniform float lod = 1.0;
void fragment() {
	COLOR = textureLod(TEXTURE, UV, lod);
}
"""


func _ready() -> void:
	if lod < 0.0:
		return
	var mat := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = LOD_SHADER
	mat.shader = sh
	mat.set_shader_parameter("lod", lod)
	material = mat


func _draw() -> void:
	if nature == null or nature.atlas == null:
		return
	var z := float(cam["zoom"])
	var base: float = z / float(nature.ppu) * float(nature.mul)
	var center := css * 0.5
	for o in objects:
		var key := int(o.get("id", 0))
		var spr: Dictionary = _drawn.get(key, {})
		if spr.is_empty():
			spr = nature.pick(o)
			_drawn[key] = spr
		if spr.is_empty():
			continue
		var sc: float = base * float(o.get("scale", 1.0))
		var dw: float = float(spr["w"]) * sc
		var dh: float = float(spr["h"]) * sc
		if dw < 2.5:
			continue
		var ox := float(o["x"])
		var oy := float(o["y"])
		var px := (ox - oy - float(cam["x"]) + float(cam["y"])) * z * 0.5
		var py := (ox + oy - float(cam["x"]) - float(cam["y"])) * z * 0.25
		if z >= 26.0 and str(o.get("kind", "")) == "tree":
			px += sin(float(o.get("phase", 0.0))) * z * 0.018
		var dst := Rect2(
			center.x + px - dw * float(spr["ax"]),
			center.y + py - dh * float(spr["ay"]),
			dw, dh)
		var src := Rect2(float(spr["x"]), float(spr["y"]), float(spr["w"]), float(spr["h"]))
		draw_texture_rect_region(nature.atlas, dst, src, Color.WHITE)
