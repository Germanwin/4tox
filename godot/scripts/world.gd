class_name ToxWorld
extends RefCounted

## The generated island. Mirrors the fields of mapgen2/js/worldgen.js.

const TILE_NAMES := {
	0: "Глубина", 1: "Вода", 2: "Отмель", 3: "Песок", 4: "Трава"
}
const VARIANT_NAMES := {
	"oak": "Дуб", "pine": "Сосна", "birch": "Берёза", "autumn": "Осеннее дерево",
	"pebble": "Галька", "boulder": "Валун", "rock": "Каменный выход",
	"iron": "Железная руда", "salt": "Соль"
}

var width: int = 0
var height: int = 0
var seed_text: String = ""
var seed_int: int = 0
var params: Dictionary = {}
var sea: int = 0
var rim: int = 0
var island_size: int = 0

var tile: PackedByteArray = PackedByteArray()
var is_land: PackedByteArray = PackedByteArray()
var height_field: PackedFloat32Array = PackedFloat32Array()
var elevation: PackedFloat32Array = PackedFloat32Array()
var forestness: PackedFloat32Array = PackedFloat32Array()
var stonyness: PackedFloat32Array = PackedFloat32Array()
var moisture: PackedFloat32Array = PackedFloat32Array()
var fertility: PackedFloat32Array = PackedFloat32Array()
var dist_water: PackedFloat32Array = PackedFloat32Array()
var dist_land: PackedFloat32Array = PackedFloat32Array()

var objects: Array = []
var object_total: int = 0
var stats: Dictionary = {}
var land_bounds: Rect2i = Rect2i()
var time: float = 0.0
var towns: Array = []
var village: Variant = null
var build_rev: int = 0
var buildings: Array = []
var villagers: Array = []
var _obj_index_key: String = ""
var _obj_index: Dictionary = {}

func index(x: int, y: int) -> int:
	return y * width + x

func inside(x: int, y: int) -> bool:
	return x >= 0 and y >= 0 and x < width and y < height

func tile_at(x: int, y: int) -> int:
	if not inside(x, y):
		return -1
	return tile[y * width + x]

func is_land_at(x: int, y: int) -> bool:
	return inside(x, y) and is_land[y * width + x] == 1

func forest_at(x: int, y: int) -> float:
	return forestness[y * width + x] if inside(x, y) else 0.0

func stony_at(x: int, y: int) -> float:
	return stonyness[y * width + x] if inside(x, y) else 0.0

func describe_cell(x: int, y: int) -> Dictionary:
	if not inside(x, y):
		return {"inside": false, "x": x, "y": y, "tile": -1, "name": null, "extra": "", "text": null}
	var t := tile[y * width + x]
	var extra := ""
	if t == ToxWorldGen.T_GRASS:
		if forestness[y * width + x] > 0.35:
			extra = " · роща"
		elif stonyness[y * width + x] > 0.3:
			extra = " · камень"
	return {
		"inside": true, "x": x, "y": y, "tile": t,
		"name": TILE_NAMES.get(t, "?"), "extra": extra,
		"text": "%d, %d · %s%s" % [x, y, TILE_NAMES.get(t, "?"), extra],
		"land": is_land[y * width + x] == 1
	}

func walkable_cell(x: int, y: int) -> bool:
	if not is_land_at(x, y):
		return false
	return tile[y * width + x] == ToxWorldGen.T_GRASS or tile[y * width + x] == ToxWorldGen.T_SAND

func object_cells() -> Dictionary:
	## Solid nature objects by cell: trees and stones larger than a pebble.
	var out := {}
	for o in objects:
		if not o.get("removed", false) and (o.kind == "tree" or (o.kind == "stone" and o.variant != "pebble")):
			out[Vector2i(floori(o.x), floori(o.y))] = o
	return out

func object_index() -> Dictionary:
	var key := "%d:%d" % [build_rev, objects.size()]
	if _obj_index_key == key:
		return _obj_index
	_obj_index_key = key
	_obj_index = {}
	for o in objects:
		if o.get("removed", false):
			continue
		var c := Vector2i(floori(float(o.x)), floori(float(o.y)))
		if not _obj_index.has(c):
			_obj_index[c] = []
		_obj_index[c].append(o)
	return _obj_index

func village_bounds() -> Rect2:
	if village == null:
		return Rect2()
	return village.get("bounds", Rect2())
