extends SceneTree

## Полный путь игрока через VPS: меню → «Сеть» → адрес VPS → «Создать игру» →
## настоящий Chrome входит по коду → «Готов» → «Начать игру» → матч в приложении
## с двумя деревнями. Проверяет и экран, и VPS, и кроссплей.
##
##   TOX_VPS_URL=https://374412.fornex.cloud:8443 \
##     Godot --headless --path . -s res://tests/vps_main.gd

const MAIN := preload("res://scenes/main.tscn")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var main = null
var chrome_pid := -1
var base := ""


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	base = OS.get_environment("TOX_VPS_URL")
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--base="):
			base = a.substr(7)
	if base == "":
		base = "https://374412.fornex.cloud:8443"
	base = base.rstrip("/")
	LiveRoom.clear_session()
	print("== VPS из приложения ", base)
	main = MAIN.instantiate()
	root.add_child(main)
	await process_frame
	await process_frame
	main._on_play(64, "вольная-заводь-346", "net")
	var lobby_open := await _wait_for(func() -> bool:
		return main.net_lobby != null and main.net_lobby.visible, 25.0)
	check(lobby_open, "экран сети открыт")
	if not lobby_open:
		_finish()
		return
	main.net_lobby.set_address(base)
	main.net_lobby.press("Создать игру")
	var made := await _wait_for(func() -> bool: return main.net_lobby.joined, 25.0)
	check(made, "комната создана на VPS")
	if not made:
		_finish()
		return
	var code := str(main.net_lobby.state()["code"])
	check(code.length() >= 4, "код: " + code)
	OS.set_environment("TOX_HOST_URL", base)
	var script := ProjectSettings.globalize_path("res://tests/browser_guest.js")
	var out := "/tmp/4tox-vps-main-guest.json"
	if FileAccess.file_exists(out):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(out))
	chrome_pid = OS.create_process("node", PackedStringArray([script, "0", code, out]))
	check(chrome_pid > 0, "Chrome-гость запущен")
	var joined := await _wait_for(func() -> bool:
		return main.net_lobby.state()["players"] >= 2, 40.0)
	check(joined, "браузер вошёл по коду")
	main.net_lobby.toggle_ready()
	var both := await _wait_for(func() -> bool:
		return not bool(main.net_lobby.state()["start_disabled"]), 20.0)
	check(both, "оба готовы")
	main.net_lobby.press("Начать игру")
	var in_match := await _wait_for(func() -> bool:
		return main.state == main.State.DEMO and main.demo._layer != null \
			and main.demo._layer.buildings.size() >= 6 \
			and not main.demo.hud().snap.is_empty(), 45.0)
	check(in_match, "приложение вошло в матч на VPS")
	if in_match:
		check((main.demo.hud().snap.get("towns", []) as Array).size() == 2,
			"две деревни")
		check(str(main.demo._world.worldgen_hash).length() > 0, "остров получен")
	var report := {}
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < 60000:
		if FileAccess.file_exists(out):
			var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(out))
			if data is Dictionary:
				report = data
				break
		await create_timer(0.3).timeout
	check(not report.is_empty(), "браузер отчитался")
	if not report.is_empty():
		check(int(report.get("towns", 0)) == 2, "у браузера две деревни")
		check(int(report.get("buildings", 0)) == 6, "у браузера шесть построек")
		check(str(report.get("transport", "")) == "ws", "транспорт ws")
		check(str(report.get("seed", "")) == "вольная-заводь-346", "один сид")
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.1).timeout
	return pred.call()


func _finish() -> void:
	if main != null:
		main._on_main_menu()
		await create_timer(0.5).timeout
		if main.net_lobby != null:
			main.net_lobby.close_room()
		if main.server != null:
			main.server.stop()
	if chrome_pid > 0 and OS.is_process_running(chrome_pid):
		OS.kill(chrome_pid)
	LiveRoom.clear_session()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL VPS MAIN TESTS PASSED")
		quit(0)
	else:
		print("VPS MAIN TESTS FAILED")
		quit(1)
