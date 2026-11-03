extends SceneTree

## HUD-кадры на ЖИВОМ снимке: поднимает локальный Node-сервер, входит в
## одиночную комнату (solo:true), ждёт первый снимок и снимает четыре панели
## плюс общий кадр. Пиксельного эталона у HUD нет (согласован перцептивный и
## структурный допуск) — кадры нужны для разглядывания, а структуру проверяет
## tests/test_hud.gd.
##
## Run: Godot --path . -s res://tests/render_hud.gd

const Demo = preload("res://scripts/hybrid_demo.gd")
const PORT := "8825"

var pid := -1
var demo = null


func _init() -> void:
	_run()


func _shot(name: String) -> void:
	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	var path := "res://shots/" + name + ".png"
	var err := img.save_png(path)
	print("кадр ", name, ": ", path, " err=", err)


func _run() -> void:
	print("== hud shots")
	OS.set_environment("STATE_DIR", "/tmp/4tox-hud-" + str(Time.get_ticks_usec()))
	var server := ProjectSettings.globalize_path("res://").path_join("../game/server/server.js")
	server = server.simplify_path()
	pid = OS.create_process("node", PackedStringArray([
		server, "--local", "--no-upnp", "--port", PORT,
		"--state-dir", "/tmp/4tox-test-hud-" + str(Time.get_ticks_usec()),
		"--log-file", "/tmp/4tox-test-hud.log"]))
	await create_timer(1.8).timeout
	root.size = Vector2i(1440, 900)

	demo = Demo.new()
	root.add_child(demo)
	await process_frame
	demo.open_live("http://127.0.0.1:" + PORT)

	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < 30000:
		await process_frame
		if demo.hud() != null and not demo.hud().snap.is_empty() and demo._layer != null:
			break
	if demo.hud() == null or demo.hud().snap.is_empty():
		print("нет снимка: HUD-кадры не сняты")
		if pid > 0:
			OS.kill(pid)
		quit(1)
		return
	var hud = demo.hud()
	print("снимок №", int(hud.snap.get("seq", 0)), " · ", hud.state().top)

	hud.close_panel()
	await _shot("hud")

	hud.open_panel("build")
	await _shot("hud_build")

	# Правка: выбираем ратушу и показываем живой ответ сервера на поворот.
	var hall_id := ""
	for b in hud.snap.get("buildings", []):
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == he_owner(hud):
			hall_id = str(b.get("id", ""))
			break
	hud.select(hall_id)
	await _shot("hud_edit")
	if hall_id != "":
		await hud.edit_action("rotate")
		await _shot("hud_edit_after")

	hud.open_panel("army")
	await _shot("hud_army")

	hud.open_panel("village")
	await _shot("hud_village")

	hud.open_panel("menu")
	await _shot("hud_menu")

	# Экран итога: поражение и победа. Снимок синтетический — проверяется
	# картинка, а не правила; структурно это покрыто test_hud.
	hud.close_panel()
	var live_snap: Dictionary = hud.snap.duplicate(true)
	var towns: Array = live_snap.get("towns", [])
	if towns.size() > 0:
		towns[0]["alive"] = false
	if towns.size() > 1:
		towns[1]["alive"] = true
	live_snap["over"] = true
	live_snap["winner"] = 1
	hud.snap = live_snap
	hud._end_shown = false
	hud._end.visible = false
	hud._check_end()
	await _shot("hud_defeat")

	if towns.size() > 0:
		towns[0]["alive"] = true
	if towns.size() > 1:
		towns[1]["alive"] = false
	live_snap["winner"] = 0
	hud.snap = live_snap
	hud._end_shown = false
	hud._end.visible = false
	hud._check_end()
	await _shot("hud_victory")

	if pid > 0:
		OS.kill(pid)
	quit(0)


func he_owner(hud) -> int:
	return int(hud.owner_id)
