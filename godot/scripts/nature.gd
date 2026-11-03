class_name ToxNature
extends RefCounted

## Nature sprites: the same atlas, frame choice and anchor as mapgen2/js/sprites.js.
## Frame choice is a hash of the object position, so a wrong hash turns every
## tree to a different rotation — the diff catches it immediately.

const ROTS := [0, 90, 180, 270]
const TREES := {"oak": "tree_oak", "pine": "tree_pine", "birch": "tree_birch", "autumn": "tree_autumn"}
const STONES := {"pebble": "rock_pebble", "boulder": "rock_boulder", "rock": "rock_cluster", "iron": "ore_iron", "salt": "salt_crystals"}
const FLOWERS := {"f1": "flower_white", "f2": "flower_yellow", "f3": "flower_pink"}

var atlas: Texture2D
var ppu := 96.0
var mul := 1.35
var _meta: Dictionary = {}
var _cache: Dictionary = {}


func load_atlas(path := "res://assets/sprites/atlas.json") -> bool:
	var text := FileAccess.get_file_as_string(path)
	var m: Variant = JSON.parse_string(text)
	if m == null or not (m is Dictionary):
		return false
	_meta = m
	ppu = float(_meta.get("ppu", 96))
	var tex := load("res://assets/sprites/atlas.png") as Texture2D
	if tex == null:
		return false
	# Мипмапы нужны там, где спрайт уменьшается сильнее чем вдвое (z24):
	# Chrome при drawImage тоже усредняет, и без мипмапов кромки кроны
	# расходятся. На увеличении мипмап не берётся, кадр не меняется.
	var img := tex.get_image()
	if img != null:
		img.generate_mipmaps()
		atlas = ImageTexture.create_from_image(img)
	else:
		atlas = tex
	return atlas != null


func _frame(base: String, rot: int) -> Dictionary:
	var key := "%s_%d" % [base, rot]
	if _cache.has(key):
		return _cache[key]
	var all: Dictionary = _meta.get("frames", {})
	var f: Variant = all.get(key)
	if f == null:
		return {}
	var w := float(f["w"])
	var h := float(f["h"])
	var spr := {
		"x": float(f["x"]), "y": float(f["y"]), "w": w, "h": h,
		"ax": float(f["anchorX"]) / w, "ay": float(f["anchorY"]) / h
	}
	_cache[key] = spr
	return spr


func _variant(o: Dictionary) -> String:
	var v: Variant = o.get("variant")
	return "" if v == null else str(v)


func candidates(o: Dictionary) -> Array:
	var bases: Array = []
	var kind := str(o.get("kind", ""))
	var v := _variant(o)
	match kind:
		"tree":
			bases = [TREES.get(v, "tree_oak")]
		"stone":
			bases = [STONES.get(v, "rock_boulder")]
		"bush":
			bases = ["bush", "bush_berry"]
		"reed":
			bases = ["reeds"]
		"tuft":
			bases = ["grass_tuft"]
		"flower":
			bases = [FLOWERS.get(v, "flower_white")]
		_:
			bases = []
	var out: Array = []
	for b in bases:
		for r in ROTS:
			var f := _frame(str(b), r)
			if not f.is_empty():
				out.append(f)
	return out


func pick(o: Dictionary) -> Dictionary:
	var arr := candidates(o)
	if arr.is_empty():
		return {}
	if arr.size() == 1:
		return arr[0]
	var salt := 7717 if str(o.get("kind", "")) == "stone" else 4242
	var v := _variant(o)
	if v != "":
		salt += v.length() * 31
	var h := hash2i(roundi(float(o["x"]) * 977.0), roundi(float(o["y"]) * 1021.0), salt)
	return arr[mini(arr.size() - 1, int(floor(h * float(arr.size()))))]


## Math.imul-based hash2i from mapgen2/js/noise.js, 32-bit exact.
static func hash2i(x: int, y: int, seed: int) -> float:
	var h := imul(x, 0x27d4eb2d)
	h = h ^ imul(y, 0x165667b1)
	h = h ^ imul(seed, 0x9e3779b1)
	h = imul(h ^ (h >> 15), 0x85ebca6b)
	h = imul(h ^ (h >> 13), 0xc2b2ae35)
	h = h ^ (h >> 16)
	return float(h & 0xFFFFFFFF) / 4294967296.0


static func imul(a: int, b: int) -> int:
	return (a * b) & 0xFFFFFFFF
