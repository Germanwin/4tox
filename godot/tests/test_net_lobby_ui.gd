extends SceneTree

## Экран сети ToxNetLobby: «Создать игру» → код → второй экран «Войти по коду»
## → оба «Готов» → хост «Начать игру». Оба экрана отдают комнату матчу
## (match_ready), у игроков разные деревни, остров один.
##
## Это проверка пути ИГРОКА по кнопкам экрана, а не только API комнаты
## (API проверяет tests/test_lobby.gd).

const NetLobby = preload("res://scripts/net_lobby.gd")
const Supervisor = preload("res://scripts/server_supervisor.gd")

var fails := 0
var checks := 0
var sup = null
var host = null
var guest = null
var host_started := false
var guest_started := false


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _on_host_ready(_room) -> void:
	host_started = true


func _on_guest_ready(_room) -> void:
	guest_started = true


func _init() -> void:
	_run()


func _run() -> void:
	print("== экран сети")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	var up: bool = await sup.start_server()
	check(up, "сервер поднялся")
	if not up:
		_finish()
		return
	var layer := CanvasLayer.new()
	root.add_child(layer)
	host = NetLobby.new()
	layer.add_child(host)
	host.match_ready.connect(_on_host_ready)
	guest = NetLobby.new()
	layer.add_child(guest)
	guest.match_ready.connect(_on_guest_ready)
	await process_frame

	host.open(sup.base, "вольная-заводь-346", 64)
	host.set_player_name("Хост")
	check(host.state()["status"].find("создайте") >= 0, "экран предлагает создать или войти")
	check(host.press("Создать игру"), "нажато «Создать игру»")
	var made := await _wait_for(func() -> bool: return host.joined, 15.0)
	check(made, "лобби создано")
	var code := str(host.state()["code"])
	check(code.length() >= 4, "код показан: " + code)
	check(host.state()["host"], "хост помечен")
	check(host.state()["start_visible"], "кнопка «Начать игру» у хоста")

	guest.open(sup.base, "", 64)
	guest.set_player_name("Гость")
	guest.set_code(code)
	check(guest.press("Войти по коду"), "нажато «Войти по коду»")
	var joined := await _wait_for(func() -> bool: return guest.joined, 15.0)
	check(joined, "гость вошёл по коду")
	check(not guest.state()["host"], "гость не хост")
	check(not guest.state()["start_visible"], "у гостя нет кнопки старта")

	host.press("Готов")
	guest.press("Готов")
	var both := await _wait_for(func() -> bool:
		return bool(host.state()["ready"]) and bool(guest.state()["ready"]) \
			and not bool(host.state()["start_disabled"]), 15.0)
	check(both, "оба готовы, старт у хоста доступен")
	check(host.state()["players"] == 2, "в составе двое")

	host.press("Начать игру")
	var play := await _wait_for(func() -> bool: return host_started and guest_started, 30.0)
	check(play, "оба экрана получили старт")
	if host.room != null and guest.room != null:
		var okw := await _wait_for(func() -> bool:
			return host.room.world != null and guest.room.world != null \
				and not guest.room.latest_snapshot.is_empty(), 30.0)
		check(okw, "оба получили WLD1 и кадр")
		if okw:
			check(host.room.my_owner != guest.room.my_owner,
				"разные деревни: %d и %d" % [host.room.my_owner, guest.room.my_owner])
			check(str(host.room.world.worldgen_hash) == str(guest.room.world.worldgen_hash),
				"один остров")
			check((guest.room.latest_snapshot.get("towns", []) as Array).size() == 2,
				"две деревни в кадре")
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _finish() -> void:
	if host != null:
		host.close_room()
		host.queue_free()
	if guest != null:
		guest.close_room()
		guest.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL NET LOBBY UI TESTS PASSED")
		quit(0)
	else:
		print("NET LOBBY UI TESTS FAILED")
		quit(1)
