extends SceneTree

## Кольцо военного лагеря: 5×5 минус модель 2×2 = 21 клетка, модель — те же
## 4 клетки по центру. Подсветка ничего не решает про игру, поэтому проверяется
## только геометрия кольца.

const MatchFx = preload("res://scripts/match_fx.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	print("== кольцо патруля")
	var patrol: Array = MatchFx.patrol_cells(10, 10)
	var model: Array = MatchFx.model_cells(10, 10)
	check(patrol.size() == 21, "патруль 21 клетка: %d" % patrol.size())
	check(model.size() == 4, "модель 4 клетки: %d" % model.size())
	check(Vector2i(12, 12) in model, "модель в центре пятна")
	check(not (Vector2i(12, 12) in patrol), "центр не в патруле")
	var all_inside := true
	for c in patrol:
		if c.x < 10 or c.x > 14 or c.y < 10 or c.y > 14:
			all_inside = false
	check(all_inside, "патруль внутри пятна 5×5")
	check(not (Vector2i(9, 10) in patrol), "за кромкой пятна клеток нет")
	# Сдвиг лагеря сдвигает и кольцо.
	var p2: Array = MatchFx.patrol_cells(20, 30)
	check(Vector2i(20, 30) in p2 and Vector2i(10, 10) not in p2, "кольцо следует за лагерем")
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL PATROL TESTS PASSED")
		quit(0)
	else:
		print("PATROL TESTS FAILED")
		quit(1)
