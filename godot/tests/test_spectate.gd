extends SceneTree

## Наблюдатель: вход в УЖЕ начатую комнату по коду, мир и кадры те же, но
## деревни нет и команды запрещены. Проверяет и LiveRoom, и HUD-бейдж.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")
const Demo = preload("res://scripts/hybrid_demo.gd")

var fails := 0
var checks := 0
var sup = null
var host = null
var spec = null
var demo = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== наблюдатель")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	if not (await sup.start_server()):
		check(false, "сервер поднялся")
		_finish()
		return
	host = LiveRoom.new()
	root.add_child(host)
	if not (await host.create_lobby(sup.base, "Хост", "тихая-долина-701", 64, 2)):
		check(false, "лобби создано")
		_finish()
		return
	host.set_ready(true)
	await host.lobby_status()
	if not (await host.start_now(true)):
		check(false, "хост начал")
		_finish()
		return
	spec = LiveRoom.new()
	root.add_child(spec)
	var ok: bool = await spec.spectate(sup.base, host.code, "Смотр")
	check(ok, "наблюдатель вошёл")
	if not ok:
		_finish()
		return
	check(spec.is_spectator, "роль наблюдателя")
	check(spec.my_owner == -1, "своей деревни нет")
	check(spec.world != null, "мир получен")
	check(await _wait_for(func() -> bool: return spec.frames > 0 and not spec.latest_snapshot.is_empty(), 15.0),
		"кадры идут")
	check((spec.latest_snapshot.get("towns", []) as Array).size() == 1,
		"видит деревню игрока")
	check(spec.players_count() == 1, "в составе только игрок")
	var cmd: Dictionary = await spec.send_command("stop", {"ids": []})
	check(not cmd.get("ok", true), "команда наблюдателя отклонена")
	check(not bool(cmd.get("ok", true)), "причина: " + str(cmd.get("reason", "")))
	var q: Dictionary = await spec.check_place("build", {"buildingType": "house", "x": 1, "y": 1})
	check(not bool(q.get("ok", true)), "стройка наблюдателю запрещена")

	demo = Demo.new()
	root.add_child(demo)
	await process_frame
	demo.open_room(spec)
	var hud_ready := await _wait_for(func() -> bool:
		return demo.hud() != null and not demo.hud().snap.is_empty(), 15.0)
	check(hud_ready, "HUD наблюдателя получил снимок")
	if hud_ready:
		check(bool(demo.hud().state()["spectator"]), "HUD в режиме наблюдателя")
		check(str(demo.hud().state()["badge"]).find("наблюдатель") >= 0, "бейдж «наблюдатель»")
		check(not (demo.hud().state()["visible_buttons"] as Array).has("Стройка"),
			"кнопка стройки скрыта")
	_finish()


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
	if spec != null:
		spec.leave()
		spec.queue_free()
	if host != null:
		host.leave()
		host.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL SPECTATE TESTS PASSED")
		quit(0)
	else:
		print("SPECTATE TESTS FAILED")
		quit(1)
