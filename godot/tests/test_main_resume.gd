extends SceneTree

## Автовозврат в партию после «перезапуска приложения»: сессия сохранена,
## старый main уничтожен БЕЗ выхода в меню (как падение/закрытие окна), новый
## main сам зовёт /api/resume и оказывается в том же матче с той же деревней.
##
## Сервер здесь внешний (Supervisor), как VPS: локальный после выхода
## приложения гаснет, и комнаты на нём уже нет.

const MAIN := preload("res://scenes/main.tscn")
const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var sup = null
var main1 = null
var main2 = null
var guest = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== автовозврат в партию")
	LiveRoom.clear_session()
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	var up: bool = await sup.start_server()
	check(up, "внешний сервер поднялся")
	if not up:
		_finish()
		return

	# Первый запуск: играем через экран сети, но НЕ через _on_play (он поднял
	# бы свой локальный сервер и потерял внешний адрес).
	main1 = MAIN.instantiate()
	root.add_child(main1)
	await process_frame
	await process_frame
	main1.net_lobby.open(sup.base, "вольная-заводь-346", 64)
	main1.net_lobby.visible = true
	main1.net_lobby.press("Создать игру")
	var made := await _wait_for(func() -> bool: return main1.net_lobby.joined, 15.0)
	check(made, "хост создал лобби на внешнем сервере")
	if not made:
		_finish()
		return
	var code := str(main1.net_lobby.state()["code"])
	guest = LiveRoom.new()
	# Второй клиент в том же процессе не должен перетирать сессию.
	guest.persist_session = false
	root.add_child(guest)
	await guest.join_lobby(sup.base, code, "Гость")
	guest.set_ready(true)
	main1.net_lobby.toggle_ready()
	await _wait_for(func() -> bool:
		return guest.ready_count() >= 2 and not bool(main1.net_lobby.state()["start_disabled"]), 15.0)
	main1.net_lobby.press("Начать игру")
	var first_match := await _wait_for(func() -> bool:
		return main1.state == main1.State.DEMO and main1.demo._layer != null \
			and main1.demo._layer.buildings.size() >= 6, 40.0)
	check(first_match, "первый запуск вошёл в матч")
	if not first_match:
		_finish()
		return
	var old_owner: int = main1.demo.my_owner()
	var old_room: String = main1.demo._live.room_id
	var old_hash: String = str(main1.demo._world.worldgen_hash)
	check(LiveRoom.session_exists(), "сессия лежит на диске")

	# «Падение»: уничтожаем всё приложение, не выходя в меню.
	main1.queue_free()
	main1 = null
	await create_timer(1.0).timeout
	check(LiveRoom.session_exists(), "сессия пережила падение")

	# Второй запуск: main сам возвращается в партию.
	main2 = MAIN.instantiate()
	root.add_child(main2)
	var resumed := await _wait_for(func() -> bool:
		return main2.state == main2.State.DEMO and main2.demo._layer != null \
			and main2.demo._live != null \
			and main2.demo._layer.buildings.size() >= 6, 40.0)
	check(resumed, "второй запуск сам вернулся в матч")
	if resumed:
		check(main2.demo.my_owner() == old_owner, "та же деревня: %d" % old_owner)
		check(main2.demo._live.room_id == old_room, "та же комната")
		check(str(main2.demo._world.worldgen_hash) == old_hash, "тот же остров")
		check((main2.demo.hud().snap.get("towns", []) as Array).size() == 2,
			"две деревни")
		var rev0 := int(guest.latest_snapshot.get("revision", 0))
		var alive := await _wait_for(func() -> bool:
			return int(guest.latest_snapshot.get("revision", 0)) > rev0, 8.0)
		check(alive, "гость продолжает получать кадры")

	# Явный выход в меню стирает сессию.
	main2._on_main_menu()
	await create_timer(0.8).timeout
	check(main2.state == main2.State.MENU, "выход в меню")
	check(not LiveRoom.session_exists(), "сессия стёрта после выхода")
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _finish() -> void:
	if guest != null:
		guest.leave()
		guest.queue_free()
	for m in [main1, main2]:
		if m != null:
			if m.demo != null:
				m.demo.close()
			if m.net_lobby != null:
				m.net_lobby.close_room()
			if m.server != null:
				m.server.stop()
	LiveRoom.clear_session()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL MAIN RESUME TESTS PASSED")
		quit(0)
	else:
		print("MAIN RESUME TESTS FAILED")
		quit(1)
