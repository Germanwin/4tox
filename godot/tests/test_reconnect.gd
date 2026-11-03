extends SceneTree

## Обрыв WebSocket: клиент сам переподключается (300/600/1200…), сервер на
## новом WS присылает baseline, поток 4TX1 продолжается. Пинг для бейджа
## отвечает. Комната без транспорта живёт 30 с, поэтому 0,3 с — безопасно.

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
	print("== переподключение WS")
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
	check(ready, "партия идёт, кадры приходят")
	if not ready:
		_finish()
		return
	var room = demo._live
	var f0: int = room.frames
	check(room.transport == "ws" and room.connected, "транспорт ws, связь есть")

	# Обрыв: закрываем WS так же, как это делает сеть.
	room._ws.close()
	var back := await _wait_for(func() -> bool:
		return room.reconnects >= 1 and room.frames > f0, 12.0)
	check(back, "клиент переподключился и кадры пошли снова")
	check(room.transport == "ws" and room.connected, "после обрыва ws снова жив")
	check(room.reconnects >= 1, "переподключений: %d" % room.reconnects)

	var ms: int = await room.ping()
	check(ms >= 0, "пинг отвечает: %d мс" % ms)
	check(room.latency_ms == ms, "пинг записан в поле для бейджа")
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
		demo.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL RECONNECT TESTS PASSED")
		quit(0)
	else:
		print("RECONNECT TESTS FAILED")
		quit(1)
