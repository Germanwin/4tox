extends SceneTree

## M1a acceptance for the static world: the exported world must be the SAME
## island the server snapshotted (worldgenHash), with every object accounted
## for (objectTotal), and the masks must agree with the tile codes.
##
## Run: Godot --headless --path . -s res://tests/test_world.gd

const WorldData = preload("res://scripts/world_data.gd")
const DIR := "res://tests/fixtures"

var fails := 0
var checks := 0


func check(cond: bool, what: String) -> void:
	checks += 1
	if cond:
		print("  ok   ", what)
	else:
		fails += 1
		print("  FAIL ", what)


func _init() -> void:
	var text := FileAccess.get_file_as_string(DIR + "/world.json")
	if text.is_empty():
		print("нет мира: node godot/tests/export_world.js")
		quit(1)
		return
	var start: Variant = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/start.json"))
	var base: Dictionary = start["start"]["baseline"]

	var t0 := Time.get_ticks_msec()
	var w = WorldData.new()
	var res: Dictionary = w.load_json(text)
	var load_ms := Time.get_ticks_msec() - t0
	check(res.get("ok", false), "мир загружен за %d мс: %s" % [load_ms, res.get("error", "")])
	if not res.get("ok", false):
		quit(1)
		return
	print("== ", w.describe())

	check(w.worldgen_hash == str(base.get("worldgenHash")), "worldgenHash совпал с сервером")
	check(w.seed == str(base.get("seed")), "seed совпал")
	check(w.island_size == int(base.get("size")), "размер острова %d" % w.island_size)
	check(w.object_count() == int(base.get("objectTotal")),
		"объектов %d = objectTotal %d" % [w.object_count(), int(base.get("objectTotal"))])
	check(w.tile.size() == w.width * w.height, "клеток %d" % w.tile.size())

	# Маска суши обязана быть производной от кода клетки, а не отдельной
	# правдой: иначе рендер и коллизии разъедутся.
	var bad_mask := 0
	var land := 0
	for i in range(w.tile.size()):
		var expected := 1 if w.tile[i] >= WorldData.T_SAND else 0
		if w.is_land[i] != expected:
			bad_mask += 1
		land += expected
	check(bad_mask == 0, "isLand = (tile >= SAND) во всех клетках (расхождений %d)" % bad_mask)
	check(land > 0 and land < w.tile.size(), "суша %d из %d клеток" % [land, w.tile.size()])

	var kinds := {}
	for o in w.objects:
		kinds[o["kind"]] = int(kinds.get(o["kind"], 0)) + 1
	check(kinds.size() == 6, "шесть видов природы: " + str(kinds))

	# Постройки из снимка обязаны стоять на суше этого мира.
	var on_water := 0
	for b in base.get("buildings", []):
		var x := int(floor(float(b["x"])))
		var y := int(floor(float(b["y"])))
		if x < 0 or y < 0 or x >= w.width or y >= w.height:
			on_water += 1
		elif not w.is_land_at(x, y):
			on_water += 1
	check(on_water == 0, "все постройки на суше (промахов %d)" % on_water)

	var max_dl := 0.0
	var max_dw := 0.0
	for i in range(w.dist_land.size()):
		max_dl = maxf(max_dl, w.dist_land[i])
		max_dw = maxf(max_dw, w.dist_water[i])
	check(max_dl > 0.0 and max_dw > 0.0, "dist-поля не пустые: land %.1f, water %.1f" % [max_dl, max_dw])

	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL WORLD TESTS PASSED")
		quit(0)
	else:
		print("WORLD TESTS FAILED")
		quit(1)
