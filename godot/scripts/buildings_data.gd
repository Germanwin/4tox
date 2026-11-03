class_name ToxBuildingsData
extends RefCounted

## Building atlases: per-type ppu/mul/az/el and frames with anchor, footprint
## and ground contour. Same numbers as mapgen2/assets/<type>/atlas.json; no
## placement or cost rules live here.

const DIRS := {
	"townhall": "townhall", "house": "starter_house", "lumbercamp": "lumbercamp",
	"barracks": "barracks", "warcamp": "warcamp",
	# Руины — отдельный атлас: кадр выбирается по ТИПУ снесённой постройки,
	# а ppu/mul у кадров разные (ратуша 80, остальные 96).
	"ruins": "ruins"
}

var _sets: Dictionary = {}


func set_for(type: String) -> Dictionary:
	if _sets.has(type):
		return _sets[type]
	var dir := str(DIRS.get(type, "townhall"))
	var text := FileAccess.get_file_as_string("res://assets/%s/atlas.json" % dir)
	var meta: Variant = JSON.parse_string(text)
	if meta == null:
		return {}
	var tex := load("res://assets/%s/atlas.png" % dir) as Texture2D
	var base_img: Image = null
	if tex != null:
		base_img = tex.get_image()
		if base_img != null:
			base_img.convert(Image.FORMAT_RGBA8)
			var mip := base_img.duplicate() as Image
			mip.generate_mipmaps()
			tex = ImageTexture.create_from_image(mip)
	var s := {
		"type": type, "tex": tex, "img": base_img, "meta": meta,
		"ppu": float(meta.get("ppu", 80)),
		"mul": float(meta.get("mul", 1.0)),
		"az": deg_to_rad(float(meta.get("az_deg", 45.0))),
		"el": deg_to_rad(float(meta.get("el_deg", 35.264389682754654))),
		"frames": {}
	}
	for name in meta.get("frames", {}):
		var f: Dictionary = meta["frames"][name]
		if not f.has("variant"):
			continue
		var v := str(f["variant"])
		var r := int(f["rotation"])
		if not s["frames"].has(v):
			s["frames"][v] = {}
		var w := float(f["w"])
		var h := float(f["h"])
		s["frames"][v][r] = {
			"x": float(f["x"]), "y": float(f["y"]), "w": w, "h": h,
			"ax": float(f["anchorX"]) / w, "ay": float(f["anchorY"]) / h,
			"fp": f.get("footprint", [1, 1]),
			"ground": f.get("ground"),
			"ppu": float(f.get("ppu", meta.get("ppu", 80))),
			"mul": float(f.get("mul", meta.get("mul", 1.0)))
		}
	_sets[type] = s
	return s


func frame_for(type: String, variant: String, rot: int) -> Dictionary:
	var s := set_for(type)
	if s.is_empty():
		return {}
	var frames: Dictionary = s["frames"]
	var v: Variant = frames.get(variant)
	if v == null:
		v = frames.get("a")
	if v == null:
		return {}
	var r := ((rot % 360) + 360) % 360
	return v.get(r, v.get(0, {}))
