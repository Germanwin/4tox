extends SceneTree

## Сетевые события комнаты: уход игрока приходит в клиент как peer-left по WS,
## мир при этом продолжается (его считает worker, а не хост). Это проверка
## JSON-событий рядом с бинарным 4TX1, а не правил игры.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var sup = null
var host = null
var guest = null
var event_kind := ""
var event_data: Dictionary = {}


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _on_event(kind: String, data: Dictionary) -> void:
	event_kind = kind
	event_data = data


func _init() -> void:
	_run()


func _run() -> void:
	print("== сетевые события")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	if not (await sup.start_server()):
		check(false, "сервер поднялся")
		_finish()
		return
	host = LiveRoom.new()
	root.add_child(host)
	guest = LiveRoom.new()
	guest.persist_session = false
	root.add_child(guest)
	guest.net_event.connect(_on_event)
	if not (await host.create_lobby(sup.base, "Хост", "вольная-заводь-346", 64, 2)):
		check(false, "лобби создано")
		_finish()
		return
	await guest.join_lobby(sup.base, host.code, "Гость")
	host.set_ready(true)
	guest.set_ready(true)
	await host.lobby_status()
	await guest.lobby_status()
	check(await host.start_now(), "партия началась")
	var ready := await _wait_for(func() -> bool:
		return guest.world != null and not guest.latest_snapshot.is_empty(), 30.0)
	check(ready, "гость в мире")
	if not ready:
		_finish()
		return

	# Хост уходит: его WS закрывается, сервер объявляет peer-left.
	host.leave()
	host.queue_free()
	host = null
	var got := await _wait_for(func() -> bool: return event_kind != "", 15.0)
	check(got, "гость получил событие: " + event_kind)
	check(event_kind == "peer-left", "это peer-left")
	check(str(event_data.get("name", "")) == "Хост", "имя ушедшего: " + str(event_data.get("name", "")))

	# Мир не встал: кадры продолжают идти гостю.
	var f0: int = guest.frames
	var alive := await _wait_for(func() -> bool: return guest.frames > f0, 8.0)
	check(alive, "кадры идут и после ухода хоста")
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _finish() -> void:
	for r in [host, guest]:
		if r != null:
			r.leave()
			r.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL NET EVENT TESTS PASSED")
		quit(0)
	else:
		print("NET EVENT TESTS FAILED")
		quit(1)
