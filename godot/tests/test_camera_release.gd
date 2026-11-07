extends SceneTree

## Красный тест правила «отпустил ЛКМ — камера больше не едет».
## В браузере панорама заканчивается вместе с кнопкой; здесь `_panning`
## оставался включённым, и карта продолжала ползти за курсором.

const HybridDemo = preload("res://scripts/hybrid_demo.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _mouse(pos: Vector2, pressed: bool) -> InputEventMouseButton:
	var e := InputEventMouseButton.new()
	e.button_index = MOUSE_BUTTON_LEFT
	e.pressed = pressed
	e.position = pos
	return e


func _motion(pos: Vector2, rel: Vector2) -> InputEventMouseMotion:
	var e := InputEventMouseMotion.new()
	e.position = pos
	e.relative = rel
	return e


func _init() -> void:
	_run()


func _run() -> void:
	print("== отпускание ЛКМ")
	var demo = HybridDemo.new()
	root.add_child(demo)
	await process_frame
	demo.cam["x"] = 100.0
	demo.cam["y"] = 100.0

	demo._unhandled_input(_mouse(Vector2(400, 300), true))
	demo._unhandled_input(_motion(Vector2(460, 340), Vector2(60, 40)))
	check(demo._panning, "после сдвига началась панорама")
	var x0: float = float(demo.cam["x"])
	demo._unhandled_input(_mouse(Vector2(460, 340), false))
	check(not demo._panning, "отпускание ЛКМ выключает панораму")
	x0 = float(demo.cam["x"])
	var y0: float = float(demo.cam["y"])
	demo._unhandled_input(_motion(Vector2(700, 500), Vector2(240, 160)))
	check(is_equal_approx(float(demo.cam["x"]), x0)
		and is_equal_approx(float(demo.cam["y"]), y0),
		"после отпускания движение мыши не двигает камеру")
	check(not demo._pressed, "кнопка больше не нажата")

	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
