class_name ToxWorldData
extends RefCounted

## Static world as data: tiles, land mask, distance fields, nature objects.
## The client never generates an island itself — for M1 it reads the fixture
## exported by tests/export_world.js, in M2 the same shape arrives from the
## server (WLD1). Generation in GDScript would drift from the browser's noise
## and move every tree, which is exactly what killed the previous port.

const KINDS := {"tree": 0, "bush": 1, "tuft": 2, "flower": 3, "stone": 4, "reed": 5}
const T_DEEP := 0
const T_WATER := 1
const T_SHALLOW := 2
const T_SAND := 3
const T_GRASS := 4

var width := 0
var height := 0
var island_size := 0
var seed := ""
var worldgen_hash := ""
var water_threshold := 0.0
var tile := PackedByteArray()
var is_land := PackedByteArray()
var dist_land := PackedFloat32Array()
var dist_water := PackedFloat32Array()
var objects: Array = []


## Fills this instance. Returns {"ok": true} or {"ok": false, "error": "..."}.
func load_json(text: String) -> Dictionary:
	var data: Variant = JSON.parse_string(text)
	if data == null or not (data is Dictionary):
		return {"ok": false, "error": "мир: не JSON-объект"}
	var d: Dictionary = data
	if d.get("format", "") != "4tox-world-json":
		return {"ok": false, "error": "мир: другой формат"}
	width = int(d.get("width", 0))
	height = int(d.get("height", 0))
	island_size = int(d.get("size", 0))
	seed = str(d.get("seed", ""))
	worldgen_hash = str(d.get("worldgenHash", ""))
	water_threshold = float(d.get("waterThreshold", 0.0))
	if width <= 0 or height <= 0:
		return {"ok": false, "error": "мир: пустые размеры"}
	var n := width * height
	if d.get("tile", []).size() != n:
		return {"ok": false, "error": "мир: tile не %d клеток" % n}
	if d.get("isLand", []).size() != n:
		return {"ok": false, "error": "мир: isLand не %d клеток" % n}
	if d.get("distLand", []).size() != n or d.get("distWater", []).size() != n:
		return {"ok": false, "error": "мир: dist-поля не %d клеток" % n}
	tile = _bytes_from_array(d["tile"])
	is_land = _bytes_from_array(d["isLand"])
	dist_land = _floats_from_array(d["distLand"])
	dist_water = _floats_from_array(d["distWater"])
	objects.clear()
	for o in d.get("objects", []):
		var kind := str(o.get("kind", ""))
		if not KINDS.has(kind):
			return {"ok": false, "error": "мир: неизвестный вид объекта " + kind}
		var sc: Variant = o.get("scale", 1.0)
		var ph: Variant = o.get("phase", 0.0)
		objects.append({
			"kind": kind, "kind_id": KINDS[kind],
			"variant": o.get("variant"),
			"x": float(o["x"]), "y": float(o["y"]),
			"scale": float(sc if sc != null else 1.0),
			"phase": float(ph if ph != null else 0.0),
			"id": int(o.get("id", 0))
		})
	return {"ok": true}


static func _bytes_from_array(a: Array) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(a.size())
	for i in range(a.size()):
		out[i] = int(a[i])
	return out


static func _floats_from_array(a: Array) -> PackedFloat32Array:
	var out := PackedFloat32Array()
	out.resize(a.size())
	for i in range(a.size()):
		out[i] = float(a[i])
	return out


func cell(x: int, y: int) -> int:
	return y * width + x


func tile_at(x: int, y: int) -> int:
	return tile[cell(x, y)]


func is_land_at(x: int, y: int) -> bool:
	return is_land[cell(x, y)] != 0


func object_count() -> int:
	return objects.size()


func describe() -> String:
	return "мир %dx%d, остров %d, hash %s, объектов %d" % [
		width, height, island_size, worldgen_hash, objects.size()
	]
