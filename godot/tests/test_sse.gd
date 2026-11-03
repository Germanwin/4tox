extends SceneTree

## Запасной SSE: после обрыва WS клиент открывает /api/events, читает
## text/event-stream и применяет JSON-снимки; когда WS возвращается, SSE
## закрывается. Проверяет транспорт и кадры, не правила игры.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const Demo = preload("res://scripts/hybrid_demo.gd")

var fails := 0
var checks := 0
var sup = null
var demo = null
var events: Array = []


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== запасной SSE")
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
	demo.open_live(sup.base, {"seed": "тихая-долина-701", "size": 64})
	var ready := await _wait_for(func() -> bool:
		return demo._live != null and demo._live.frames > 0 \
			and demo.hud() != null and not demo.hud().snap.is_empty(), 30.0)
	check(ready, "партия идёт по ws")
	if not ready:
		_finish()
		return
	var room = demo._live
	room.connection.connect(func(state: String, _d: String) -> void: events.append(state))
	var f0: int = room.frames

	room._ws.close()
	await _wait_for(func() -> bool: return room._ws == null, 3.0)
	room._start_sse("тест: ws недоступен")
	var got := await _wait_for(func() -> bool:
		return room.transport == "sse" and room.frames > f0, 12.0)
	check(got, "снимки идут через SSE")
	check(room.connected, "SSE отмечен живым")
	check(events.has("sse"), "сигнал sse отдан")
	var f1: int = room.frames
	check(await _wait_for(func() -> bool: return room.frames > f1, 6.0),
		"SSE продолжает приносить снимки")

	room._open_ws()
	var ws_back := await _wait_for(func() -> bool: return room.transport == "ws", 12.0)
	check(ws_back, "WS вернулся, SSE закрыт")
	check(room.connected, "после возврата связь жива")
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
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL SSE TESTS PASSED")
		quit(0)
	else:
		print("SSE TESTS FAILED")
		quit(1)
