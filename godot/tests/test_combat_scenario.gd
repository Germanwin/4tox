extends SceneTree

## Боевой сценарий до ЗАВАЛА: бот → лесорубы → казарма → трое воинов →
## приказ на вражеский лагерь лесоруба (35 hp). Проверяет, что бой не только
## ранит, но и доводит постройку до rubble в снимке.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const Demo = preload("res://scripts/hybrid_demo.gd")

var fails := 0
var checks := 0
var sup = null
var demo = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== боевой сценарий (приказ → завал врага)")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	if not (await sup.start_server()):
		check(false, "сервер поднялся")
		_finish()
		return
	demo = Demo.new()
	root.add_child(demo)
	await process_frame
	demo.open_live(sup.base, {"seed": "вольная-заводь-346", "size": 48,
		"bot": true, "mode": "bot"})
	var ready := await _wait_for(func() -> bool:
		return demo.hud() != null and not demo.hud().snap.is_empty() \
			and demo._layer != null, 40.0)
	check(ready, "партия с ботом")
	if not ready:
		_finish()
		return
	var hud = demo.hud()
	check((hud.snap.get("towns", []) as Array).size() == 2, "две деревни на 48")
	var camp := _my_building("lumbercamp")
	var hall := _my_building("townhall")
	check(not camp.is_empty() and not hall.is_empty(), "лагерь и ратуша игрока")
	if camp.is_empty() or hall.is_empty():
		_finish()
		return
	hud.select_building(camp)
	await create_timer(0.2).timeout
	hud.press("Нанять свободных")
	check(await _wait_for(func() -> bool: return _count_workers(camp) == 3, 15.0),
		"наняты три лесоруба")
	check(await _wait_for(func() -> bool: return _logs(hud) >= 28, 140.0),
		"накоплено на казарму: %d" % _logs(hud))
	if fails > 0:
		_finish()
		return
	hud.open_panel("build")
	await create_timer(0.2).timeout
	hud.begin_place("barracks", "Казарма")
	var spot := await _pick_spot("barracks", int(hall["x"]), int(hall["y"]))
	check(spot.x >= 0, "место под казарму: %s" % str(spot))
	if spot.x < 0:
		_finish()
		return
	await hud.map_click(spot)
	check(await _wait_for(func() -> bool: return not _my_building("barracks").is_empty(), 10.0),
		"казарма построена")
	hud.select_building(camp)
	await create_timer(0.2).timeout
	hud.press("Распустить всех")
	await create_timer(1.0).timeout
	hud.select_building(_my_building("barracks"))
	await create_timer(0.2).timeout
	hud.press("Тренировать свободных")
	check(await _wait_for(func() -> bool: return _count_trainees() >= 3, 20.0),
		"трое пошли учиться")
	check(await _wait_for(func() -> bool: return _count_warriors() >= 3, 60.0),
		"трое вышли воинами: %d" % _count_warriors())
	var target := _enemy_building("lumbercamp")
	check(not target.is_empty(), "вражеский лагерь найден")
	if target.is_empty():
		_finish()
		return
	var ids: Array = []
	for v in hud.snap.get("villagers", []):
		if int(v.get("owner", 0)) == demo.my_owner() and bool(v.get("warrior", false)):
			ids.append(str(v.get("id", "")))
	hud.open_panel("army")
	await create_timer(0.2).timeout
	hud.pick_group(ids)
	hud.begin_order()
	await hud.map_click(Vector2i(int(target["x"]), int(target["y"])))
	check(true, "приказ отдан %d воинам" % ids.size())
	var ruin := await _wait_for(func() -> bool:
		for b in hud.snap.get("buildings", []):
			if int(b.get("owner", 0)) == 1 and bool(b.get("rubble", false)):
				return true
		return false, 120.0)
	check(ruin, "вражеская постройка стала завалом")
	_finish()


func _my_building(type: String) -> Dictionary:
	for b in demo.hud().snap.get("buildings", []):
		if int(b.get("owner", 0)) == demo.my_owner() and str(b.get("type", "")) == type \
				and not bool(b.get("rubble", false)):
			return b
	return {}


func _enemy_building(type: String) -> Dictionary:
	for b in demo.hud().snap.get("buildings", []):
		if int(b.get("owner", 0)) == 1 and str(b.get("type", "")) == type \
				and not bool(b.get("rubble", false)):
			return b
	return {}


func _count_workers(camp: Dictionary) -> int:
	var n := 0
	for v in demo.hud().snap.get("villagers", []):
		if int(v.get("owner", 0)) == demo.my_owner() \
				and str(v.get("employerId", "")) == str(camp.get("id", "")):
			n += 1
	return n


func _count_trainees() -> int:
	var n := 0
	for v in demo.hud().snap.get("villagers", []):
		if int(v.get("owner", 0)) == demo.my_owner() and bool(v.get("trainee", false)):
			n += 1
	return n


func _count_warriors() -> int:
	var n := 0
	for v in demo.hud().snap.get("villagers", []):
		if int(v.get("owner", 0)) == demo.my_owner() and bool(v.get("warrior", false)):
			n += 1
	return n


func _logs(hud) -> int:
	var towns: Array = hud.snap.get("towns", [])
	return int(towns[0].get("logs", 0)) if towns.size() > 0 else 0


func _pick_spot(type: String, x0: int, y0: int) -> Vector2i:
	for r in [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]:
		for d in [Vector2i(r, 0), Vector2i(-r, 1), Vector2i(0, r), Vector2i(1, -r),
				Vector2i(r, r), Vector2i(-r, -r), Vector2i(r, -r), Vector2i(-r, r)]:
			var c: Vector2i = Vector2i(x0, y0) + d
			var q: Dictionary = await demo._live.check_place("build", {
				"buildingType": type, "variant": "a", "rot": 90, "x": c.x, "y": c.y})
			if bool(q.get("ok", false)):
				return c
	return Vector2i(-1, -1)


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.1).timeout
	return pred.call()


func _finish() -> void:
	if demo != null:
		demo.close()
		demo.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL COMBAT SCENARIO TESTS PASSED")
		quit(0)
	else:
		print("COMBAT SCENARIO TESTS FAILED")
		quit(1)
