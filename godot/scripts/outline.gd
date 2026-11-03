class_name ToxOutline
extends RefCounted

## Coloured rim over the atlas' black contour, same construction as
## Renderer.spriteEdge: tint the silhouette, erase a slightly scaled copy,
## keep the border. Alpha and a bottom clip (villagers' baked shadow) are
## parameters, so one builder serves buildings and people.

static func build(atlas_img: Image, f: Dictionary, color: Color, alpha: float,
		px: int, clip: int) -> Texture2D:
	var img := build_image(atlas_img, f, color, alpha, px, clip)
	if img == null:
		return null
	return ImageTexture.create_from_image(img)


## Same rim as an Image, so villager rims can be packed into one atlas and
## drawn as part of the batched villager mesh.
static func build_image(atlas_img: Image, f: Dictionary, color: Color, alpha: float,
		px: int, clip: int) -> Image:
	var fw := int(f["w"])
	var fh := int(f["h"])
	if fw <= 0 or fh <= 0:
		return null
	var src := atlas_img.get_region(Rect2i(int(f["x"]), int(f["y"]), fw, fh)).get_data()
	var out := PackedByteArray()
	out.resize(fw * fh * 4)
	var k := maxf(0.5, 1.0 - 2.0 * float(px) / float(mini(fw, fh)))
	var cx := float(fw) * 0.5
	var cy := float(fh) * 0.5
	var cr := int(color.r * 255.0)
	var cg := int(color.g * 255.0)
	var cb := int(color.b * 255.0)
	var stop := fh if clip <= 0 else mini(fh, clip)
	for y in range(stop):
		for x in range(fw):
			var i := (y * fw + x) * 4
			var a := float(src[i + 3]) / 255.0
			if a <= 0.004:
				continue
			var sx := (float(x) + 0.5 - cx) / k + cx - 0.5
			var sy := (float(y) + 0.5 - cy) / k + cy - 0.5
			var a2 := _alpha_bilinear(src, fw, fh, sx, sy)
			var ea := a * (1.0 - a2) * alpha
			if ea <= 0.004:
				continue
			out[i] = cr
			out[i + 1] = cg
			out[i + 2] = cb
			out[i + 3] = int(clampf(ea, 0.0, 1.0) * 255.0)
	return Image.create_from_data(fw, fh, false, Image.FORMAT_RGBA8, out)


static func _alpha_bilinear(data: PackedByteArray, w: int, h: int, x: float, y: float) -> float:
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


static func _a(data: PackedByteArray, w: int, h: int, x: int, y: int) -> float:
	if x < 0 or y < 0 or x >= w or y >= h:
		return 0.0
	return float(data[(y * w + x) * 4 + 3]) / 255.0
