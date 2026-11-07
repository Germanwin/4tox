extends SceneTree

## Регрессия: газон под постройкой запекается один раз на постройку, а не на
## каждый кадр/каждый снимок. Перепекание 3–7 газонов стоило 1–2 с на кадр —
## именно это и было «1–3 fps» после постройки дома.

const Plots = preload("res://scripts/plots.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== кеш газонов")
	var bdata = BuildingsData.new()
	var buildings: Array = [
		{"id": "b0", "type": "house", "variant": "a", "rot": 90, "x": 10, "y": 10},
		{"id": "b1", "type": "townhall", "variant": "a", "rot": 90, "x": 20, "y": 12},
	]
	var cache: Dictionary = {}
	Plots.bakes = 0
	var first: Array = Plots.build_for(buildings, bdata, cache)
	check(first.size() == 2, "запечены два газона")
	check(Plots.bakes == 2, "первый вызов запекает 2 (сейчас %d)" % Plots.bakes)
	var second: Array = Plots.build_for(buildings, bdata, cache)
	check(Plots.bakes == 2, "повторный вызов не запекает (сейчас %d)" % Plots.bakes)
	check(second.size() == 2 and second[0]["tex"] == first[0]["tex"], "текстуры взяты из кеша")
	buildings[0] = buildings[0].duplicate()
	buildings[0]["x"] = 11
	var third: Array = Plots.build_for(buildings, bdata, cache)
	check(Plots.bakes == 3, "переезд одной постройки запекает только её (сейчас %d)" % Plots.bakes)
	check(third.size() == 2, "после переезда оба газона на месте")
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
