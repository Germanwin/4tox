extends SceneTree

## Регрессия: зум не должен стоить кадров.
##
## Жалоба заказчика 2026-11-06: «игра очень лагает, когда я приближаю и
## отдаляю камеру». Причина — кайма построек и жителей пеклась заново на
## каждую новую толщину в пикселях спрайта, а толщина зависит от зума: за
## один плавный зум WorldLayer пересобирал десятки холстов GDScript-циклом по
## пикселям (замер: 120 к/с в покое против 27 к/с на зуме, отдельные кадры
## 0,5 с).
##
## Проверка: та же сцена, что в игре (гибридная оболочка на фикстуре), плюс
## толпа жителей. Сначала стоянка, потом непрерывный зум. Требования:
##   * средний кадр на зуме — не больше чем в 1,6 раза плюс 2 мс от стоянки;
##   * ни один кадр на зуме не длиннее 120 мс (раньше были кадры по 0,5 с);
##   * FPS на зуме не ниже 45 — иначе «плавный зум» не виден глазом.
##
## Запуск (окном — headless не рисует, мерить нечего):
##   /Applications/Godot.app/Contents/MacOS/Godot --path godot -s res://tests/test_zoom_fps.gd
## Код возврата 1 при FAIL.

const HybridDemo = preload("res://scripts/hybrid_demo.gd")
var villagers := 120
const ZOOM_MIN := 6.0
const ZOOM_MAX := 110.0

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1

func _init() -> void:
	_run()

func _sample(seconds: float, zooming: bool) -> Dictionary:
	var frames := 0
	var total := 0.0
	var worst := 0.0
	var over := 0
	var last := Time.get_ticks_usec()
	var end := last + int(seconds * 1000000.0)
	var demo = _demo
	var dir := 1.0
	while Time.get_ticks_usec() < end:
		if zooming:
			# Один щелчок колеса за кадр — непрерывный жест.
			var target: float = demo.zoom_target * (1.03 if dir > 0.0 else 1.0 / 1.03)
			if target >= ZOOM_MAX:
				dir = -1.0
				target = ZOOM_MAX
			elif target <= ZOOM_MIN:
				dir = 1.0
				target = ZOOM_MIN
			demo.zoom_target = target
		await process_frame
		var now := Time.get_ticks_usec()
		var dt := float(now - last) / 1000.0
		last = now
		frames += 1
		total += dt
		worst = maxf(worst, dt)
		if dt > 25.0:
			over += 1
	return {"frames": frames, "avg": total / float(maxi(1, frames)),
		"fps": 1000.0 * float(frames) / maxf(0.001, total),
		"worst": worst, "over25": over}

var _demo = null

func _run() -> void:
	var env := OS.get_environment("TOX_TEST_VILLAGERS")
	if env != "":
		villagers = int(env)
	root.size = Vector2i(1440, 900)
	Engine.max_fps = 0
	_demo = HybridDemo.new()
	root.add_child(_demo)
	await process_frame
	await process_frame
	await _demo.open()
	await create_timer(1.0).timeout

	# Толпа: на живом сервере к середине партии их сотни, и кайма у каждого.
	var fake: Array = []
	var base: Dictionary = _demo.cam
	for i in range(villagers):
		var a := float(i) * 2.399963
		var r := 2.0 + 9.0 * sqrt(float(i) / float(villagers))
		fake.append({
			"id": "v%d" % i,
			"x": float(base["x"]) + cos(a) * r,
			"y": float(base["y"]) + sin(a) * r,
			"owner": 0, "rot": i % 8, "phase": float(i % 16) / 16.0,
			"anim": "walk" if i % 4 == 0 else "idle",
			"warrior": i % 17 == 0, "hidden": false
		})
	_demo._layer.villagers = fake
	_demo._layer.queue_redraw()

	_demo.zoom = 40.0
	_demo.zoom_target = 40.0
	await create_timer(0.8).timeout

	var still := await _sample(1.5, false)
	var zoom := await _sample(2.5, true)
	var again := await _sample(1.5, false)

	print("стоянка: кадров %d, %.1f к/с, средний %.2f мс, худший %.1f" % [
		still["frames"], still["fps"], still["avg"], still["worst"]])
	print("зум:     кадров %d, %.1f к/с, средний %.2f мс, худший %.1f, >25мс %d" % [
		zoom["frames"], zoom["fps"], zoom["avg"], zoom["worst"], zoom["over25"]])
	print("стоянка: кадров %d, %.1f к/с, средний %.2f мс, худший %.1f" % [
		again["frames"], again["fps"], again["avg"], again["worst"]])

	var limit: float = float(still["avg"]) * 1.6 + 2.0
	check(zoom["avg"] <= limit,
		"средний кадр на зуме %.2f мс не больше %.2f мс (стоянка %.2f)" % [
			zoom["avg"], limit, still["avg"]])
	check(zoom["worst"] <= 120.0,
		"худший кадр на зуме %.1f мс не длиннее 120 мс" % zoom["worst"])
	check(zoom["fps"] >= 45.0, "на зуме %.1f к/с, не ниже 45" % zoom["fps"])

	# Кадр для глаз: кайма жителей и построек после правки.
	_demo.zoom = 76.0
	_demo.zoom_target = 76.0
	await create_timer(0.5).timeout
	await RenderingServer.frame_post_draw
	root.get_texture().get_image().save_png("res://tests/fixtures/out_zoom_fps.png")
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
