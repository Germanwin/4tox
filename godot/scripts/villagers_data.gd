class_name ToxVillagersData
extends RefCounted

## Villager/warrior atlases: animation frame by phase, nearest declared
## rotation, and the SHRINK the game applies to people (1/2.2 of world
## sprites). No walking or work rules — only frames.

const DIRS := {"villager": "villager", "warrior": "armored_villager"}
const SHRINK := 2.2

var _sets: Dictionary = {}


func set_for(warrior: bool) -> Dictionary:
	var id := "warrior" if warrior else "villager"
	if _sets.has(id):
		return _sets[id]
	var text := FileAccess.get_file_as_string("res://assets/%s/atlas.json" % DIRS[id])
	var meta: Variant = JSON.parse_string(text)
	if meta == null:
		return {}
	var tex := load("res://assets/%s/atlas.png" % DIRS[id]) as Texture2D
	var img: Image = null
	if tex != null:
		img = tex.get_image()
		if img != null:
			img.convert(Image.FORMAT_RGBA8)
			var mip := img.duplicate() as Image
			mip.generate_mipmaps()
			tex = ImageTexture.create_from_image(mip)
	var s := {
		"id": id, "tex": tex, "meta": meta,
		"ppu": float(meta.get("ppu", 96)),
		"mul": float(meta.get("mul", 1.0)),
		"anims": meta.get("anims", {}),
		"img": img,
		"rots": [],
		"frames": {}
	}
	for name in meta.get("frames", {}):
		var f: Dictionary = meta["frames"][name]
		if not f.has("anim") or not f.has("frame"):
			continue
		var a := str(f["anim"])
		var fr := int(f["frame"])
		var rot := ((int(f["rotation"]) % 360) + 360) % 360
		var by_anim: Array = s["frames"].get(a, [])
		while by_anim.size() <= fr:
			by_anim.append({})
		var by_frame: Dictionary = by_anim[fr]
		if by_frame == null:
			by_frame = {}
		var w := float(f["w"])
		var h := float(f["h"])
		by_frame[rot] = {
			"x": float(f["x"]), "y": float(f["y"]), "w": w, "h": h,
			"ax": float(f["anchorX"]) / w, "ay": float(f["anchorY"]) / h
		}
		by_anim[fr] = by_frame
		s["frames"][a] = by_anim
		if not s["rots"].has(rot):
			s["rots"].append(rot)
	s["rots"].sort()
	_sets[id] = s
	return s


func frame_for(warrior: bool, anim: String, phase: float, rot: int) -> Dictionary:
	var s := set_for(warrior)
	if s.is_empty():
		return {}
	var by_anim: Variant = s["frames"].get(anim)
	if by_anim == null:
		by_anim = s["frames"].get("idle")
	if by_anim == null:
		return {}
	var anims: Dictionary = s["anims"]
	var n := int(anims.get(anim, {}).get("frames", by_anim.size()))
	if n <= 0:
		n = by_anim.size()
	var i := int(floor(phase * float(n))) % n
	var by_frame: Dictionary = by_anim[i] if i < by_anim.size() else by_anim[0]
	var r := nearest_rot(by_frame, rot, s["rots"])
	return by_frame.get(r, by_frame.get(0, {}))


func scale_at(warrior: bool, z: float) -> float:
	var s := set_for(warrior)
	if s.is_empty():
		return 0.0
	return z / float(s["ppu"]) * float(s["mul"]) / SHRINK


static func nearest_rot(by_frame: Dictionary, deg: int, rots: Array) -> int:
	var best := -1
	var bd := INF
	for r in rots:
		if not by_frame.has(r):
			continue
		var d := absf(float(((deg - int(r) + 540) % 360) - 180))
		if d < bd - 1e-9 or (best != -1 and absf(d - bd) <= 1e-9 and int(r) > best):
			bd = d
			best = int(r)
	return 0 if best == -1 else best
