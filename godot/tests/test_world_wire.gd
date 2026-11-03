extends SceneTree

## The WLD1 payload must describe the same island as the server's own world and
## as the JSON fixture: same tiles and mask exactly, distances and positions
## within the 1/100 quantisation.

const WorldData = preload("res://scripts/world_data.gd")
const WorldWire = preload("res://scripts/world_wire.gd")
const DIR := "res://tests/fixtures"

var fails := 0
var checks := 0


func check(c: bool, s: String) -> void:
	checks += 1
	print(("  ok   " if c else "  FAIL ") + s)
	if not c:
		fails += 1


func near(a: float, b: float, eps := 0.011) -> bool:
	return absf(a - b) <= eps


func _init() -> void:
	var bytes := FileAccess.get_file_as_bytes(DIR + "/world.bin")
	if bytes.is_empty():
		print("нет world.bin: node godot/tests/capture_fixture.js")
		quit(1)
		return
	var ref = WorldData.new()
	var lr: Dictionary = ref.load_json(FileAccess.get_file_as_string(DIR + "/world.json"))
	check(lr.get("ok", false), "JSON-мир загружен")
	var got = WorldData.new()
	var res: Dictionary = WorldWire.unpack_into(got, bytes)
	check(res.get("ok", false), "WLD1 разобран: " + str(res.get("error", "")))
	if not res.get("ok", false):
		quit(1)
		return
	print("== ", bytes.size(), " Б, ", got.describe())
	check(got.width == ref.width and got.height == ref.height, "размеры %dx%d" % [got.width, got.height])
	check(got.island_size == ref.island_size, "размер острова %d" % got.island_size)
	check(got.seed == ref.seed, "сид совпал")
	check(got.worldgen_hash == ref.worldgen_hash, "hash %s" % got.worldgen_hash)
	check(got.tile == ref.tile, "тайлы совпали побайтно")
	check(got.is_land == ref.is_land, "маска суши совпала")
	var bad := 0
	for i in range(got.dist_land.size()):
		if not near(got.dist_land[i], ref.dist_land[i], 0.006):
			bad += 1
	check(bad == 0, "distLand в пределах 1/100 (расхождений %d)" % bad)
	bad = 0
	for i in range(got.dist_water.size()):
		if not near(got.dist_water[i], ref.dist_water[i], 0.006):
			bad += 1
	check(bad == 0, "distWater в пределах 1/100 (расхождений %d)" % bad)
	check(got.objects.size() == ref.objects.size(), "объектов %d" % got.objects.size())
	bad = 0
	for i in range(mini(got.objects.size(), ref.objects.size())):
		var a: Dictionary = got.objects[i]
		var b: Dictionary = ref.objects[i]
		if a["kind"] != b["kind"] or a["variant"] != b["variant"] or int(a["id"]) != int(b["id"]):
			bad += 1
		elif not near(float(a["x"]), float(b["x"])) or not near(float(a["y"]), float(b["y"])):
			bad += 1
		elif not near(float(a["scale"]), float(b["scale"]), 0.0011):
			bad += 1
		elif not near(float(a["phase"]), float(b["phase"]), 0.0011):
			bad += 1
	if bad > 0:
		var shown := 0
		for i in range(mini(got.objects.size(), ref.objects.size())):
			var a: Dictionary = got.objects[i]
			var b: Dictionary = ref.objects[i]
			var why := ""
			if a["kind"] != b["kind"]: why = "kind"
			elif a["variant"] != b["variant"]: why = "variant"
			elif int(a["id"]) != int(b["id"]): why = "id"
			elif not near(float(a["x"]), float(b["x"])): why = "x"
			elif not near(float(a["y"]), float(b["y"])): why = "y"
			elif not near(float(a["scale"]), float(b["scale"]), 0.0011): why = "scale"
			elif not near(float(a["phase"]), float(b["phase"]), 0.0011): why = "phase"
			if why != "" and shown < 3:
				print("  diff ", i, " ", why, ": ", a, " != ", b)
				shown += 1
	check(bad == 0, "все объекты совпали (расхождений %d)" % bad)
	var on_water := 0
	for o in got.objects:
		if not got.is_land_at(int(o["x"]), int(o["y"])):
			on_water += 1
	check(on_water == 0, "объекты на суше (промахов %d)" % on_water)

	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL WORLD-WIRE TESTS PASSED")
		quit(0)
	else:
		print("WORLD-WIRE TESTS FAILED")
		quit(1)
