extends SceneTree

## Кроссплей ЧЕРЕЗ VPS: Godot-хост создаёт комнату по HTTPS на проде, Chrome
## входит по коду с того же origin, оба видят один остров и две деревни.
##
## Запуск (нужен Chrome и выложенный сервер):
##   TOX_VPS_URL=https://374412.fornex.cloud:8443 \
##     Godot --headless --path . -s res://tests/vps_crossplay.gd
## (или -- --base=https://...)

const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var host = null
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
	print("== VPS crossplay ", base)
	host = LiveRoom.new()
	root.add_child(host)
	await process_frame
	var made: bool = await host.create_lobby(base, "Godot-VPS", "вольная-заводь-346", 64, 2)
	check(made, "Godot создал комнату на VPS")
	if not made:
		_finish()
		return
	check(host.code.length() >= 4, "код: " + host.code)

	var out := "/tmp/4tox-vps-guest.json"
	if FileAccess.file_exists(out):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(out))
	OS.set_environment("TOX_HOST_URL", base)
	var script := ProjectSettings.globalize_path("res://tests/browser_guest.js")
	chrome_pid = OS.create_process("node", PackedStringArray([script, "0", host.code, out]))
	check(chrome_pid > 0, "Chrome-гость запущен")

	var joined := await _wait_for(func() -> bool:
		return host.players_count() >= 2, 40.0)
	check(joined, "браузер вошёл по коду")
	host.set_ready(true)
	var all_ready := await _wait_for(func() -> bool:
		return host.ready_count() >= 2, 20.0)
	check(all_ready, "оба готовы")
	check(await host.start_now(), "Godot-хост начал партию")
	var got := await _wait_for(func() -> bool:
		return host.world != null and not host.latest_snapshot.is_empty(), 45.0)
	check(got, "Godot получил WLD1 и кадр")
	if got:
		var towns: Array = host.latest_snapshot.get("towns", [])
		check(towns.size() == 2, "две деревни: %d" % towns.size())
		check((host.latest_snapshot.get("buildings", []) as Array).size() == 6,
			"шесть построек")

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
		check(str(report.get("role", "")) == "client", "браузер — гость")
		check(int(report.get("towns", 0)) == 2, "у браузера две деревни")
		check(int(report.get("buildings", 0)) == 6, "у браузера шесть построек")
		check(int(report.get("villagers", 0)) == 6, "у браузера шесть жителей")
		check(str(report.get("seed", "")) == "вольная-заводь-346", "один сид")
		check(str(report.get("transport", "")) == "ws", "транспорт ws")
		check(int(report.get("hostBuildings", 0)) == 3, "браузер видит дома Godot")
	_finish()


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.1).timeout
	return pred.call()


func _finish() -> void:
	if host != null:
		host.leave()
		host.queue_free()
	if chrome_pid > 0 and OS.is_process_running(chrome_pid):
		OS.kill(chrome_pid)
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL VPS CROSSPLAY TESTS PASSED")
		quit(0)
	else:
		print("VPS CROSSPLAY TESTS FAILED")
		quit(1)
