extends SceneTree

## Руины: атлас `assets/ruins` — пять типов × четыре поворота, у кадров свои
## ppu/mul (ратуша 80, остальные 96). Клиент обязан брать кадр по ТИПУ
## снесённой постройки, иначе подмена спрайта сдвигает завал с пятна.

const BData = preload("res://scripts/buildings_data.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	print("== руины")
	var d = BData.new()
	var s: Dictionary = d.set_for("ruins")
	check(not s.is_empty(), "атлас руин загружен")
	check(not (s.get("tex") == null), "текстура руин есть")
	var types := ["townhall", "house", "lumbercamp", "barracks", "warcamp"]
	for t in types:
		var n := 0
		for rot in [0, 90, 180, 270]:
			var f: Dictionary = d.frame_for("ruins", t, rot)
			if f.is_empty():
				continue
			n += 1
			var fp: Array = f["fp"]
			check(int(fp[0]) >= 2 and int(fp[1]) >= 2,
				"%s/%d: пятно %dx%d" % [t, rot, int(fp[0]), int(fp[1])])
		check(n == 4, "%s: четыре поворота" % t)
	# ppu/mul кадра важнее общих: у руин ратуши 80, у остальных 96.
	var hall: Dictionary = d.frame_for("ruins", "townhall", 90)
	var house: Dictionary = d.frame_for("ruins", "house", 90)
	check(is_equal_approx(float(hall.get("ppu", 0.0)), 80.0), "руина ратуши: ppu 80")
	check(is_equal_approx(float(house.get("ppu", 0.0)), 96.0), "руина дома: ppu 96")
	check(not is_equal_approx(float(hall.get("mul", 0.0)), float(house.get("mul", 0.0))),
		"mul у типов разный")
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL RUINS TESTS PASSED")
		quit(0)
	else:
		print("RUINS TESTS FAILED")
		quit(1)
