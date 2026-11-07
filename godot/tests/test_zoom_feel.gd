extends SceneTree

## Красный тест «зум как в браузере, а не рывками»:
## * щелчок колеса меняет масштаб небольшим шагом (не 1.17);
## * есть цель зума, к которой камера доезжает плавно;
## * палец на трекпаде не перескакивает через пол-карты за одно событие.

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
	print("== ощущение зума")
	var demo = HybridDemo.new()
	root.add_child(demo)
	await process_frame
	demo.zoom = 40.0
	demo.zoom_target = 40.0
	demo.cam["x"] = 100.0
	demo.cam["y"] = 100.0

	var wheel := InputEventMouseButton.new()
	wheel.button_index = MOUSE_BUTTON_WHEEL_UP
	wheel.pressed = true
	wheel.position = Vector2(720, 450)
	demo._unhandled_input(wheel)
	check(float(demo.zoom_target) <= 44.01,
		"один щелчок — маленький шаг: цель %.3f" % float(demo.zoom_target))
	check(float(demo.zoom_target) > 40.0, "щелчок всё-таки приближает")
	check(float(demo.zoom) < float(demo.zoom_target),
		"кадр не перескакивает сразу в цель: %.3f < %.3f" % [
			float(demo.zoom), float(demo.zoom_target)])

	# Через несколько кадров плавное доведение заканчивается у цели.
	for i in range(40):
		demo._process(1.0 / 60.0)
	check(absf(float(demo.zoom) - float(demo.zoom_target)) < 0.05,
		"зум доехал до цели: %.3f" % float(demo.zoom))

	var pan := InputEventPanGesture.new()
	pan.position = Vector2(720, 450)
	pan.delta = Vector2(0, -1)
	var before: float = float(demo.zoom_target)
	demo._unhandled_input(pan)
	var step: float = float(demo.zoom_target) / before
	check(step > 1.0 and step <= 1.09,
		"два пальца дают мягкий шаг %.4f" % step)

	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
