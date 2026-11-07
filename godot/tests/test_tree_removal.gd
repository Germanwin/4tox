extends SceneTree

## Красный тест «срубленное дерево исчезает, и следующее тоже».
## Раньше `_on_live_snapshot` применял removed один раз и обнулял
## `_live_objects`; со второго срубленного дерева фильтр уже не работал.

const HybridDemo = preload("res://scripts/hybrid_demo.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _removed(bits: Array, total: int) -> String:
	var bytes := PackedByteArray()
	bytes.resize(maxi(1, (total + 7) / 8))
	for i in bits:
		bytes[int(i) >> 3] |= 1 << (int(i) & 7)
	return bytes.hex_encode()


func _objects(n: int) -> Array:
	var out: Array = []
	for i in range(n):
		out.append({"id": i, "kind": "tree", "variant": "oak",
			"x": 4.0 + float(i), "y": 8.0, "scale": 1.0, "phase": 0.0})
	return out


func _snap(seq: int, removed: String) -> Dictionary:
	return {"revision": seq, "seq": seq, "buildings": [], "villagers": [],
		"towns": [], "removed": removed, "treeHits": [], "simulationTimeMs": 0}


func _init() -> void:
	_run()


func _run() -> void:
	print("== срубленные деревья")
	var objects := _objects(10)
	var demo = HybridDemo.new()
	root.add_child(demo)
	await process_frame
	demo._layer = WorldLayer.new()
	demo._layer.objects = objects.duplicate()
	demo._live_objects = objects.duplicate()

	demo._on_live_snapshot(_snap(1, _removed([0], 10)))
	check(demo._layer.objects.size() == 9,
		"после первого removed объектов 9 (сейчас %d)" % demo._layer.objects.size())

	demo._on_live_snapshot(_snap(2, _removed([0, 1], 10)))
	check(demo._layer.objects.size() == 8,
		"после второго removed объектов 8 (сейчас %d)" % demo._layer.objects.size())
	check(str(demo._layer.objects[0].get("id", "")) != "1",
		"второе дерево тоже убрано")

	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
