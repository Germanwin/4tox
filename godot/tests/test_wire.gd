extends SceneTree

## M1a acceptance: the GDScript decoder must reproduce the server's own JSON
## baseline for the very same world, field by field. A frame that merely
## "reads" is not enough — a silent offset would still render something.
##
## Run: Godot --headless --path . -s res://tests/test_wire.gd

const Wire = preload("res://scripts/wire.gd")
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


func near(a: float, b: float, eps := 0.011) -> bool:
	return absf(a - b) <= eps


func _init() -> void:
	var frame := FileAccess.get_file_as_bytes(DIR + "/frame.bin")
	var text := FileAccess.get_file_as_string(DIR + "/start.json")
	if frame.is_empty() or text.is_empty():
		print("нет фикстур: node godot/tests/capture_fixture.js")
		quit(1)
		return
	var parsed: Variant = JSON.parse_string(text)
	if parsed == null:
		print("start.json не разобрался")
		quit(1)
		return
	var base: Dictionary = parsed["start"]["baseline"]

	print("== кадр ", frame.size(), " Б, эталон rev ", base.get("revision"))
	var res: Dictionary = Wire.unpack(frame)
	check(res.get("ok", false), "кадр разобран без ошибок: " + str(res.get("error", "")))
	if not res.get("ok", false):
		quit(1)
		return
	var s: Dictionary = res["snapshot"]

	# --- заголовок и мир -------------------------------------------------
	check(s["protocol"] == base.get("protocol"), "protocol = %s" % s["protocol"])
	check(s["size"] == base.get("size"), "size = %s" % s["size"])
	check(s["roomId"] == base.get("roomId"), "roomId = %s" % s["roomId"])
	check(s["seed"] == base.get("seed"), "seed = %s" % s["seed"])
	check(s["epoch"] == base.get("epoch"), "epoch = %s" % s["epoch"])
	check(s["revision"] >= base.get("revision", 0), "revision не отстаёт: %s >= %s" % [s["revision"], base.get("revision")])
	check(s["removed"] == base.get("removed"), "removed совпал (%d символов)" % str(s["removed"]).length())
	check(s["objectTotal"] == base.get("objectTotal"), "objectTotal = %s" % s["objectTotal"])

	# --- деревни ---------------------------------------------------------
	var towns: Array = s["towns"]
	var bt: Array = base.get("towns", [])
	check(towns.size() == bt.size(), "деревень %d" % towns.size())
	for i in range(mini(towns.size(), bt.size())):
		var t: Dictionary = towns[i]
		var b: Dictionary = bt[i]
		check(int(t["id"]) == int(b["id"]) and t["name"] == b["name"] and t["color"] == b["color"],
			"деревня %d: id/имя/цвет" % i)
		check(int(t["owner"]) == int(b["owner"]) and bool(t["alive"]) == bool(b["alive"]),
			"деревня %d: владелец/жива" % i)
		check(int(t["logs"]) == int(b["logs"]) and t["vid"] == b.get("vid"),
			"деревня %d: брёвна/житель" % i)

	# --- постройки -------------------------------------------------------
	var bs: Array = s["buildings"]
	var bb: Array = base.get("buildings", [])
	check(bs.size() == bb.size(), "построек %d" % bs.size())
	var by_id := {}
	for b in bb:
		by_id[str(b["id"])] = b
	var bad := 0
	for b in bs:
		var ref: Variant = by_id.get(str(b["id"]))
		if ref == null:
			bad += 1
			continue
		if str(b["type"]) != str(ref["type"]) or str(b["variant"]) != str(ref["variant"]):
			bad += 1
		elif int(b["rot"]) != int(ref["rot"]):
			bad += 1
		elif not near(float(b["x"]), float(ref["x"])) or not near(float(b["y"]), float(ref["y"])):
			bad += 1
		elif not near(float(b["hp"]), float(ref["hp"])) or not near(float(b["maxHp"]), float(ref["maxHp"])):
			bad += 1
		elif int(b["owner"]) != int(ref["owner"]) or bool(b["rubble"]) != bool(ref["rubble"]):
			bad += 1
	check(bad == 0, "все постройки совпали по id/типу/повороту/месту/HP (расхождений %d)" % bad)

	# --- жители ----------------------------------------------------------
	var vs: Array = s["villagers"]
	var bv: Array = base.get("villagers", [])
	check(vs.size() == bv.size(), "жителей %d" % vs.size())
	var v_by_id := {}
	for v in bv:
		v_by_id[int(v["id"])] = v
	var moved := 0
	var lost := 0
	for v in vs:
		var ref: Variant = v_by_id.get(int(v["id"]))
		if ref == null:
			lost += 1
			continue
		# Кадр снят на несколько тиков позже baseline: место может уехать.
		if absf(float(v["x"]) - float(ref["x"])) > 1.0 or absf(float(v["y"]) - float(ref["y"])) > 1.0:
			moved += 1
		if int(v["rot"]) != int(ref["rot"]):
			moved += 1
	check(lost == 0, "все id жителей есть в эталоне")
	check(moved == 0, "жители не разъехались больше чем на клетку (расхождений %d)" % moved)
	if vs.size() > 0:
		check(vs[0].has("homeId") and vs[0].has("anim"), "у жителя есть homeId/anim")
		check(vs[0].has("motion") == bv[0].has("motion"), "motion: %s" % vs[0].has("motion"))

	# --- хвост кадра -----------------------------------------------------
	check(s["treeHits"] is Array, "treeHits — список (%d)" % s["treeHits"].size())
	check(not s.has("commandResults") or s["commandResults"] is Array, "commandResults корректен")

	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL WIRE TESTS PASSED")
		quit(0)
	else:
		print("WIRE TESTS FAILED")
		quit(1)
