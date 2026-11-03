extends SceneTree

var fails := 0
func check(c: bool, s: String) -> void:
	print(("  ok  " if c else "  FAIL ") + s)
	if not c: fails += 1

func _key(code: int) -> void:
	var e := InputEventKey.new()
	e.physical_keycode = code
	e.pressed = true
	Input.parse_input_event(e)

func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func find_button(root: Node, text: String) -> Button:
	for n in root.find_children("*", "Button", true, false):
		if n is Button and n.text == text:
			return n
	return null

func _init() -> void:
	print("== UI smoke")
	var cfg := "user://net-session.cfg"
	if FileAccess.file_exists(cfg):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(cfg))
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	await create_timer(1.5).timeout
	check(main.menu.visible, "menu visible at start")
	check(find_button(main.menu, "Сеть") != null, "network mode button")
	main._on_play(64, "тихая-долина-701", "net")
	await create_timer(1.0).timeout
	check(main.state == main.State.LOBBY and main.net_lobby.visible,
		"network opens the HTTP lobby")
	check(main.net_lobby.press("Создать игру"), "кнопка «Создать игру» есть")
	var made := await _wait_for(func() -> bool: return main.net_lobby.joined, 12.0)
	check(made, "лобби создано по HTTP")
	if made:
		check(str(main.net_lobby.state().code).length() >= 4,
			"код лобби: " + str(main.net_lobby.state().code))
		check(main.net_lobby.state().host, "создатель — хост")
	main.net_lobby.press("Назад")
	await create_timer(0.3).timeout
	check(main.state == main.State.MENU and main.menu.visible,
		"lobby back returns to the menu")
	# Прототип (ToxSim) больше не главный путь: «Играть» — гибрид. Старые
	# экраны прототипа остаются за отладочным входом и проверяются напрямую,
	# иначе тест мерил бы не тот путь, который видит игрок.
	main._begin_game(64, "тихая-долина-701", "solo")
	await create_timer(2.5).timeout
	check(main.sim != null, "prototype game started")
	check(main.hud.visible, "HUD visible")
	check(main.view.input_enabled, "view input on")
	var camp: Dictionary = {}
	for b in main.sim.buildings:
		if ToxBuildings.type_of(b) == "lumbercamp": camp = b
	check(not camp.is_empty(), "camp found")
	main.hud.select_building(camp)
	await process_frame
	var hire_btn := find_button(main.hud.hire_list, "Нанять")
	check(hire_btn != null, "hire button built")
	if hire_btn:
		hire_btn.pressed.emit()
		check(main.sim.workers_of(camp).size() == 1, "hire button works")
	# Build menu and a house.
	main.sim.town(0).logs = 200
	main.hud.build_toggle()
	await process_frame
	var place_btn := find_button(main.hud.build_cards, "Поставить")
	check(place_btn != null, "build card button")
	if place_btn:
		place_btn.pressed.emit()
		check(main.view.mode == ToxWorldView.Mode.PLACE, "placement mode")
		var th: Dictionary = main.sim.town(0).townhall
		var site := ToxBuildings.find_site(main.sim.world, main.sim.buildings, "house", "a", 90, Vector2i(int(th.x)+1, int(th.y)+2), 24, true, main.sim.villagers)
		if not site.is_empty():
			main.view.force_hover = Vector2i(site.x + 1, site.y + 1)
			main.view.hover_cell = main.view.force_hover
			main.view._update_mode_ghost()
			var before: int = main.sim.buildings.size()
			main._commit_place(main.view.ghost_cell)
			check(main.sim.buildings.size() == before + 1, "placement commits")
	# Edit rotate/cancel.
	main.view.force_hover = Vector2i(-1, -1)
	main._begin_edit(camp, false)
	await process_frame
	var rot0: int = camp.rot
	var rotate := find_button(main.hud.edit_bar, "Повернуть")
	check(rotate != null, "edit bar built")
	if rotate:
		rotate.pressed.emit()
		check(int(camp.rot) != rot0, "rotate works")
	var cancel := find_button(main.hud.edit_bar, "Отменить")
	if cancel:
		cancel.pressed.emit()
		check(int(camp.rot) == rot0, "cancel restores rotation")
	check(not main.hud.edit_bar.visible, "edit bar closed")
	# Esc must cancel the edit and restore the building, not leave the bar.
	main._begin_edit(camp, false)
	await process_frame
	main.view.rotate_ghost()
	main._on_cancel()
	check(int(camp.rot) == rot0 and not main.hud.edit_bar.visible, "esc cancel restores edit")
	# Keyboard shortcuts reach the game layer.
	_key(KEY_O)
	await process_frame
	check(main.hud.squad_panel.visible, "O opens army")
	_key(KEY_T)
	await process_frame
	check(main.hud.village_panel.visible, "T opens village")
	_key(KEY_ESCAPE)
	await process_frame
	check(main.menu.visible and main.state == main.State.PAUSE, "Esc opens pause")
	main._on_continue()
	# Pause and resume; world clock keeps going.
	main._show_pause()
	check(main.menu.visible and not main.hud.visible, "pause menu")
	var t0: float = main.sim.time
	await create_timer(1.1).timeout
	check(main.sim.time > t0, "world keeps running in menu")
	main._on_continue()
	check(main.hud.visible and main.state == main.State.PLAY, "resume")
	# Main menu keeps the game and offers Continue.
	main._on_main_menu()
	check(main.menu.visible and main.menu._continue_btn.visible, "continue offered in main menu")
	main._on_continue()
	check(main.state == main.State.PLAY and main.hud.visible, "continue returns to game")
	# Gallery opens and closes from the pause/menu path.
	main._show_pause()
	main._on_models()
	check(main.gallery.visible, "gallery visible")
	main._on_gallery_closed()
	check(not main.gallery.visible, "gallery closed")
	# The client keeps the last frame when the host disappears.
	main.state = main.State.PLAY
	main.menu.visible = false
	main.hud.visible = true
	main.view.input_enabled = true
	main.running = true
	main.net_game = true
	main.net_is_host = false
	main.net.active = true
	main.net.connected = true
	main.net.started = true
	main._on_net_host_left()
	check(not main.running and not main.view.input_enabled, "host loss freezes the client")
	check(main.hud.end_screen.visible and main.hud.net_label.text.contains("нет связи"),
		"host loss shows the no-connection screen")
	if main.server != null:
		main.server.stop()
	print("")
	print("ALL UI TESTS PASSED" if fails == 0 else "%d UI TESTS FAILED" % fails)
	quit(1 if fails > 0 else 0)
