extends SceneTree

## Главный путь сети в приложении: меню → «Сеть» → HTTP-лобби → хост жмёт
## «Начать игру» → экран матча ПРИНИМАЕТ ту же комнату (open_room) и рисует
## остров. Гость — настоящий второй клиент (ToxLiveRoom), как второй Godot или
## браузер.
##
## Проверяется именно интеграция main ↔ NetLobby ↔ HybridDemo, а не API:
## API проверяют tests/test_lobby.gd и tests/test_net_lobby_ui.gd.

const MAIN := preload("res://scenes/main.tscn")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var main = null
var guest = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== сеть в приложении")
	main = MAIN.instantiate()
	root.add_child(main)
	await process_frame
	await process_frame

	main._on_play(64, "вольная-заводь-346", "net")
	var lobby_open := await _wait_for(func() -> bool:
		return main.net_lobby != null and main.net_lobby.visible \
			and main.server.base != "", 25.0)
	check(lobby_open, "«Сеть» открыла HTTP-лобби и подняла сервер")
	if not lobby_open:
		_finish()
		return

	main.net_lobby.press("Создать игру")
	var made := await _wait_for(func() -> bool: return main.net_lobby.joined, 15.0)
	check(made, "хост создал лобби")
	if not made:
		_finish()
		return
	var code := str(main.net_lobby.state()["code"])
	check(code.length() >= 4, "код для друга: " + code)

	guest = LiveRoom.new()
	root.add_child(guest)
	var joined: bool = await guest.join_lobby(main.server.base, code, "Гость")
	check(joined, "гость вошёл тем же HTTP-путём")
	guest.set_ready(true)
	main.net_lobby.toggle_ready()
	var both := await _wait_for(func() -> bool:
		return guest.ready_count() >= 2 and not bool(main.net_lobby.state()["start_disabled"]), 15.0)
	check(both, "оба готовы, старт доступен")

	main.net_lobby.press("Начать игру")
	var in_match := await _wait_for(func() -> bool:
		return main.state == main.State.DEMO and main.demo.visible \
			and main.demo._layer != null \
			and (main.demo._layer.buildings as Array).size() >= 6 \
			and not main.demo.hud().snap.is_empty(), 40.0)
	check(in_match, "хост вошёл в матч и видит остров")
	if in_match:
		check(main.demo.mode() == "multi", "режим матча — сеть")
		check(main.demo._live == main.net_lobby.room, "матч принял комнату лобби")
		check((main.demo.hud().snap.get("towns", []) as Array).size() == 2,
			"две деревни в кадре")
		check(int(main.demo.hud().snap.get("buildings", []).size()) == 6,
			"шесть построек у двух игроков")
		check(int(main.demo.hud().snap.get("villagers", []).size()) == 6,
			"шесть жителей у двух игроков")
		# Гость продолжает получать кадры, пока матч открыт.
		var rev0 := int(guest.latest_snapshot.get("revision", 0))
		var alive := await _wait_for(func() -> bool:
			return int(guest.latest_snapshot.get("revision", 0)) > rev0, 8.0)
		check(alive, "гость получает кадры матча")

	# Выход в меню закрывает комнату и сервер, зомби не остаётся.
	main._on_main_menu()
	await create_timer(0.8).timeout
	check(main.state == main.State.MENU, "вернулись в меню")
	check(main.net_lobby.room == null, "комната закрыта")
	check(not main.server.is_running(), "сервер погашен")
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
	if main != null:
		if main.demo != null:
			main.demo.close()
		if main.net_lobby != null:
			main.net_lobby.close_room()
		if main.server != null:
			main.server.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL MAIN NET TESTS PASSED")
		quit(0)
	else:
		print("MAIN NET TESTS FAILED")
		quit(1)
