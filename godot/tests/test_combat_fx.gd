extends SceneTree

## Боевая картинка без сети: какие постройки/жители получают HP-полосу.
## Завал (rubble) полосы не получает, целая постройка — тоже, раненый воин —
## получает. Кадр для глаз — tests/render_combat.gd (shots/combat.png).

const MatchFx = preload("res://scripts/match_fx.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	print("== HP-полосы")
	var fx = MatchFx.new()
	fx.buildings = [
		{"id": "a", "type": "townhall", "x": 10, "y": 10, "hp": 42.0, "maxHp": 120.0},
		{"id": "b", "type": "house", "x": 14, "y": 10, "hp": 50.0, "maxHp": 50.0},
		{"id": "c", "type": "lumbercamp", "x": 18, "y": 10, "hp": 0.0, "maxHp": 35.0, "rubble": true},
		{"id": "d", "type": "barracks", "x": 22, "y": 10, "hp": 79.0, "maxHp": 80.0},
	]
	fx.villagers = [
		{"id": 1, "x": 10, "y": 12, "hp": 8.0, "warrior": true},
		{"id": 2, "x": 11, "y": 12, "hp": 10.0},
		{"id": 3, "x": 12, "y": 12, "hp": 25.0, "warrior": true},
		{"id": 4, "x": 13, "y": 12, "hp": 0.0},
	]
	var bl: Array = fx.hp_bar_buildings()
	check(bl.size() == 2, "полосы у двух повреждённых построек: %d" % bl.size())
	check(bl.any(func(b): return str(b["id"]) == "a"), "раненая ратуша с полосой")
	check(bl.any(func(b): return str(b["id"]) == "d"), "чуть повреждённая казарма с полосой")
	check(not bl.any(func(b): return str(b["id"]) == "b"), "целый дом без полосы")
	check(not bl.any(func(b): return str(b["id"]) == "c"), "завал без полосы")
	var vl: Array = fx.hp_bar_villagers()
	check(vl.size() == 2, "полосы у двух раненых: %d" % vl.size())
	check(vl.any(func(v): return int(v["id"]) == 1), "раненый воин с полосой")
	check(vl.any(func(v): return int(v["id"]) == 2), "раненый житель с полосой")
	check(not vl.any(func(v): return int(v["id"]) == 3), "целый воин без полосы")
	check(not vl.any(func(v): return int(v["id"]) == 4), "мёртвый без полосы")
	fx.free()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL COMBAT FX TESTS PASSED")
		quit(0)
	else:
		print("COMBAT FX TESTS FAILED")
		quit(1)
