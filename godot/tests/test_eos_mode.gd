extends SceneTree

## Экран отдельного режима EOS: пункт в меню, свой экран, честный отказ без
## ключей Epic и рабочая комната на петле. Основной путь «Сеть» не трогается.
##
## Запуск: godot --headless --path . -s res://tests/test_eos_mode.gd
## Порог: 0 FAIL.

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func find_button(root: Node, text: String) -> Button:
	for n in root.find_children("*", "Button", true, false):
		if n is Button and n.text == text:
			return n
	return null


func _init() -> void:
	_run()


func _run() -> void:
	print("== eos mode")
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	create_timer(120.0).timeout.connect(func() -> void:
		print("  FAIL общий таймаут 120 с")
		fails += 1
		quit(1))
	await create_timer(1.2).timeout
	check(find_button(main.menu, "EOS") != null, "пункт «EOS» есть в меню")
	check(find_button(main.menu, "Сеть") != null, "пункт «Сеть» остался")

	main._on_play(64, "тихая-долина-701", "eos")
	await create_timer(0.8).timeout
	check(main.state == main.State.LOBBY and main.eos_lobby.visible,
		"«EOS» открывает свой экран")
	check(not main.net_lobby.visible, "экран «Сеть» не открывался")

	var has_keys := FileAccess.file_exists("user://eos.cfg")
	var has_addon := ClassDB.class_exists("EOSGMultiplayerPeer")
	check(main.eos_lobby._transport.is_item_disabled(0) == (not has_addon),
		"EOS доступен при наличии аддона")
	check(main.eos_lobby._transport.get_selected_id() == (0 if has_addon else 1),
		"транспорт выбран по наличию аддона")
	check(main.eos_lobby._copy_btn != null and not main.eos_lobby._copy_btn.visible,
		"без комнаты кнопки «Копировать» нет")

	var p2p_script = load("res://scripts/eos/p2p_link.gd")
	check(p2p_script != null and p2p_script.can_instantiate(), "EOS-транспорт загружается")
	if p2p_script != null and p2p_script.can_instantiate() and not has_keys:
		var p2p = p2p_script.new()
		var said := [""]
		p2p.failed.connect(func(t: String) -> void: said[0] = t)
		check(p2p.available(), "аддон доступен без локального файла")
		var started: bool = await p2p.start_host()
		check(not started and str(said[0]).find("конфигурация") >= 0,
			"отказ словами, а не падение: " + str(said[0]))
		p2p.stop()

	main.eos_lobby._transport.select(1)
	await main.eos_lobby.host_game()
	var t0 := Time.get_ticks_msec()
	while not main.eos_lobby.joined and Time.get_ticks_msec() - t0 < 25000:
		await create_timer(0.1).timeout
	check(main.eos_lobby.joined, "петля: комната хозяина создана")
	check(main.eos_lobby.is_host, "создатель — хозяин")
	check(str(main.eos_lobby.state().invite).length() > 0,
		"код комнаты для друга: " + str(main.eos_lobby.state().invite))
	var code := str(main.eos_lobby.state().invite)
	var field = main.eos_lobby._invite
	check(field is LineEdit and not (field as LineEdit).editable,
		"код комнаты — selectable-поле, а не надпись")
	check(field is LineEdit and (field as LineEdit).text == code,
		"в поле лежит код целиком, без префикса и обрезки")
	var copy_btn = main.eos_lobby._copy_btn
	check(copy_btn != null and copy_btn.visible, "кнопка «Копировать» рядом с кодом")
	if copy_btn != null:
		copy_btn.pressed.emit()
	check(main.eos_lobby.last_copied == code,
		"в буфер ушёл весь код: " + str(main.eos_lobby.last_copied))
	if DisplayServer.has_feature(DisplayServer.FEATURE_CLIPBOARD):
		check(DisplayServer.clipboard_get() == code, "буфер обмена отдаёт тот же код")
	if copy_btn != null:
		copy_btn.pressed.emit()
	check(main.eos_lobby.last_copied == code, "повторное нажатие кладёт то же самое")

	# Настоящий EOS-код — длинная строка: 32 символа Product User ID, точка,
	# имя сокета. Копирование обязано положить её целиком, а не обрезать.
	var long_code := "0002950be3bf49db9bdc9fcb837ec8f0.t4x11335799542"
	main.eos_lobby._set_invite(long_code)
	check(main.eos_lobby.copy_invite() == long_code \
		and main.eos_lobby.last_copied == long_code,
		"длинный код (%d символов) уходит целиком" % long_code.length())
	check(str(main.eos_lobby._invite.text) == long_code, "поле показывает весь длинный код")

	var probe = p2p_script.new()
	check(probe.has_method("split_code"), "p2p_link умеет разбирать код комнаты")
	if probe.has_method("split_code"):
		check(probe.split_code(" \n0002abcd.\tt4x1133 ") == {"user": "0002abcd", "key": "t4x1133"},
			"код, вставленный с пробелами и переносами, разбирается")
		check(probe.split_code("без-точки").is_empty(), "код без точки отвергается")
		check(probe.split_code("0002abcd.").is_empty(), "код без ключа отвергается")
	check(main.eos_lobby.room != null and main.eos_lobby.room.code != "",
		"лобби Node: " + (str(main.eos_lobby.room.code) if main.eos_lobby.room != null else "?"))
	check(main.eos_lobby._unused_timer != null \
		and is_equal_approx(main.eos_lobby._unused_timer.wait_time, 30.0),
		"пустое лобби живёт 30 секунд")

	# Не ждём полные 30 с: тот же таймер, только короче.
	main.eos_lobby._unused_timer.stop()
	main.eos_lobby._unused_timer.wait_time = 0.4
	main.eos_lobby._unused_timer.start()
	await create_timer(1.2).timeout
	check(not main.eos_lobby.joined, "лобби без гостя закрылось само")
	check(main.eos_lobby.room == null and main.eos_lobby.server == null,
		"комната и сервер погашены таймером")
	check(str(main.eos_lobby._status_label.text).find("закрыто") >= 0,
		"причина словами: " + str(main.eos_lobby._status_label.text))
	var btn_after = main.eos_lobby._copy_btn
	check(btn_after != null and not btn_after.visible,
		"кнопка «Копировать» ушла вместе с комнатой")
	check(str(main.eos_lobby._invite.text) == "", "поле кода пустое после закрытия")

	main.eos_lobby.close_room()
	await create_timer(0.4).timeout
	check(main.eos_lobby.server == null and main.eos_lobby.room == null,
		"выход гасит сервер и комнату")
	main._on_eos_back()
	await create_timer(0.3).timeout
	check(main.state == main.State.MENU and main.menu.visible, "возврат в меню")

	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL EOS MODE TESTS PASSED")
		quit(0)
	else:
		print("EOS MODE TESTS FAILED")
		quit(1)
