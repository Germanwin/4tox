class_name ToxBuildings
extends RefCounted

## Building rules, ported from mapgen2/js/buildings.js.

const FACE_ROT := 90
const YARD := 1
const WARCAMP_CAP := 20
const BARRACKS_YARD_CAP := 10
const TRAIN_TIME := 5.0
const NAMES := {
	"townhall": "Ратуша", "house": "Дом жителя", "lumbercamp": "Лагерь лесоруба",
	"barracks": "Казарма", "warcamp": "Военный лагерь"
}
const FALLBACK_FP := {
	"townhall": {0: [4, 3], 90: [3, 4], 180: [4, 3], 270: [3, 4]},
	"house": {0: [2, 3], 90: [3, 2], 180: [2, 3], 270: [3, 2]},
	"lumbercamp": {0: [3, 3], 90: [3, 3], 180: [3, 3], 270: [3, 3]},
	"barracks": {0: [4, 3], 90: [3, 4], 180: [4, 3], 270: [3, 4]},
	"warcamp": {0: [5, 5], 90: [5, 5], 180: [5, 5], 270: [5, 5]}
}
const HP := {
	"villager": 15, "warrior": 25, "townhall": 120, "house": 50,
	"lumbercamp": 35, "barracks": 80, "warcamp": 40
}
const WORK := {"lumbercamp": 3}
const TRAIN := {"barracks": 3}
const HOUSING := {"house": 4}

static var _next_id := 1

static func norm_rot(rot: int) -> int:
	return posmod(int(round(float(rot) / 90.0)) * 90, 360)

static func make(type: String, variant: String, rot: int, x: int, y: int, owner: int = 0) -> Dictionary:
	var r := norm_rot(rot)
	var b := {
		"kind": "building", "type": type, "variant": variant, "rot": r,
		"x": x, "y": y, "owner": owner, "level": 1,
		"id": "b%d" % _next_id, "rubble": false, "flinch": 0.0,
		"hp": HP.get(type, 50), "max_hp": HP.get(type, 50),
		"workers": [], "trainees": [], "garrison": []
	}
	_next_id += 1
	return b

static func type_of(b: Dictionary) -> String:
	return str(b.get("type", "townhall"))

static func name_of(b: Dictionary) -> String:
	return NAMES.get(type_of(b), "Постройка")

static func footprint(rot: int, type: String = "townhall") -> Vector2i:
	var r := norm_rot(rot)
	var fp: Array = FALLBACK_FP.get(type, FALLBACK_FP["townhall"]).get(r, [4, 3])
	return Vector2i(int(fp[0]), int(fp[1]))

static func cells(b: Dictionary) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	for j in range(fp.y):
		for i in range(fp.x):
			out.append(Vector2i(int(b.x) + i, int(b.y) + j))
	return out

static func bounds(b: Dictionary) -> Rect2i:
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	return Rect2i(int(b.x), int(b.y), fp.x, fp.y)

static func center(b: Dictionary) -> Vector2:
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	return Vector2(float(b.x) + fp.x * 0.5, float(b.y) + fp.y * 0.5)

static func depth(b: Dictionary) -> float:
	var c := center(b)
	return c.x + c.y

static func covers_cell(b: Dictionary, x: int, y: int) -> bool:
	var r := bounds(b)
	return x >= r.position.x and y >= r.position.y and x < r.position.x + r.size.x and y < r.position.y + r.size.y

static func model_cells(b: Dictionary) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	if type_of(b) != "warcamp" or b.get("rubble", false):
		return out
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	var x0 := int(b.x) + int((fp.x - 2) / 2)
	var y0 := int(b.y) + int((fp.y - 2) / 2)
	for j in range(2):
		for i in range(2):
			out.append(Vector2i(x0 + i, y0 + j))
	return out

static func patrol_cells(b: Dictionary) -> Array[Vector2i]:
	var blocked := {}
	for c in model_cells(b):
		blocked[c] = true
	var out: Array[Vector2i] = []
	for c in cells(b):
		if not blocked.has(c):
			out.append(c)
	return out

static func garrison_cells(b: Dictionary) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	if type_of(b) != "barracks":
		return out
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	for j in range(fp.y):
		for i in range(fp.x):
			out.append(Vector2i(int(b.x) + i, int(b.y) + j))
	return out

static func work_slots(b: Dictionary) -> int:
	if b.get("rubble", false):
		return 0
	return int(WORK.get(type_of(b), 0))

static func training_slots(b: Dictionary) -> int:
	if b.get("rubble", false):
		return 0
	return int(TRAIN.get(type_of(b), 0))

static func housing(b: Dictionary) -> int:
	if b.get("rubble", false):
		return 0
	return int(HOUSING.get(type_of(b), 0))

static func face_dir(rot: int) -> Vector2i:
	match norm_rot(rot):
		90: return Vector2i(1, 0)
		180: return Vector2i(0, -1)
		270: return Vector2i(-1, 0)
		_: return Vector2i(0, 1)

static func front_spot(b: Dictionary, dist: int = 1) -> Vector2i:
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	var d := face_dir(int(b.get("rot", 0)))
	var cx := int(b.x) + int(fp.x / 2)
	var cy := int(b.y) + int(fp.y / 2)
	if d.x != 0:
		cx = (int(b.x) + fp.x - 1 + dist) if d.x > 0 else (int(b.x) - dist)
	else:
		cy = (int(b.y) + fp.y - 1 + dist) if d.y > 0 else (int(b.y) - dist)
	return Vector2i(cx, cy)

static func entrance(b: Dictionary) -> Dictionary:
	## The barracks door is offset from the middle of the facade.
	if type_of(b) != "barracks":
		var spot := front_spot(b, 1)
		return {"in": Vector2(spot) + Vector2(0.5, 0.5), "out": Vector2(spot) + Vector2(0.5, 0.5),
			"inCell": spot, "outCell": spot, "face": face_dir(int(b.get("rot", 0)))}
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	var f := face_dir(int(b.get("rot", 0)))
	var u := Vector2i(-f.y, f.x)
	var k := 0.7667
	var cx := float(b.x) + fp.x * 0.5
	var cy := float(b.y) + fp.y * 0.5
	var in_p := Vector2(cx + (-0.55) * k * u.x + 1.60 * k * f.x, cy + (-0.55) * k * u.y + 1.60 * k * f.y)
	var in_cell := Vector2i(floori(in_p.x), floori(in_p.y))
	var out_cell := in_cell
	for _i in range(4):
		var inside := out_cell.x >= int(b.x) and out_cell.x < int(b.x) + fp.x and out_cell.y >= int(b.y) and out_cell.y < int(b.y) + fp.y
		if not inside:
			break
		out_cell += f
	return {"in": in_p, "out": Vector2(out_cell) + Vector2(0.5, 0.5), "inCell": in_cell, "outCell": out_cell, "face": f}

static func obstacle(o: Dictionary) -> bool:
	if o.get("removed", false):
		return false
	if str(o.get("kind", "")) == "tree":
		return true
	if str(o.get("kind", "")) == "stone":
		return str(o.get("variant", "")) != "pebble"
	return false

static func decor(o: Dictionary) -> bool:
	if o.get("removed", false):
		return false
	var k := str(o.get("kind", ""))
	return k == "bush" or k == "tuft" or k == "flower" or k == "reed" or (k == "stone" and str(o.get("variant", "")) == "pebble")

static func occupants(world: ToxWorld, b: Dictionary) -> Array:
	var out := []
	var rect := bounds(b)
	var idx := world.object_index()
	for j in range(rect.size.y):
		for i in range(rect.size.x):
			var cell := Vector2i(rect.position.x + i, rect.position.y + j)
			if idx.has(cell):
				out.append_array(idx[cell])
	return out

static func yard_occupants(world: ToxWorld, b: Dictionary, yard: int = YARD) -> Array:
	var out := []
	var rect := bounds(b)
	var idx := world.object_index()
	for j in range(-yard, rect.size.y + yard):
		for i in range(-yard, rect.size.x + yard):
			if i >= 0 and j >= 0 and i < rect.size.x and j < rect.size.y:
				continue
			var cell := Vector2i(rect.position.x + i, rect.position.y + j)
			if idx.has(cell):
				out.append_array(idx[cell])
	return out

static func can_place(world: ToxWorld, list: Array, b: Dictionary, opts: Dictionary = {}) -> Dictionary:
	var fp := footprint(int(b.get("rot", 0)), type_of(b))
	var res := {"ok": false, "reason": "", "blocked": [], "decor": [], "yard": [], "fp": fp}
	if b.x < 0 or b.y < 0 or b.x + fp.x > world.width or b.y + fp.y > world.height:
		res.reason = "край карты"
		return res
	var water := 0
	var sand := 0
	for j in range(fp.y):
		for i in range(fp.x):
			var t := world.tile[(int(b.y) + j) * world.width + int(b.x) + i]
			if t == ToxWorldGen.T_GRASS:
				continue
			if t == ToxWorldGen.T_SAND:
				sand += 1
			else:
				water += 1
	if water > 0:
		res.reason = "вода"
		return res
	if sand > 0:
		res.reason = "песок"
		return res
	for other in list:
		if other == b or other == null:
			continue
		var a := bounds(b)
		var c := bounds(other)
		if a.position.x < c.position.x + c.size.x and c.position.x < a.position.x + a.size.x and a.position.y < c.position.y + c.size.y and c.position.y < a.position.y + a.size.y:
			res.reason = "тут уже стоит постройка"
			return res
	for o in occupants(world, b):
		if obstacle(o):
			res.blocked.append(o)
		elif decor(o):
			res.decor.append(o)
	res.yard = yard_occupants(world, b, int(opts.get("yard", YARD)))
	var require_clear: bool = bool(opts.get("requireClear", false)) or opts.get("clearable", true) == false
	if not res.blocked.is_empty() and require_clear:
		res.reason = "мешают деревья и камни: %d" % res.blocked.size()
		return res
	var villagers: Array = opts.get("villagers", [])
	for v in villagers:
		if v == null or v.dead:
			continue
		if covers_cell(b, floori(float(v.x)), floori(float(v.y))):
			res.reason = "в пятне житель"
			return res
	res.ok = true
	var n: int = res.blocked.size() + res.yard.size()
	res.reason = ("площадку и двор расчистим: %d" % n) if n > 0 else "место свободно"
	return res

static func settle(world: ToxWorld, b: Dictionary, clear: bool = true, yard: int = YARD) -> int:
	## Remove decorations under the building and its yard. Obstacles only if
	## `clear` is true (village start / generator behaviour).
	var doomed := []
	for o in occupants(world, b):
		if decor(o) or (clear and obstacle(o)):
			doomed.append(o)
	for o in yard_occupants(world, b, yard):
		if decor(o) or (clear and obstacle(o)):
			doomed.append(o)
	var removed := 0
	for o in doomed:
		if not o.get("removed", false):
			o["removed"] = true
			removed += 1
	if removed > 0:
		world.build_rev += 1
		world.object_total = maxi(world.object_total, world.objects.size())
	return removed

static func chop(world: ToxWorld, tree: Dictionary) -> void:
	tree["removed"] = true
	world.build_rev += 1

static func find_site(world: ToxWorld, list: Array, type: String, variant: String, rot: int, near: Vector2i, radius: int, require_clear: bool, villagers: Array = []) -> Dictionary:
	var fp := footprint(rot, type)
	var best: Dictionary = {}
	var best_d := INF
	for r in range(0, radius + 1):
		for dy in range(-r, r + 1):
			for dx in range(-r, r + 1):
				if maxi(abs(dx), abs(dy)) != r:
					continue
				var x := near.x + dx
				var y := near.y + dy
				var b := make(type, variant, rot, x, y, 0)
				var res := can_place(world, list, b, {"requireClear": require_clear, "clearable": not require_clear, "villagers": villagers})
				if res.ok:
					var d := Vector2(x - near.x, y - near.y).length()
					if d < best_d:
						best_d = d
						best = b
		if not best.is_empty() and r > 4:
			break
	return best

static func damage(b: Dictionary, amount: float) -> bool:
	if b.get("rubble", false):
		return false
	b.hp = float(b.get("hp", 50)) - amount
	b.flinch = 0.16
	if b.hp <= 0.0:
		b.hp = 0.0
		b.rubble = true
		return true
	return false
