class_name ToxBuildingLayer
extends Node2D

## Buildings in browser depth order (centre of the footprint, x+y), with the
## same unequal x/y scale from ppu and the 45°/35.264° projection, and the
## ground-contour shift that puts the base, not the model, in the middle of
## the footprint.

var buildings: Array = []
var data = null
var cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var css := Vector2(1440, 900)
var town_colors: Array = ["#4a90d9"]
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
var _edges: Dictionary = {}


func _draw() -> void:
	if data == null:
		return
	var z := float(cam["zoom"])
	var list: Array = buildings.duplicate()
	list.sort_custom(func(a, b): return _depth(a) < _depth(b))
	var center := css * 0.5
	for b in list:
		var type := str(b.get("type", "townhall"))
		var s: Dictionary = data.set_for(type)
		if s.is_empty():
			continue
		var f: Dictionary = data.frame_for(type, str(b.get("variant", "a")), int(b.get("rot", 0)))
		if f.is_empty():
			continue
		var ca := cos(float(s["az"]))
		var scx := float(s["mul"]) * z / (2.0 * ca * float(s["ppu"]))
		var scy := float(s["mul"]) * z / (4.0 * sin(float(s["el"])) * ca * float(s["ppu"]))
		var fp: Array = f["fp"]
		var cx := float(b["x"]) + float(fp[0]) * 0.5
		var cy := float(b["y"]) + float(fp[1]) * 0.5
		var shx := 0.0
		var shy := 0.0
		var g: Variant = f["ground"]
		if g != null and (g as Array).size() == 4:
			shx = (float(g[0]) + float(g[1])) * 0.5 * float(s["mul"])
			shy = (float(g[2]) + float(g[3])) * 0.5 * float(s["mul"])
		var wx := cx - shx
		var wy := cy - shy
		var px := (wx - wy - float(cam["x"]) + float(cam["y"])) * z * 0.5
		var py := (wx + wy - float(cam["x"]) - float(cam["y"])) * z * 0.25
		var dw := float(f["w"]) * scx
		var dh := float(f["h"]) * scy
		var dst := Rect2(
			center.x + px - dw * float(f["ax"]),
			center.y + py - dh * float(f["ay"]),
			dw, dh)
		var src := Rect2(float(f["x"]), float(f["y"]), float(f["w"]), float(f["h"]))
		draw_texture_rect_region(s["tex"], dst, src, Color.WHITE)
		# Цветная кайма поверх чёрного контура: та же, что drawSpriteOutline
		# в браузере — силуэт минус его уменьшенная копия.
		var edge_px := maxi(1, roundi(1.4 / scx))
		var color := _team_color(int(b.get("owner", 0)))
		var edge := _edge(s, f, color, edge_px)
		if edge != null:
			draw_texture_rect(edge, dst, false, Color.WHITE)


func _depth(b: Dictionary) -> float:
	var type := str(b.get("type", "townhall"))
	var s: Dictionary = data.set_for(type)
	if s.is_empty():
		return float(b["x"]) + float(b["y"])
	var f: Dictionary = data.frame_for(type, str(b.get("variant", "a")), int(b.get("rot", 0)))
	if f.is_empty():
		return float(b["x"]) + float(b["y"])
	var fp: Array = f["fp"]
	return float(b["x"]) + float(fp[0]) * 0.5 + float(b["y"]) + float(fp[1]) * 0.5


func _team_color(owner: int) -> Color:
	var hex := "#4a90d9"
	if owner >= 0 and owner < town_colors.size():
		hex = str(town_colors[owner])
	hex = hex.replace("#", "")
	if hex.length() != 6:
		hex = "4a90d9"
	return Color8(
		("0x" + hex.substr(0, 2)).hex_to_int(),
		("0x" + hex.substr(2, 2)).hex_to_int(),
		("0x" + hex.substr(4, 2)).hex_to_int())


func _edge(s: Dictionary, f: Dictionary, color: Color, px: int) -> Texture2D:
	var fw := int(f["w"])
	var fh := int(f["h"])
	var key := "%s|%s|%d|%d|%d" % [str(f["x"]), str(f["y"]), fw, color.to_rgba32(), px]
	if _edges.has(key):
		return _edges[key]
	var atlas_img := (s["tex"] as Texture2D).get_image()
	if atlas_img == null:
		return null
	atlas_img.convert(Image.FORMAT_RGBA8)
	var src_img := atlas_img.get_region(Rect2i(int(f["x"]), int(f["y"]), fw, fh))
	var src := src_img.get_data()
	var out := PackedByteArray()
	out.resize(fw * fh * 4)
	var k := maxf(0.5, 1.0 - 2.0 * float(px) / float(mini(fw, fh)))
	var cx := float(fw) * 0.5
	var cy := float(fh) * 0.5
	var cr := int(color.r * 255.0)
	var cg := int(color.g * 255.0)
	var cb := int(color.b * 255.0)
	for y in range(fh):
		for x in range(fw):
			var i := (y * fw + x) * 4
			var a := float(src[i + 3]) / 255.0
			if a <= 0.004:
				continue
			var sx := (float(x) + 0.5 - cx) / k + cx - 0.5
			var sy := (float(y) + 0.5 - cy) / k + cy - 0.5
			var a2 := _alpha_bilinear(src, fw, fh, sx, sy)
			var ea := a * (1.0 - a2)
			if ea <= 0.004:
				continue
			out[i] = cr
			out[i + 1] = cg
			out[i + 2] = cb
			out[i + 3] = int(clampf(ea, 0.0, 1.0) * 255.0)
	var img := Image.create_from_data(fw, fh, false, Image.FORMAT_RGBA8, out)
	var tex := ImageTexture.create_from_image(img)
	_edges[key] = tex
	return tex


func _alpha_bilinear(data: PackedByteArray, w: int, h: int, x: float, y: float) -> float:
	if x < -0.5 or y < -0.5 or x > float(w) - 0.5 or y > float(h) - 0.5:
		return 0.0
	var x0 := int(floor(x))
	var y0 := int(floor(y))
	var tx := x - float(x0)
	var ty := y - float(y0)
	var a00 := _a(data, w, h, x0, y0)
	var a10 := _a(data, w, h, x0 + 1, y0)
	var a01 := _a(data, w, h, x0, y0 + 1)
	var a11 := _a(data, w, h, x0 + 1, y0 + 1)
	var top := a00 + (a10 - a00) * tx
	var bot := a01 + (a11 - a01) * tx
	return top + (bot - top) * ty


func _a(data: PackedByteArray, w: int, h: int, x: int, y: int) -> float:
	if x < 0 or y < 0 or x >= w or y >= h:
		return 0.0
	return float(data[(y * w + x) * 4 + 3]) / 255.0
