extends SceneTree

## Тряска деревьев по treeHits: математика затухания и то, что в тряску
## попадает ровно дерево из снимка (а не любой объект), и что удар старше
## 0,4 с уже не трясёт. Картинку снимает tests/render_shake.gd.

const WorldData = preload("res://scripts/world_data.gd")
const Nature = preload("res://scripts/nature.gd")
const WorldLayer = preload("res://scripts/world_layer.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	print("== тряска деревьев")
	check(is_equal_approx(WorldLayer.shake_value(0), 0.0), "в момент удара сдвиг 0")
	check(WorldLayer.shake_value(440) == 0.0, "к 0,44 с тряска кончилась (порог 0,02)")
	check(WorldLayer.shake_value(500) == 0.0, "опоздавший удар не трясёт")
	var peak := 0.0
	for ms in range(0, 441, 5):
		peak = maxf(peak, absf(WorldLayer.shake_value(ms)))
	check(peak > 0.3 and peak <= 1.0, "размах в пределах 0..1: %.3f" % peak)
	check(WorldLayer.shake_value(35) > 0.0, "первая четверть периода — в плюс")
	check(WorldLayer.shake_value(110) < 0.0, "вторая — в минус")

	var world = WorldData.new()
	var lr: Dictionary = world.load_json(FileAccess.get_file_as_string("res://tests/fixtures/world.json"))
	check(lr.get("ok", false), "мир фикстуры")
	var layer = WorldLayer.new()
	layer.objects = world.objects
	layer.nature = Nature.new()
	layer.nature.load_atlas()
	layer._prepare_objects()
	var tree_id := ""
	for o in world.objects:
		if str(o.get("kind", "")) == "tree":
			tree_id = str(o.get("id", ""))
			break
	check(tree_id != "", "дерево в мире: " + tree_id)
	var now := Time.get_ticks_msec()
	layer.set_shake({tree_id: now - 50}, now)
	check(layer.shaking_ids().has(tree_id), "удар попал в дерево")
	layer.shake_now_ms = now + 500
	check(not layer.shaking_ids().has(tree_id), "старый удар не трясёт")
	var other := ""
	for o in world.objects:
		if str(o.get("kind", "")) != "tree":
			other = str(o.get("id", ""))
			break
	layer.set_shake({other: now - 10, tree_id: now - 10}, now)
	check(layer.shaking_ids().has(other), "возраст переносится, id не фильтруется типом")
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL SHAKE TESTS PASSED")
		quit(0)
	else:
		print("SHAKE TESTS FAILED")
		quit(1)
