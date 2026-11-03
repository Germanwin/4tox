extends SceneTree

## Кроссплей Godot ↔ браузер: Godot создаёт лобби и ждёт второго игрока,
## настоящий Chrome входит по коду и жмёт «Готов», хост стартует. Проверяется
## один мир на двоих: две деревни, шесть построек, шесть жителей, одинаковый
## сид у обоих, и команда Godot-хоста своему городу доходит до сервера.
##
## Run: Godot --headless --path . -s res://tests/test_crossplay.gd

const LiveRoom = preload("res://scripts/live_room.gd")
const PORT := "8827"

var fails := 0
var checks := 0
var pid := -1
var got_world := false
var snap: Dictionary = {}
var err := ""
var room = null


func check(c: bool, s: String) -> void:
	checks += 1
	print(("  ok   " if c else "  FAIL ") + s)
	if not c:
		fails += 1


func _on_snap(s) -> void:
	snap = s


func _on_fail(t: String) -> void:
	err = t


func _init() -> void:
	_run()


func _run() -> void:
	print("== crossplay godot <-> browser")
	OS.set_environment("STATE_DIR", "/tmp/4tox-cross-" + str(Time.get_ticks_usec()))
	var server := ProjectSettings.globalize_path("res://").path_join("../game/server/server.js").simplify_path()
	pid = OS.create_process("node", PackedStringArray([server, "--local", "--no-upnp", "--port", PORT,
		"--state-dir", "/tmp/4tox-test-cross-" + str(Time.get_ticks_usec()),
		"--log-file", "/tmp/4tox-test-cross.log"]))
	check(pid > 0, "сервер запущен")
	await create_timer(1.6).timeout

	room = LiveRoom.new()
	root.add_child(room)
	room.snapshot.connect(_on_snap)
	room.failed.connect(_on_fail)
	room.begin_host("http://127.0.0.1:" + PORT)
	# Ждём код лобби, затем пускаем браузер.
	var t0 := Time.get_ticks_msec()
	while room.code == "" and Time.get_ticks_msec() - t0 < 15000:
		await process_frame
	check(room.code != "", "лобби Godot: " + room.code)
	if room.code == "":
		_finish()
		return
	var out := "/tmp/4tox-cross-guest-%d.json" % Time.get_ticks_usec()
	if FileAccess.file_exists(out):
		DirAccess.remove_absolute(out)
	var guest := ProjectSettings.globalize_path("res://").path_join("tests/browser_guest.js").simplify_path()
	OS.create_process("node", PackedStringArray([guest, PORT, room.code, out]))

	t0 = Time.get_ticks_msec()
	while room.start_payload.is_empty() and Time.get_ticks_msec() - t0 < 60000:
		await process_frame
	check(not room.start_payload.is_empty(), "матч стартовал" + ("" if err == "" else " (" + err + ")"))
	t0 = Time.get_ticks_msec()
	while snap.is_empty() and Time.get_ticks_msec() - t0 < 20000:
		await process_frame
	check(not snap.is_empty(), "Godot получил снимок")
	if not snap.is_empty():
		check(snap.get("towns", []).size() == 2, "деревень %d" % snap.get("towns", []).size())
		check(snap.get("buildings", []).size() == 6, "построек %d" % snap.get("buildings", []).size())
		check(snap.get("villagers", []).size() == 6, "жителей %d" % snap.get("villagers", []).size())
		var owners := {}
		for b in snap.get("buildings", []):
			owners[int(b.get("owner", 0))] = true
		check(owners.has(0) and owners.has(1), "постройки обоих городов")
		# Команда хоста своему городу — тем же путём, что из HUD.
		var hall := {}
		for b in snap.get("buildings", []):
			if str(b.get("type", "")) == "townhall" and int(b.get("owner", 0)) == 0:
				hall = b
				break
		if not hall.is_empty():
			var r: Dictionary = await room.send_command("edit",
				{"action": "rotate", "id": str(hall.get("id", ""))})
			check(r.get("ok", false), "команда хоста: " + str(r.get("state", "")))

	# Браузерный гость: тот же мир.
	var t1 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t1 < 40000 and not FileAccess.file_exists(out):
		await process_frame
	check(FileAccess.file_exists(out), "браузерный гость отчитался")
	if FileAccess.file_exists(out):
		var g: Variant = JSON.parse_string(FileAccess.get_file_as_string(out))
		if g is Dictionary:
			check(int(g.get("towns", 0)) == 2, "у браузера деревень %d" % int(g.get("towns", 0)))
			check(int(g.get("buildings", 0)) == 6, "у браузера построек %d" % int(g.get("buildings", 0)))
			check(int(g.get("hostBuildings", 0)) == 3, "браузер видит дома Godot: %d" % int(g.get("hostBuildings", 0)))
			check(int(g.get("mine", 0)) == 3, "у браузера свой город: %d" % int(g.get("mine", 0)))
			# ws — обычный путь; sse — штатный запасной канал того же клиента.
			var tr := str(g.get("transport", ""))
			check(tr == "ws" or tr == "sse", "транспорт браузера: " + tr)
			var wseed := ""
			if room.start_payload.has("seed"):
				wseed = str(room.start_payload.get("seed", ""))
			check(wseed == "" or str(g.get("seed", "")) == wseed, "один сид: " + wseed)
		else:
			check(false, "отчёт браузера не JSON")
	_finish()


func _finish() -> void:
	if pid > 0:
		OS.kill(pid)
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL CROSSPLAY TESTS PASSED")
		quit(0)
	else:
		print("CROSSPLAY TESTS FAILED")
		quit(1)
