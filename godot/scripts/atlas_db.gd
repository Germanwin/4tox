class_name ToxAtlasDB
extends RefCounted

## Loads the original 4tox atlas PNGs and their JSON metadata.
## Nothing is repainted: frames are the exact rectangles the browser game uses.

static var _loaded := false
static var buildings: Dictionary = {}
static var ruins: Dictionary = {}
static var sprites: Dictionary = {}
static var waves: Dictionary = {}
static var characters: Dictionary = {}
static var _silhouettes: Dictionary = {}

const TEAM_COLORS := [Color("#4a90d9"), Color("#d94a4a"), Color("#9b59b6"), Color("#e0a030")]
const BUILDING_DIRS := {
	"townhall": "townhall", "house": "starter_house", "lumbercamp": "lumbercamp",
	"barracks": "barracks", "warcamp": "warcamp"
}
const BUILDING_NAMES := {
	"townhall": "Ратуша", "house": "Дом жителя", "lumbercamp": "Лагерь лесоруба",
	"barracks": "Казарма", "warcamp": "Военный лагерь"
}

static func ensure_loaded() -> void:
	if _loaded:
		return
	_loaded = true
	for type in BUILDING_DIRS.keys():
		buildings[type] = _load_building(BUILDING_DIRS[type], type)
	ruins = _load_ruins()
	sprites = _load_sprites()
	waves = _load_waves()
	characters["villager"] = _load_character("villager", "villager")
	characters["warrior"] = _load_character("armored_villager", "armored_villager")

static func _json(path: String) -> Dictionary:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		push_error("Atlas JSON is missing: " + path)
		return {}
	var parsed = JSON.parse_string(text)
	return parsed if parsed is Dictionary else {}

static func _texture(path: String) -> Texture2D:
	var tex := load(path) as Texture2D
	if tex == null:
		push_error("Atlas texture is missing: " + path)
	return tex

static func _frame(tex: Texture2D, f: Dictionary) -> Dictionary:
	var w := int(f.get("w", 1))
	var h := int(f.get("h", 1))
	var ax := float(f.get("anchorX", w * 0.5))
	var ay := float(f.get("anchorY", h * 0.5))
	return {
		"tex": tex,
		"region": Rect2(float(f.get("x", 0)), float(f.get("y", 0)), w, h),
		"size": Vector2(w, h),
		"anchor": Vector2(ax, ay),
		"ax": ax / float(w),
		"ay": ay / float(h),
		"footprint": f.get("footprint", null),
		"ground": f.get("ground", null),
		"rot": int(f.get("rotation", 0))
	}

static func _load_building(folder: String, type: String) -> Dictionary:
	var base := "res://assets/%s/" % folder
	var meta := _json(base + "atlas.json")
	var tex := _texture(base + str(meta.get("atlas", "atlas.png")))
	var frames := {}
	var by_variant := {}
	var meta_frames: Dictionary = meta.get("frames", {})
	for key in meta_frames.keys():
		var f: Dictionary = meta_frames[key]
		var fr := _frame(tex, f)
		frames[key] = fr
		var variant := str(f.get("variant", "a"))
		var rot := int(f.get("rotation", 0))
		if not by_variant.has(variant):
			by_variant[variant] = {}
		by_variant[variant][rot] = fr
	var variants: Dictionary = meta.get("variants", {})
	return {
		"type": type, "name": BUILDING_NAMES.get(type, type),
		"meta": meta, "tex": tex, "frames": frames, "by_variant": by_variant,
		"variants": variants, "ppu": float(meta.get("ppu", 96.0)),
		"mul": float(meta.get("mul", 1.0)),
		"az": deg_to_rad(float(meta.get("az_deg", 45.0))),
		"el": deg_to_rad(float(meta.get("el_deg", 35.264389682754654)))
	}

static func _load_ruins() -> Dictionary:
	var base := "res://assets/ruins/"
	var meta := _json(base + "atlas.json")
	var tex := _texture(base + str(meta.get("atlas", "atlas.png")))
	var out := {}
	var types_meta: Dictionary = meta.get("types", {})
	for key in meta.get("frames", {}).keys():
		var f: Dictionary = meta["frames"][key]
		var fr := _frame(tex, f)
		var key_text: String = str(key)
		var type_name: String = key_text.rsplit("_", true, 1)[0]
		var rot := int(key_text.rsplit("_", true, 1)[1])
		if not out.has(type_name):
			out[type_name] = {"frames": {}, "ppu": 96.0, "mul": 0.7667, "az": deg_to_rad(45.0), "el": deg_to_rad(35.264389682754654)}
		if types_meta.has(type_name):
			out[type_name]["ppu"] = float(types_meta[type_name].get("ppu", out[type_name]["ppu"]))
			out[type_name]["mul"] = float(types_meta[type_name].get("mul", out[type_name]["mul"]))
		out[type_name]["frames"][rot] = fr
	return out

static func _load_sprites() -> Dictionary:
	var base := "res://assets/"
	var meta := _json(base + "sprites/atlas.json")
	var tex := _texture(base + str(meta.get("atlas", "sprites/atlas.png")))
	var sets := {}
	var all := {}
	for key in meta.get("frames", {}).keys():
		all[key] = _frame(tex, meta["frames"][key])
	var tree_names := {"oak": "tree_oak", "pine": "tree_pine", "birch": "tree_birch", "autumn": "tree_autumn"}
	for k in tree_names.keys():
		sets["tree_" + k] = _four(all, tree_names[k])
	var stone_names := {"pebble": "rock_pebble", "boulder": "rock_boulder", "rock": "rock_cluster", "iron": "ore_iron", "salt": "salt_crystals"}
	for k in stone_names.keys():
		sets["stone_" + k] = _four(all, stone_names[k])
	sets["bush"] = _four(all, "bush") + _four(all, "bush_berry")
	sets["reed"] = _four(all, "reeds")
	sets["tuft"] = _four(all, "grass_tuft")
	sets["flower_f1"] = _four(all, "flower_white")
	sets["flower_f2"] = _four(all, "flower_yellow")
	sets["flower_f3"] = _four(all, "flower_pink")
	return {
		"tex": tex, "meta": meta, "sets": sets, "ppu": float(meta.get("ppu", 96.0)),
		"mul": 1.35, "az": deg_to_rad(45.0), "el": deg_to_rad(35.264389682754654)
	}

static func _four(all: Dictionary, base_name: String) -> Array:
	var out := []
	for i in range(4):
		var key := "%s_%d" % [base_name, i * 90]
		if all.has(key):
			out.append(all[key])
	return out

static func _load_waves() -> Dictionary:
	var base := "res://assets/waves/"
	var meta := _json(base + "atlas.json")
	var tex := _texture(base + str(meta.get("atlas", "atlas.png")))
	var all := {}
	for key in meta.get("frames", {}).keys():
		all[key] = _frame(tex, meta["frames"][key])
	return {"tex": tex, "meta": meta, "frames": all, "ppu": float(meta.get("ppu", 120.0)), "mul": 1.0,
		"az": deg_to_rad(45.0), "el": deg_to_rad(35.264389682754654)}

static func _load_character(folder: String, prefix: String) -> Dictionary:
	var base := "res://assets/%s/" % folder
	var meta := _json(base + "atlas.json")
	var tex := _texture(base + str(meta.get("atlas", "atlas.png")))
	var by_anim := {}
	for key in meta.get("frames", {}).keys():
		var parts: PackedStringArray = str(key).split("_")
		var prefix_parts: int = prefix.split("_").size()
		if parts.size() < prefix_parts + 3:
			continue
		var rot_index := int(parts[parts.size() - 1])
		var frame_index := int(parts[parts.size() - 2])
		var anim := "_".join(parts.slice(prefix_parts, parts.size() - 2))
		if not by_anim.has(anim):
			by_anim[anim] = {}
		if not by_anim[anim].has(frame_index):
			by_anim[anim][frame_index] = {}
		by_anim[anim][frame_index][rot_index * 45] = _frame(tex, meta["frames"][key])
	return {
		"meta": meta, "tex": tex, "by_anim": by_anim,
		"anims": meta.get("anims", {}),
		"ppu": float(meta.get("ppu", 96.0)),
		"mul": float(meta.get("mul", 1.35)),
		"cell": meta.get("cell", [112, 132])
	}

static func building_frame(type: String, variant: String, rot: int) -> Dictionary:
	ensure_loaded()
	var set: Dictionary = buildings.get(type, buildings.get("townhall", {}))
	if set.is_empty():
		return {}
	var by: Dictionary = set.get("by_variant", {})
	var variant_map: Dictionary = by.get(variant, by.get("a", {}))
	if variant_map.is_empty() and not by.is_empty():
		variant_map = by.values()[0]
	var r := posmod(rot, 360)
	return variant_map.get(r, variant_map.get(0, {}))

static func ruin_frame(type: String, rot: int) -> Dictionary:
	ensure_loaded()
	var set: Dictionary = ruins.get(type, {})
	if set.is_empty():
		return {}
	return set["frames"].get(posmod(rot, 360), set["frames"].get(0, {}))

static func sprite_frame(obj: Dictionary) -> Dictionary:
	ensure_loaded()
	var key := ""
	match str(obj.get("kind", "")):
		"tree":
			key = "tree_" + str(obj.get("variant", "oak"))
		"stone":
			key = "stone_" + str(obj.get("variant", "boulder"))
		"bush":
			key = "bush"
		"reed":
			key = "reed"
		"tuft":
			key = "tuft"
		"flower":
			key = "flower_" + str(obj.get("variant", "f1"))
	var arr: Array = sprites.get("sets", {}).get(key, [])
	if arr.is_empty():
		return {}
	if arr.size() == 1:
		return arr[0]
	var salt := 7717 if obj.get("kind", "") == "stone" else 4242
	if obj.get("variant", null) != null:
		salt += str(obj.variant).length() * 31
	var h := ToxNoise.hash2i(roundi(float(obj.x) * 977.0), roundi(float(obj.y) * 1021.0), salt)
	return arr[mini(arr.size() - 1, int(floor(h * arr.size())))]

static func character_frame(warrior: bool, anim: String, frame_index: int, rot: float) -> Dictionary:
	ensure_loaded()
	var ch: Dictionary = characters.get("warrior" if warrior else "villager", {})
	var by_anim: Dictionary = ch.get("by_anim", {})
	var anim_map: Dictionary = by_anim.get(anim, by_anim.get("idle", {}))
	if anim_map.is_empty():
		return {}
	var idx := frame_index
	if not anim_map.has(idx):
		idx = anim_map.keys()[0]
	var by_rot: Dictionary = anim_map[idx]
	var r := int(round(posmod(rot, 360.0) / 45.0)) % 8 * 45
	return by_rot.get(r, by_rot.get(0, {}))

static func character_fps(warrior: bool, anim: String) -> float:
	ensure_loaded()
	var ch: Dictionary = characters.get("warrior" if warrior else "villager", {})
	return float(ch.get("anims", {}).get(anim, {}).get("fps", 10.0))

static func character_frames(warrior: bool, anim: String) -> int:
	ensure_loaded()
	var ch: Dictionary = characters.get("warrior" if warrior else "villager", {})
	return int(ch.get("anims", {}).get(anim, {}).get("frames", 6))

static func silhouette(frame: Dictionary) -> Texture2D:
	ensure_loaded()
	var key := "%s:%s" % [str(frame.get("tex", null)), str(frame.get("region", Rect2()))]
	if _silhouettes.has(key):
		return _silhouettes[key]
	var tex: Texture2D = frame.get("tex", null)
	var region: Rect2 = frame.get("region", Rect2())
	var src: Image = null
	if tex != null:
		src = tex.get_image()
	if src == null:
		var blank := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
		blank.fill(Color(1, 1, 1, 1))
		var bt := ImageTexture.create_from_image(blank)
		_silhouettes[key] = bt
		return bt
	var w := int(region.size.x)
	var h := int(region.size.y)
	var img := Image.create_empty(w, h, false, Image.FORMAT_RGBA8)
	for y in range(h):
		for x in range(w):
			var c := src.get_pixel(int(region.position.x) + x, int(region.position.y) + y)
			if c.a > 0.08:
				img.set_pixel(x, y, Color(1, 1, 1, c.a))
	var out := ImageTexture.create_from_image(img)
	_silhouettes[key] = out
	return out

static func building_scale(set: Dictionary) -> Vector2:
	# World units: one map cell is 64 px. A building sprite unit is one cell.
	var ca := cos(float(set.get("az", deg_to_rad(45.0))))
	var k := float(set.get("mul", 1.0))
	var ppu := float(set.get("ppu", 96.0))
	return Vector2(k * 64.0 / (2.0 * ca * ppu), k * 64.0 / (4.0 * sin(float(set.get("el", deg_to_rad(35.264))) ) * ca * ppu))

static func villager_scale(ch: Dictionary) -> float:
	# Original: scale = z / ppu * mul / SHRINK, with SHRINK = 2.2.
	return 64.0 / float(ch.get("ppu", 96.0)) * float(ch.get("mul", 1.35)) / 2.2

static func sprite_scale() -> float:
	ensure_loaded()
	return 64.0 / float(sprites.get("ppu", 96.0)) * float(sprites.get("mul", 1.35))
