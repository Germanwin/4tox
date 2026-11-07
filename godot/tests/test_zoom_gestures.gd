extends SceneTree

## Регрессия: зум на трекпаде. На macOS два пальца — это InputEventPanGesture,
## а щипок — InputEventMagnifyGesture; колесо мыши до них не доходит. Игра
## слушала только MOUSE_BUTTON_WHEEL_*, поэтому «зум не работает» на маке.

const HybridDemo = preload("res://scripts/hybrid_demo.gd")

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== зум трекпадом")
	var demo = HybridDemo.new()
	root.add_child(demo)
	await process_frame
	demo.zoom = 40.0
	var wheel := InputEventMouseButton.new()
	wheel.button_index = MOUSE_BUTTON_WHEEL_UP
	wheel.pressed = true
	wheel.position = Vector2(720, 450)
	demo._unhandled_input(wheel)
	check(demo.zoom > 40.0, "колесо приближает: %.1f" % demo.zoom)
	var after_wheel: float = float(demo.zoom)

	var pan := InputEventPanGesture.new()
	pan.position = Vector2(720, 450)
	pan.delta = Vector2(0, -1)
	demo._unhandled_input(pan)
	check(demo.zoom > after_wheel, "два пальца вверх приближают: %.1f" % demo.zoom)
	var after_pan: float = float(demo.zoom)

	var magnify := InputEventMagnifyGesture.new()
	magnify.position = Vector2(720, 450)
	magnify.factor = 1.3
	demo._unhandled_input(magnify)
	check(demo.zoom > after_pan, "щипок приближает: %.1f" % demo.zoom)
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
