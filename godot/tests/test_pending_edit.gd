extends SceneTree

## Красный/зелёный тест оптимистичной правки: перенос, поворот и снос видны в
## кадре сразу, а старый снимок не откатывает их назад. Снимок с новым местом
## снимает ожидание.

const HybridDemo = preload("res://scripts/hybrid_demo.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const VillagersData = preload("res://scripts/villagers_data.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _b(x: int, y: int, rot := 90) -> Dictionary:
	return {"id": "b1", "type": "house", "variant": "a", "rot": rot,
		"x": x, "y": y, "owner": 0, "town": 0, "hp": 100, "maxHp": 100}


func _snap(seq: int, buildings: Array) -> Dictionary:
	return {"revision": seq, "seq": seq, "buildings": buildings,
		"villagers": [], "towns": [], "removed": "", "treeHits": [],
		"simulationTimeMs": 0}


func _init() -> void:
	_run()


func _run() -> void:
	print("== ожидающая правка")
	var demo = HybridDemo.new()
	root.add_child(demo)
	await process_frame
	demo._layer = WorldLayer.new()
	demo._layer.bdata = BuildingsData.new()
	demo._layer.vdata = VillagersData.new()
	demo._layer.villagers = [{"id": 7, "x": 8.0, "y": 8.0, "rot": 90,
		"anim": "walk", "phase": 0.0, "owner": 0, "hidden": false, "warrior": false}]
	demo._last_snap = _snap(1, [_b(5, 5)])
	demo._layer.buildings = [_b(5, 5)]
	demo._on_live_snapshot(_snap(2, [_b(5, 5)]))
	demo._layer.draw_plan()  # собрать план со старым местом
	var sig0: String = demo._layer._villager_sig(40.0)
	demo.apply_pending_edit("b1", "move", 10, 20)
	var sig1: String = demo._layer._villager_sig(40.0)
	check(sig0 != sig1, "подпись кадра меняется, когда постройка переехала")
	var b: Dictionary = demo.building_by_id("b1")
	check(not b.is_empty() and int(b.get("x", 0)) == 10 and int(b.get("y", 0)) == 20,
		"перенос виден сразу, до снимка")
	# И не только в списке: план кадра должен пересобраться на новое место.
	var plan: Array = demo._layer.draw_plan()
	var plan_depth := -1.0
	for e in plan:
		if str(e.get("kind", "")) == "building":
			plan_depth = float(e.get("depth", -1.0))
	check(plan_depth > 25.0, "кадр пересобрал постройку на новом месте (%.1f)" % plan_depth)

	demo._on_live_snapshot(_snap(3, [_b(5, 5)]))
	b = demo.building_by_id("b1")
	check(not b.is_empty() and int(b.get("x", 0)) == 10,
		"старый снимок не откатывает перенос")
	check(demo.pending_edits().has("b1"), "ожидание ещё держится")

	demo._on_live_snapshot(_snap(4, [_b(10, 20)]))
	b = demo.building_by_id("b1")
	check(not b.is_empty() and int(b.get("x", 0)) == 10 and int(b.get("y", 0)) == 20,
		"подтверждённый снимок оставил дом на месте")
	check(not demo.pending_edits().has("b1"), "подтверждение сняло ожидание")

	demo.apply_pending_edit("b1", "rotate", 0, 0, 180)
	b = demo.building_by_id("b1")
	check(int(b.get("rot", 0)) == 180, "поворот виден сразу")
	demo._on_live_snapshot(_snap(5, [_b(10, 20, 180)]))
	check(not demo.pending_edits().has("b1"), "снимок снял ожидание поворота")

	demo.apply_pending_edit("b1", "delete")
	check(demo.building_by_id("b1").is_empty(), "снос убирает дом сразу")
	demo._on_live_snapshot(_snap(6, [_b(10, 20, 180)]))
	check(demo.building_by_id("b1").is_empty(),
		"старый снимок не возвращает снесённый дом")
	demo._on_live_snapshot(_snap(7, []))
	check(not demo.pending_edits().has("b1"), "подтверждённый снос снял ожидание")

	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
