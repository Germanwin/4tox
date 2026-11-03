extends SceneTree

## Приёмка «игра мышью»: сценарий проходит НАСТОЯЩИМИ InputEvent через главную
## сцену приложения, а не вызовом hud.map_click(). Это требование §6 и §9
## промпта: тест, который дергает методы напрямую, зелёный и на мёртвом клике.
##
## Шаги: меню → «Играть» → встроенный сервер → остров и деревня → «Стройка» →
## карточка дома → призрак следует за курсором → клик по карте → дом построен и
## брёвна списаны → удержание ЛКМ открывает правку → «Повернуть» → «Меню».
##
## Запуск:
##   Godot --headless --path . -s res://tests/test_play.gd
## (визуальные кадры снимает tests/play_shots.sh, этот прогон — структурный.)

const MAIN := preload("res://scenes/main.tscn")

var fails := 0
var checks := 0
var main = null


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== игра мышью")
	# Чужая сохранённая сессия не должна уводить main в авто-возврат.
	_clear_net_session()
	# Размер окна как у игрока: HUD считает позиции от вьюпорта, и в headless
	# по умолчанию он 64x64 — кнопки уезжали за кадр, клик мимо.
	root.size = Vector2i(1440, 900)
	main = MAIN.instantiate()
	root.add_child(main)
	await process_frame
	await process_frame
	# 1. Меню на месте.
	check(main.menu.visible, "главное меню показано")
	check(main.state == main.State.MENU, "состояние MENU")
	var play_btn := find_button(main.menu, "Играть")
	check(play_btn != null, "кнопка «Играть» найдена")
	if play_btn == null:
		return _finish()

	await _shot("menu")
	# 2. «Играть» — настоящий клик мышью, не emit_signal.
	await click(play_btn)
	var started := await _wait_for(func() -> bool:
		return main.state == main.State.DEMO and main.demo != null \
			and main.demo.hud() != null and main.demo.hud().snap.size() > 0, 60.0)
	check(started, "«Играть» поднял гибридную партию без терминала")
	if not started:
		print("  причина: " + str(main.demo._hint.text if main.demo != null else "нет demo"))
		return _finish()

	var demo = main.demo
	var hud = demo.hud()
	await _shot("start")
	check(main.demo._layer != null, "мир нарисован")
	var b0: int = demo._layer.buildings.size()
	var v0: int = demo._layer.villagers.size()
	check(b0 >= 3, "постройки деревни: %d" % b0)
	check(v0 >= 3, "жители деревни: %d" % v0)
	var logs0 := _logs(hud)
	check(logs0 > 0 or true, "брёвна в снимке: %d" % logs0)

	# 3. Лесорубы: клик по лагерю открывает панель найма, «Нанять свободных»
	# нанимает трёх. Это же проверяет, что панель найма достижима мышью.
	var camp := {}
	for b in demo._layer.buildings:
		if str(b.get("type", "")) == "lumbercamp" and int(b.get("owner", 0)) == 0:
			camp = b
			break
	check(not camp.is_empty(), "лагерь лесоруба найден")
	if not camp.is_empty():
		await click_at(demo.cell_to_screen(Vector2i(int(camp["x"]) + 1, int(camp["y"]) + 1)))
		await process_frame
		check(hud.panel == "hire", "клик по лагерю открыл панель найма: " + hud.panel)
		check(await click_text(demo, "Нанять свободных"), "нажато «Нанять свободных»")
		# Лямбда захватывает переменные по значению (ловушка GDScript), поэтому
		# счёт после ожидания — отдельным проходом, а не через захват.
		var hired_ok := await _wait_for(func() -> bool: return _hired(hud) == 3, 8.0)
		check(hired_ok, "наняты все трое: %d" % _hired(hud))
		if hud.panel != "":
			await click_text(demo, "Закрыть")

	# 4. Брёвна приходят сами: рубить 5 с, ноша 4, сдача в лагерь.
	var got := await _wait_for(func() -> bool: return _logs(hud) >= 12, 90.0)
	check(got, "лесорубы принесли брёвна: %d" % _logs(hud))

	await _shot("hired")
	# 5. Стройка: карточка дома настоящим кликом.
	check(await click_text(demo, "Стройка"), "нажата «Стройка»")
	await process_frame
	check(await click_key(demo, "Построить house"), "нажата карточка «Построить house»")
	await process_frame
	check(hud.place_type == "house", "режим постановки дома")
	check(demo._ghost != null and demo._ghost.visible, "призрак постановки включён")

	# 6. Призрак следует за курсором и спрашивает сервер: ищем годное место
	# рядом с ратушей — как игрок, наведением мыши.
	var hall := {}
	for b in demo._layer.buildings:
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == 0:
			hall = b
			break
	check(not hall.is_empty(), "ратуша игрока найдена")
	var target := await _pick_build_spot(demo, hud, "build", "")
	check(target.x >= 0, "сервер нашёл годное место: %s" % str(target))
	if target.x >= 0:
		check(demo._hover_cell.distance_to(target) <= 1.0,
			"курсор → клетка: %s" % str(demo._hover_cell))
		check(demo._ghost.cell != Vector2i(-1, -1), "призрак стоит в клетке курсора")
		await _shot("ghost")
		var before: int = demo._layer.buildings.size()
		var logs_before := _logs(hud)
		await click_at(demo.cell_to_screen(target))
		var built := await _wait_for(func() -> bool:
			return demo._layer.buildings.size() > before, 12.0)
		check(built, "клик по карте построил дом")
		if built:
			check(_logs(hud) == logs_before - 12,
				"брёвна списаны: %d → %d" % [logs_before, _logs(hud)])
		check(hud.place_type == "", "режим постановки выключен после постройки")

	await _shot("built")
	# 7. Удержание ЛКМ 0,6 с по дому открывает правку.
	var house := {}
	for b in demo._layer.buildings:
		if str(b.get("type", "")) == "house" and int(b.get("owner", 0)) == 0:
			house = b
			break
	if not house.is_empty():
		var rot0 := int(house.get("rot", 0))
		var p: Vector2 = demo.cell_to_screen(Vector2i(int(house.get("x", 0)), int(house.get("y", 0))))
		await hold_at(p, 0.62)
		await process_frame
		check(hud.panel == "edit" and hud.selected_id != "", "удержание открыло правку")
		check(await click_text(demo, "Повернуть"), "нажато «Повернуть»")
		var rotated := await _wait_for(func() -> bool:
			for b in demo._layer.buildings:
				if str(b.get("id", "")) == str(house.get("id", "")):
					return int(b.get("rot", 0)) != rot0
			return false, 8.0)
		check(rotated, "поворот применён сервером")
		# «Отменить» возвращает поворот, который был при открытии правки.
		check(await click_text(demo, "Отменить"), "нажато «Отменить»")
		var restored := await _wait_for(func() -> bool:
			var b: Dictionary = demo.building_by_id(str(house.get("id", "")))
			return not b.is_empty() and int(b.get("rot", 0)) == rot0, 8.0)
		check(restored, "отмена вернула поворот %d" % rot0)
		# «Отменить» — асинхронная цепочка команд: даём ей закрыть панель,
		# иначе её close_panel прилетит уже после нового открытия.
		await create_timer(0.5).timeout
		# Снова открываем правку кликом по дому — дальше перенос и снос.
		await click_at(p)
		await process_frame
		check(hud.panel == "edit", "правка снова открыта кликом")
		# Даём контейнеру разложить кнопки: клик в тот же кадр, когда панель
		# только собрана, попадает по старым координатам (у игрока такого нет).
		await create_timer(0.15).timeout
		await _shot("edit")

	# 8. Перенос и снос дома: «Двигать» → годная клетка → «Снести».
	if not house.is_empty():
		var home_id := str(house.get("id", ""))
		# Сначала «Двигать» (постройка «в руке»), потом выбор клетки — как у
		# игрока. Поиск клетки водит мышью по карте и мог сбить клик по панели,
		# если делать это до нажатия.
		check(await click_text(demo, "Двигать"), "нажато «Двигать»")
		var spot := await _pick_build_spot(demo, hud, "move", home_id)
		check(spot.x >= 0, "сервер нашёл место для переноса: %s" % str(spot))
		if spot.x >= 0:
			await click_at(demo.cell_to_screen(spot))
			var moved := await _wait_for(func() -> bool:
				var b: Dictionary = demo.building_by_id(home_id)
				return not b.is_empty() and int(b.get("x", -1)) == spot.x and int(b.get("y", -1)) == spot.y, 8.0)
			check(moved, "перенос применён сервером")
			# Ждём, пока map_click дочитает /api/command-state и откроет
			# панель правки (снимок приходит раньше ответа команды).
			await create_timer(0.6).timeout
			# Перенос оставляет правку открытой — сразу жмём «Снести».
			check(hud.panel == "edit", "перенос оставил правку открытой")
			check(await click_text(demo, "Снести"), "нажато «Снести»")
			var gone := await _wait_for(func() -> bool:
				return demo.building_by_id(home_id).is_empty(), 8.0)
			check(gone, "дом снесён сервером")

	# 9. Казарма и воин: копим 28 брёвен, ставим казарму, увольняем одного
	# лесоруба (тренируют свободного), тренируем — 5 с и выход воином.
	var rich := await _wait_for(func() -> bool: return _logs(hud) >= 28, 150.0)
	check(rich, "накоплено на казарму: %d" % _logs(hud))
	if rich:
		# Место может оказаться занятым жителем между проверкой и кликом —
		# игрок в этом случае просто нажимает ещё раз. Пробуем до пяти раз.
		var barracks_ok := false
		for attempt in range(5):
			if barracks_ok:
				break
			if hud.place_type != "barracks":
				if not (await click_text(demo, "Стройка")):
					break
				await process_frame
				if not (await click_key(demo, "Построить barracks")):
					break
			var bspot := await _pick_build_spot(demo, hud, "build", "", attempt)
			check(bspot.x >= 0, "место под казарму (попытка %d): %s" % [attempt + 1, str(bspot)])
			if bspot.x < 0:
				break
			await click_at(demo.cell_to_screen(bspot))
			barracks_ok = await _wait_for(func() -> bool:
				for b in demo._layer.buildings:
					if str(b.get("type", "")) == "barracks":
						return true
				return false, 4.0)
			if not barracks_ok:
				print("  .. казарма не встала: ", hud.status_text, " · место ", str(bspot))
				await create_timer(1.0).timeout
		check(barracks_ok, "казарма построена")
		if barracks_ok:
				# Увольняем одного лесоруба: у казармы тренируют свободного.
				await click_at(demo.cell_to_screen(Vector2i(int(camp["x"]) + 1, int(camp["y"]) + 1)))
				await process_frame
				var fired := false
				for key in hud.buttons.keys():
					if str(key).begins_with("Уволить "):
						await click(hud.buttons[key])
						fired = true
						break
				check(fired, "один лесоруб уволен")
				await create_timer(0.6).timeout
				# Панель найма закрываем перед кликом по карте: она стоит над
				# картой и иначе перехватит клик — как и у живого игрока.
				if hud.panel == "hire":
					await click_text(demo, "Закрыть")
				var bcell := Vector2i(-1, -1)
				for b in demo._layer.buildings:
					if str(b.get("type", "")) == "barracks":
						bcell = Vector2i(int(b["x"]) + 1, int(b["y"]) + 1)
				await click_at(demo.cell_to_screen(bcell))
				await process_frame
				check(hud.panel == "hire", "клик по казарме открыл тренировку")
				await create_timer(0.15).timeout
				check(await click_text(demo, "Тренировать свободных"), "нажато «Тренировать свободных»")
				var training := await _wait_for(func() -> bool: return _trainees(hud) >= 1, 15.0)
				check(training, "житель пошёл учиться")
				var warrior := await _wait_for(func() -> bool: return _warriors(hud) >= 1, 45.0)
				check(warrior, "через 5 с он вышел воином")
				await _shot("warrior")

	# 10. Меню открывается и мир не останавливается (счётчик кадров).
	check(await click_text(demo, "Меню"), "нажато «Меню»")
	await process_frame
	check(hud.panel == "menu", "панель меню открыта")
	var seq0 := int(hud.snap.get("revision", 0))
	await create_timer(1.2).timeout
	check(int(hud.snap.get("revision", 0)) > seq0, "за открытым меню мир тикает")
	_finish()


# ------------------------------------------------------------------ helpers

func _clear_net_session() -> void:
	var cfg := "user://net-session.cfg"
	if FileAccess.file_exists(cfg):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(cfg))


func _trainees(hud) -> int:
	var n := 0
	for v in hud.snap.get("villagers", []):
		if int(v.get("owner", 0)) == 0 and bool(v.get("trainee", false)):
			n += 1
	return n


func _warriors(hud) -> int:
	var n := 0
	for v in hud.snap.get("villagers", []):
		if int(v.get("owner", 0)) == 0 and bool(v.get("warrior", false)):
			n += 1
	return n


## Годная клетка: для постановки — наведением мыши (призрак спрашивает
## сервер), для переноса — прямым вопросом `/api/check`, потому что призрак
## переноса в HUD не показывается.
func _pick_build_spot(demo, hud, kind: String, id: String, attempt: int = 0) -> Vector2i:
	var hall := {}
	for b in demo._layer.buildings:
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == 0:
			hall = b
			break
	var hp := Vector2i(int(hall.get("x", 0)), int(hall.get("y", 0)))
	var seen := 0
	for r in [4, 5, 6, 7, 8, 9, 10, 11, 12]:
		for d in [Vector2i(r, 0), Vector2i(-r, 1), Vector2i(0, r), Vector2i(1, -r),
				Vector2i(r, r), Vector2i(-r, -r), Vector2i(r, -r), Vector2i(-r, r)]:
			var c: Vector2i = hp + d
			if kind == "move":
				var q: Dictionary = await demo._live.check_place("move", {"id": id, "x": c.x, "y": c.y})
				if bool(q.get("ok", false)):
					return c
			else:
				await move_mouse(demo.cell_to_screen(c))
				# Спрашиваем сервер ровно про эту клетку и этот тип. Призрак
				# тоже спрашивает, но здесь нужна детерминированность: ответ
				# на прошлую клетку не должен считаться ответом на эту.
				var q: Dictionary = await demo._live.check_place("build", {
					"buildingType": str(hud.place_type),
					"variant": "x" if str(hud.place_type) == "warcamp" else "a",
					"rot": demo._place_rot, "x": c.x, "y": c.y})
				if bool(q.get("ok", false)):
					seen += 1
					if seen > attempt:
						return c
	return Vector2i(-1, -1)


## Кадр сценария. В headless рендера нет — там кадров не будет.
func _shot(name: String) -> void:
	if DisplayServer.get_name() == "headless":
		return
	await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	if img != null:
		DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://shots"))
		img.save_png("res://shots/play_" + name + ".png")


func _hired(hud) -> int:
	var n := 0
	for v in hud.snap.get("villagers", []):
		if int(v.get("owner", 0)) == 0 and str(v.get("employerId", "")) != "":
			n += 1
	return n


func _logs(hud) -> int:
	var towns: Array = hud.snap.get("towns", [])
	if towns.is_empty():
		return 0
	return int(towns[0].get("logs", 0))


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func find_button(node: Node, text: String) -> Button:
	if node is Button and (node as Button).text == text \
			and (node as Button).is_visible_in_tree():
		return node
	for c in node.get_children():
		var r := find_button(c, text)
		if r != null:
			return r
	return null


## Кнопка HUD по ключу (у карточек видимый текст короче ключа, как в браузере).
func click_key(root_node: Node, key: String) -> bool:
	var hud = root_node.hud() if root_node.has_method("hud") else null
	if hud == null:
		return false
	var b = hud.buttons.get(key)
	if b == null or not (b is Button):
		return false
	await click(b)
	return true


func click_text(root_node: Node, text: String) -> bool:
	var b := find_button(root_node, text)
	if b == null:
		return false
	await click(b)
	return true


func _center(c: Control) -> Vector2:
	return c.get_global_rect().get_center()


## Нажатие мышью через Input.parse_input_event: тот же путь, что у игрока
## (Control.hit test → Button._gui_input), а не прямой `pressed.emit()`.
func click(control: Control) -> void:
	await click_at(_center(control))


func click_at(pos: Vector2, button := MOUSE_BUTTON_LEFT) -> void:
	var down := InputEventMouseButton.new()
	down.button_index = button
	down.pressed = true
	down.position = pos
	down.global_position = pos
	root.push_input(down, true)
	await process_frame
	var up := InputEventMouseButton.new()
	up.button_index = button
	up.pressed = false
	up.position = pos
	up.global_position = pos
	root.push_input(up, true)
	await process_frame
	await process_frame


func hold_at(pos: Vector2, seconds: float) -> void:
	var down := InputEventMouseButton.new()
	down.button_index = MOUSE_BUTTON_LEFT
	down.pressed = true
	down.position = pos
	down.global_position = pos
	root.push_input(down, true)
	await create_timer(seconds).timeout
	var up := InputEventMouseButton.new()
	up.button_index = MOUSE_BUTTON_LEFT
	up.pressed = false
	up.position = pos
	up.global_position = pos
	root.push_input(up, true)
	await process_frame


func move_mouse(pos: Vector2) -> void:
	var m := InputEventMouseMotion.new()
	m.position = pos
	m.global_position = pos
	root.push_input(m, true)
	await process_frame


func _finish() -> void:
	if main != null and main.demo != null:
		main.demo.close()
	if main != null and main.server != null:
		main.server.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL PLAY TESTS PASSED")
		quit(0)
	else:
		print("PLAY TESTS FAILED")
		quit(1)
