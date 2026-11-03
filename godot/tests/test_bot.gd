extends SceneTree

## Режим «Против деревни»: сервер поднимает вторую деревню
## (`Session.startBotCore`), клиент видит две деревни, вражеских воинов и
## получает их движение. Это проверка ПУТИ бота, а не только флага в старте:
## `bot:true` → worker → `Simulation mode:'bot'` → снимок → клиент.

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
	print("== режим против деревни")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	var up: bool = await sup.start_server()
	check(up, "сервер поднялся")
	if not up:
		_finish()
		return
	demo = Demo.new()
	root.add_child(demo)
	await process_frame
	demo.open_live(sup.base, {"seed": "вольная-заводь-346", "size": 64,
		"bot": true, "mode": "bot"})
	var ready := await _wait_for(func() -> bool:
		return demo.hud() != null and not demo.hud().snap.is_empty() \
			and demo._layer != null, 40.0)
	check(ready, "партия с ботом началась")
	if not ready:
		_finish()
		return
	var hud = demo.hud()
	var snap: Dictionary = hud.snap
	var towns: Array = snap.get("towns", [])
	check(towns.size() == 2, "две деревни: %d" % towns.size())
	check(towns.size() == 2 and bool(towns[1].get("isBot", false)), "вторая деревня — бот")
	check(demo.mode() == "bot", "клиент знает режим bot")
	check(str(hud._badge.text).find("bot") >= 0, "бейдж режима: " + str(hud._badge.text))

	var enemy_warriors: Array = []
	var enemy_buildings := 0
	for v in snap.get("villagers", []):
		if int(v.get("owner", 0)) == 1 and bool(v.get("warrior", false)):
			enemy_warriors.append(v)
	for b in snap.get("buildings", []):
		if int(b.get("owner", 0)) == 1:
			enemy_buildings += 1
	check(enemy_buildings >= 8, "построек врага: %d" % enemy_buildings)
	check(enemy_warriors.size() >= 10, "воинов врага: %d" % enemy_warriors.size())

	# Вражеские воины идут к ратуше игрока: за 10 с их положение меняется.
	var start: Dictionary = {}
	for v in enemy_warriors:
		start[str(v.get("id", ""))] = Vector2(float(v["x"]), float(v["y"]))
	await create_timer(10.0).timeout
	var moved := 0
	for v in hud.snap.get("villagers", []):
		var id := str(v.get("id", ""))
		if not start.has(id):
			continue
		var p := Vector2(float(v["x"]), float(v["y"]))
		if p.distance_to(start[id]) > 0.5:
			moved += 1
	check(moved >= 1, "воины врага двинулись: %d" % moved)
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _finish() -> void:
	if demo != null:
		demo.close()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL BOT TESTS PASSED")
		quit(0)
	else:
		print("BOT TESTS FAILED")
		quit(1)
