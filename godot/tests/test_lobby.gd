extends SceneTree

## Сетевое лобби БЕЗ ENet: два клиента Godot в одном процессе создают и входят
## в комнату по коду, жмут «Готов», хост начинает, оба получают WLD1 и кадры
## 4TX1. Команда гостя применяется сервером и видна хосту.
##
## Это тот же HTTP/WS путь, которым ходит браузер: кроссплей проверяется
## отдельно (test_crossplay.gd), здесь — новый экран сети и guest-путь.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var sup = null
var host = null
var guest = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== сетевое лобби")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	var up: bool = await sup.start_server()
	check(up, "сервер поднялся")
	if not up:
		_finish()
		return
	host = LiveRoom.new()
	root.add_child(host)
	guest = LiveRoom.new()
	root.add_child(guest)

	var created: bool = await host.create_lobby(sup.base, "Хост", "вольная-заводь-346", 64, 2)
	check(created, "хост создал лобби")
	check(host.code.length() >= 4, "код лобби: " + host.code)
	check(host.is_host, "создатель — хост")

	var joined: bool = await guest.join_lobby(sup.base, host.code, "Гость")
	check(joined, "гость вошёл по коду")
	check(not guest.is_host, "вошедший — не хост")
	await host.lobby_status()
	check(host.players_count() >= 2, "в лобби двое")

	host.set_ready(true)
	guest.set_ready(true)
	await host.lobby_status()
	await guest.lobby_status()
	check(host.ready_count() == 2, "оба готовы")

	var started: bool = await host.start_now()
	check(started, "хост начал партию")

	var ok_host := await _wait_for(func() -> bool:
		return host.world != null and not host.latest_snapshot.is_empty(), 30.0)
	var ok_guest := await _wait_for(func() -> bool:
		return guest.world != null and not guest.latest_snapshot.is_empty(), 30.0)
	check(ok_host, "хост получил мир и кадр")
	check(ok_guest, "гость получил мир и кадр")
	if not (ok_host and ok_guest):
		_finish()
		return

	check(host.my_owner != guest.my_owner, "у игроков разные деревни: %d и %d" % [
		host.my_owner, guest.my_owner])
	check(str(host.world.worldgen_hash) == str(guest.world.worldgen_hash),
		"один остров: " + str(host.world.worldgen_hash))
	check(int(host.latest_snapshot.get("size", 0)) == 64, "остров 64")
	var towns: Array = host.latest_snapshot.get("towns", [])
	check(towns.size() == 2, "две деревни: %d" % towns.size())
	check((host.latest_snapshot.get("buildings", []) as Array).size() == 6,
		"шесть построек")
	check((host.latest_snapshot.get("villagers", []) as Array).size() == 6,
		"шесть жителей")

	# Команда Гостя: повернуть свою ратушу. Хост должен увидеть новый поворот.
	var hall := {}
	for b in guest.latest_snapshot.get("buildings", []):
		if int(b.get("owner", -1)) == guest.my_owner and str(b.get("type", "")) == "townhall":
			hall = b
			break
	check(not hall.is_empty(), "ратуша гостя найдена")
	if not hall.is_empty():
		var rot0 := int(hall.get("rot", 0))
		var r: Dictionary = await guest.send_command("edit",
			{"action": "rotate", "id": str(hall.get("id", ""))})
		check(bool(r.get("ok", false)), "команда гостя применена: " + str(r.get("reason", "")))
		var seen := await _wait_for(func() -> bool:
			for b in host.latest_snapshot.get("buildings", []):
				if str(b.get("id", "")) == str(hall.get("id", "")):
					return int(b.get("rot", 0)) != rot0
			return false, 10.0)
		check(seen, "хост увидел поворот гостя")

	host.leave()
	await create_timer(0.5).timeout
	guest.leave()
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
		host.leave()
		host.queue_free()
	if guest != null:
		guest.leave()
		guest.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL LOBBY TESTS PASSED")
		quit(0)
	else:
		print("LOBBY TESTS FAILED")
		quit(1)
