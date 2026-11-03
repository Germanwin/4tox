class_name ToxTerrain
extends RefCounted

## Bakes the whole island into one isometric texture, like render.js does.
## Diamond tiles are sampled from the original 256x256 ground textures.

const DEEP := Color(0.086, 0.306, 0.502)
const WATER := Color(0.149, 0.439, 0.651)
const SHALLOW := Color(0.337, 0.690, 0.804)
const SAND := Color(0.910, 0.839, 0.596)

static func build(world: ToxWorld) -> Dictionary:
	var W := world.width
	var H := world.height
	var px := clampi(int(round(sqrt(9000000.0 / float(W * H)))), 16, 40)
	var img_w := int(ceil((W + H) * px * 0.5)) + 2
	var img_h := int(ceil((W + H) * px * 0.25)) + 2
	var image := Image.create_empty(img_w, img_h, false, Image.FORMAT_RGBA8)
	image.fill(DEEP)
	var textures := {
		"grass": _image("res://assets/textures/grass.png"),
		"sand": _image("res://assets/textures/sand.png"),
		"water": _image("res://assets/textures/water.png")
	}
	var tint := {
		ToxWorldGen.T_GRASS: [Color(1.0, 1.0, 1.0), Color(0.985, 1.0, 0.975), Color(1.012, 1.0, 0.99), Color(0.992, 1.0, 1.005)],
		ToxWorldGen.T_SAND: [Color(1.0, 0.99, 0.96), Color(0.992, 0.982, 0.95), Color(1.008, 0.998, 0.968), Color(0.996, 0.986, 0.954)],
		ToxWorldGen.T_SHALLOW: [Color(0.78, 0.98, 1.0), Color(0.74, 0.95, 0.99), Color(0.82, 1.0, 1.0), Color(0.7, 0.93, 0.98)],
		ToxWorldGen.T_WATER: [Color(0.58, 0.82, 1.0), Color(0.54, 0.79, 0.98), Color(0.62, 0.85, 1.0), Color(0.5, 0.76, 0.96)],
		ToxWorldGen.T_DEEP: [Color(0.34, 0.55, 0.82), Color(0.31, 0.52, 0.8), Color(0.37, 0.58, 0.84), Color(0.3, 0.5, 0.78)]
	}
	var templates := {}
	for type in [ToxWorldGen.T_GRASS, ToxWorldGen.T_SAND, ToxWorldGen.T_SHALLOW, ToxWorldGen.T_WATER, ToxWorldGen.T_DEEP]:
		var src: Image = textures["grass"] if type == ToxWorldGen.T_GRASS else (textures["sand"] if type == ToxWorldGen.T_SAND else textures["water"])
		var list := []
		for variant in range(4):
			list.append(_diamond(src, px, tint[type][variant], variant * 37))
		templates[type] = list
	for y in range(H):
		for x in range(W):
			var i := y * W + x
			var t := world.tile[i]
			var variants: Array = templates.get(t, templates[ToxWorldGen.T_GRASS])
			var h := ToxNoise.hash2i(x, y, 991)
			var tv: Dictionary = variants[mini(3, int(floor(h * 4.0)))]
			var diamond: Image = tv.img
			var center_x := (x - y + H) * px * 0.5
			var center_y := (x + y + 1) * px * 0.25
			var left := roundi(center_x - diamond.get_width() * 0.5)
			var top := roundi(center_y - diamond.get_height() * 0.5)
			if left + diamond.get_width() < 0 or top + diamond.get_height() < 0:
				continue
			if left >= img_w or top >= img_h:
				continue
			image.blend_rect(diamond, Rect2i(0, 0, diamond.get_width(), diamond.get_height()), Vector2i(left, top))
	image.generate_mipmaps()
	var tex := ImageTexture.create_from_image(image)
	return {"texture": tex, "px": px, "image_w": img_w, "image_h": img_h}

static func _image(path: String) -> Image:
	var t := load(path) as Texture2D
	if t == null:
		return Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
	var img := t.get_image()
	if img == null:
		return Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
	return img

static func _diamond(src: Image, px: int, tint: Color, salt: int) -> Dictionary:
	var tw := px + 2
	var th := int(round(px * 0.5)) + 2
	var img := Image.create_empty(tw, th, false, Image.FORMAT_RGBA8)
	var sw := src.get_width()
	var sh := src.get_height()
	var cx := (tw - 1) * 0.5
	var cy := (th - 1) * 0.5
	var rx := maxf(1.0, tw * 0.5)
	var ry := maxf(1.0, th * 0.5)
	for y in range(th):
		for x in range(tw):
			var nx := absf((x + 0.5) - cx) / rx
			var ny := absf((y + 0.5) - cy) / ry
			if nx + ny > 1.04:
				continue
			var u := (x + salt * 17) % sw
			var v := (y + salt * 29) % sh
			var c := src.get_pixel(u, v)
			img.set_pixel(x, y, Color(
				clampf(c.r * tint.r, 0.0, 1.0),
				clampf(c.g * tint.g, 0.0, 1.0),
				clampf(c.b * tint.b, 0.0, 1.0),
				1.0
			))
	return {"img": img, "w": tw, "h": th}
