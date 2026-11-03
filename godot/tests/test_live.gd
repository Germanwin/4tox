extends SceneTree

## End-to-end: Godot creates a room over HTTP, starts it, pulls WLD1, connects
## WebSocket and receives a 4TX1 snapshot. The server is spawned here and killed
## afterwards; nothing in the fixture path is used.

const LiveRoom = preload("res://scripts/live_room.gd")
const PORT := "8823"

var fails := 0
var checks := 0
var pid := -1
var got_world := false
var got_snap := false
var world = null
var snap: Dictionary = {}
var err := ""


func _on_world(w) -> void:
	got_world = true
	world = w


func _on_snap(s) -> void:
	got_snap = true
	snap = s


func _on_fail(t: String) -> void:
	err = t


func check(c: bool, s: String) -> void:
	checks += 1
	print(("  ok   " if c else "  FAIL ") + s)
	if not c:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== live room")
	OS.set_environment("STATE_DIR", "/tmp/4tox-live-" + str(Time.get_ticks_usec()))
	var server := ProjectSettings.globalize_path("res://").path_join("../game/server/server.js")
	server = server.simplify_path()
	pid = OS.create_process("node", PackedStringArray([
		server, "--local", "--no-upnp", "--port", PORT,
		"--state-dir", "/tmp/4tox-test-live-" + str(Time.get_ticks_usec()),
		"--log-file", "/tmp/4tox-test-live.log"]))
	check(pid > 0, "сервер запущен (pid %d)" % pid)
	await create_timer(1.6).timeout

	var room = LiveRoom.new()
	root.add_child(room)
	room.world_ready.connect(_on_world)
	room.snapshot.connect(_on_snap)
	room.failed.connect(_on_fail)
	room.begin("http://127.0.0.1:" + PORT)

	var t0 := Time.get_ticks_msec()
	while (not got_world or not got_snap) and Time.get_ticks_msec() - t0 < 20000:
		await process_frame
	check(got_world, "мир WLD1 получен" + ("" if err == "" else " (" + err + ")"))
	if not got_world:
		print("  status: ", err)
	check(got_snap, "снимок 4TX1 получен")
	if got_world and world != null:
		check(world.width > 0 and world.objects.size() > 0,
			"мир %dx%d, объектов %d" % [world.width, world.height, world.objects.size()])
		check(world.worldgen_hash.length() == 8, "hash " + str(world.worldgen_hash))
	if got_snap:
		check(int(snap.get("revision", -1)) >= 0, "revision %d" % int(snap.get("revision", -1)))
		# solo:true — одна деревня: ратуша, дом, лагерь и три жителя.
		check(snap.get("buildings", []).size() == 3, "построек %d" % snap.get("buildings", []).size())
		check(snap.get("villagers", []).size() == 3, "жителей %d" % snap.get("villagers", []).size())
		check(snap.get("towns", []).size() == 1, "деревень %d" % snap.get("towns", []).size())
		check(room.frames >= 1, "кадров %d" % room.frames)
		check(room.instance != "", "instance команды: " + room.instance)
		# Команда через единственный путь: повернуть свою ратушу.
		var hall: Dictionary = {}
		for b in snap.get("buildings", []):
			if str(b.get("type", "")) == "townhall":
				hall = b
				break
		check(not hall.is_empty(), "ратуша в снимке")
		if not hall.is_empty():
			var before := int(hall.get("rot", 0))
			var res: Dictionary = await room.send_command("edit",
				{"action": "rotate", "id": str(hall.get("id", ""))})
			check(res.get("ok", false), "команда rotate: " + str(res.get("state", "")) +
				" " + str(res.get("reason", "")))
			var t1 := Time.get_ticks_msec()
			var rotated := false
			var now_rot := before
			while Time.get_ticks_msec() - t1 < 6000 and not rotated:
				await process_frame
				for b in snap.get("buildings", []):
					if str(b.get("id", "")) == str(hall.get("id", "")) \
							and int(b.get("rot", 0)) != before:
						rotated = true
						now_rot = int(b.get("rot", 0))
			check(rotated, "снимок показывает поворот %d → %d" % [before, now_rot])

	if pid > 0:
		OS.kill(pid)
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL LIVE TESTS PASSED")
		quit(0)
	else:
		print("LIVE TESTS FAILED")
		quit(1)
