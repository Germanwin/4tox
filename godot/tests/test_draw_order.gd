extends SceneTree

## Красный тест порядка глубины: природа, постройки и жители должны идти
## ОДНИМ потоком по (x+y), как `Renderer.eachSprite` в браузере. Раньше все
## деревья рисовались до построек и жителей, поэтому житель «ходил сквозь
## дерево», а трясущееся дерево было поверх всех ближних.

const WorldLayer = preload("res://scripts/world_layer.gd")
const Nature = preload("res://scripts/nature.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")
const VillagersData = preload("res://scripts/villagers_data.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _index_of(plan: Array, kind: String) -> int:
	for i in range(plan.size()):
		if str(plan[i].get("kind", "")) == kind:
			return i
	return -1


func _init() -> void:
	_run()


func _run() -> void:
	print("== порядок глубины")
	var layer = WorldLayer.new()
	root.add_child(layer)
	await process_frame
	layer.objects = [
		{"id": 1, "kind": "tree", "variant": "oak", "x": 10.0, "y": 10.0,
			"scale": 1.0, "phase": 0.0},
		{"id": 2, "kind": "tree", "variant": "oak", "x": 60.0, "y": 60.0,
			"scale": 1.0, "phase": 0.0},
	]
	layer.nature = Nature.new()
	layer.nature.load_atlas()
	layer.bdata = BuildingsData.new()
	layer.vdata = VillagersData.new()
	layer.buildings = [
		{"id": "b1", "type": "house", "variant": "a", "rot": 90,
			"x": 30, "y": 30, "owner": 0, "town": 0, "hp": 100, "maxHp": 100},
	]
	layer.villagers = [
		{"id": 7, "x": 45.0, "y": 45.0, "rot": 90, "anim": "walk",
			"phase": 0.0, "owner": 0, "hidden": false, "warrior": false},
	]
	layer.set_shake({"1": Time.get_ticks_msec() - 20}, Time.get_ticks_msec())

	var plan: Array = layer.draw_plan()
	check(not plan.is_empty(), "план отрисовки собран")
	if plan.is_empty():
		print("итог: %d проверок, %d FAIL" % [checks, fails])
		quit(1)
		return
	var prev := -INF
	var monotonic := true
	for e in plan:
		var d := float(e.get("depth", 0.0))
		if d + 0.0001 < prev:
			monotonic = false
		prev = maxf(prev, d)
	check(monotonic, "план идёт по возрастанию глубины")
	var b_at := _index_of(plan, "building")
	var v_at := _index_of(plan, "villager")
	var first_nature := _index_of(plan, "nature")
	check(first_nature >= 0, "природа в плане есть")
	check(b_at > first_nature, "постройка идёт после дальней природы")
	check(v_at > b_at, "житель глубже постройки идёт после неё")
	var nature_after := -1
	for i in range(plan.size()):
		if str(plan[i].get("kind", "")) == "nature" and float(plan[i].get("depth", 0.0)) > 100.0:
			nature_after = i
	check(nature_after > v_at, "ближняя природа идёт после жителя")
	var shaken_at := -1
	for i in range(plan.size()):
		if str(plan[i].get("kind", "")) == "nature" and bool(plan[i].get("shake", false)):
			shaken_at = i
	check(shaken_at >= 0 and shaken_at < b_at,
		"трясущееся дерево осталось в своей глубине, а не поверх всех")

	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
