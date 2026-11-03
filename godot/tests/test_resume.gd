extends SceneTree

## Возврат в партию после перезапуска приложения: `/api/resume` по сохранённым
## code/token/playerId. Старый клиент «падает» (queue_free без leave), новый
## клиент поднимается на том же токене, получает тот же мир, тот же кадр, того
## же игрока и снова может командовать.
##
## Это сетевой путь; локальная одиночка после выхода гасит сервер и в ту же
## комнату не возвращается (её просто нет) — здесь проверяется resume там, где
## он осмыслен: живая комната на сервере (VPS/второй игрок/падение клиента).

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var sup = null
var host = null
var guest = null
var restored = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== resume")
	LiveRoom.clear_session()
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
	# В одном процессе живут два клиента; сессию пишет только «хост».
	guest.persist_session = false
	root.add_child(guest)
	if not (await host.create_lobby(sup.base, "Хост", "вольная-заводь-346", 64, 2)):
		check(false, "лобби создано")
		_finish()
		return
	if not (await guest.join_lobby(sup.base, host.code, "Гость")):
		check(false, "гость вошёл")
		_finish()
		return
	host.set_ready(true)
	guest.set_ready(true)
	await host.lobby_status()
	await guest.lobby_status()
	check(await host.start_now(), "партия началась")
	var both := await _wait_for(func() -> bool:
		return host.world != null and guest.world != null \
			and not host.latest_snapshot.is_empty(), 30.0)
	check(both, "оба получили мир и кадр")
	if not both:
		_finish()
		return
	check(LiveRoom.session_exists(), "сессия сохранена в user://")
	var info := LiveRoom.session_info()
	check(str(info.get("code", "")) == host.code, "в сессии тот же код")
	check(str(info.get("token", "")) == host.token, "в сессии тот же токен")
	var old_owner: int = host.my_owner
	var old_room: String = host.room_id
	var old_hash: String = str(host.world.worldgen_hash)

	# Падение клиента: комнату не закрываем, сессию не стираем.
	var dying: Node = host
	host = null
	dying.queue_free()
	await create_timer(0.5).timeout

	restored = LiveRoom.new()
	root.add_child(restored)
	var ok: bool = await restored.resume(sup.base)
	check(ok, "resume принял сессию")
	await _wait_for(func() -> bool:
		return restored.world != null and not restored.latest_snapshot.is_empty(), 30.0)
	check(restored.world != null, "мир восстановлен")
	check(not restored.latest_snapshot.is_empty(), "кадр восстановлен")
	if restored.world != null:
		check(str(restored.world.worldgen_hash) == old_hash, "тот же остров")
	check(restored.my_owner == old_owner, "та же деревня: %d" % restored.my_owner)
	check(restored.room_id == old_room, "та же комната")
	check((restored.latest_snapshot.get("towns", []) as Array).size() == 2,
		"в мире всё ещё две деревни")

	# Вернувшийся игрок снова командует.
	if restored.my_owner >= 0:
		var hall := {}
		for b in restored.latest_snapshot.get("buildings", []):
			if int(b.get("owner", -1)) == restored.my_owner \
					and str(b.get("type", "")) == "townhall":
				hall = b
				break
		if not hall.is_empty():
			var r: Dictionary = await restored.send_command("edit",
				{"action": "rotate", "id": str(hall.get("id", ""))})
			check(bool(r.get("ok", false)), "команда после resume применена")

	# Явный выход стирает сессию: в мёртвую комнату больше не возвращаемся.
	restored.leave()
	await create_timer(0.3).timeout
	check(not LiveRoom.session_exists(), "выход стёр сессию")
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _finish() -> void:
	for r in [host, guest, restored]:
		if r != null:
			r.leave()
			r.queue_free()
	LiveRoom.clear_session()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL RESUME TESTS PASSED")
		quit(0)
	else:
		print("RESUME TESTS FAILED")
		quit(1)
