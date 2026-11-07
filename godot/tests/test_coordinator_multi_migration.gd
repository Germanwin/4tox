extends SceneTree
const Lobby = preload("res://scripts/eos/lobby.gd")
var lobbies := []
func _init() -> void:
	_run()
func fail(text: String) -> void:
	push_error(text)
	_done(1)
func _run() -> void:
	create_timer(75.0).timeout.connect(func() -> void: fail("multi migration timed out"))
	await process_frame
	var args := OS.get_cmdline_user_args()
	var count := int(args[1])
	var prestart := args[2].begins_with("lobby")
	var graceful := args[2] == "lobby-leave"
	var fail_candidate := args[2] == "game-failcandidate"
	for i in range(count):
		var lobby = Lobby.new()
		root.add_child(lobby)
		lobby.coordinator_test = true
		lobby.coordinator_base = args[0]
		lobby.open(64, "migration-multi")
		lobby._transport.select(1)
		lobby._name.text = "Godot"
		lobbies.append(lobby)
	var host = lobbies[0]
	var temp := OS.get_environment("TMPDIR")
	if temp == "": temp = ProjectSettings.globalize_path("user://state")
	host.session_override = temp.path_join("4tox-session-test-" + Crypto.new().generate_random_bytes(12).hex_encode()).path_join("session.cfg")
	host._capacity.select(count - 2)
	await host.host_game()
	if not host.joined: fail("host creation failed"); return
	var invite: String = host.coordinator.code
	for i in range(1, count):
		lobbies[i]._code.text = invite
		await lobbies[i].join_game()
		if not lobbies[i].joined: fail("guest join failed"); return
		if lobbies[i]._name.text != "Godot " + str(i + 1): fail("duplicate name was not resolved"); return
	for lobby in lobbies: await lobby.room.set_ready(true)
	if not prestart:
		await host.start_game()
		if not host.room.is_started(): fail("start failed"); return
		var t := Time.get_ticks_msec()
		while Time.get_ticks_msec() - t < 20000:
			var all := true
			for lobby in lobbies:
				if not lobby.room.is_started() or lobby.room.frames == 0: all = false
			if all: break
			await create_timer(0.1).timeout
		for lobby in lobbies:
			if lobby.room.frames == 0: fail("missing initial frames"); return
	await create_timer(5.0).timeout
	if graceful:
		await host.close_room()
	else:
		host.coordinator.stop()
		host.room.pause_migration()
		host.server.stop()
		host.tunnel.stop()
		host.link.stop()
		host.joined = false
	if fail_candidate:
		lobbies[1]._candidate_busy = true
	var expected_host := 2 if fail_candidate else 1
	var declined := false
	var t := Time.get_ticks_msec()
	var next_report := 0
	while Time.get_ticks_msec() - t < 45000:
		if Time.get_ticks_msec() > next_report:
			next_report = Time.get_ticks_msec() + 4000
			for i in range(1, count):
				print("client ", i, " state=", lobbies[i].coordinator.state.get("state", ""), " gen=", lobbies[i].coordinator.generation, " host=", lobbies[i].is_host, " recovering=", lobbies[i]._recovering, " candidate_busy=", lobbies[i]._candidate_busy, " attach_busy=", lobbies[i]._attach_busy, " error=", lobbies[i]._last_recovery_error)
		if fail_candidate and not declined and lobbies[1].coordinator.state.get("candidate", false):
			declined = true
			await lobbies[1].coordinator.request("decline", {})
			lobbies[1]._candidate_busy = false
		var complete: bool = lobbies[expected_host].is_host and not lobbies[expected_host]._recovering
		for i in range(1, count):
			if lobbies[i]._recovering or lobbies[i].coordinator.generation < 2: complete = false
		if complete: break
		await create_timer(0.1).timeout
	for i in range(1, count):
		var l = lobbies[i]
		if l._recovering or l.coordinator.generation < 2 or l.coordinator.code != invite:
			fail("client did not recover: %d state=%s error=%s" % [i, l.coordinator.state.get("state", ""), l._last_recovery_error]); return
	if not lobbies[expected_host].is_host: fail("candidate did not become host"); return
	if prestart:
		if graceful:
			await create_timer(1.0).timeout
			await lobbies[1].start_game()
			if not lobbies[1].room.is_started(): fail("remaining players could not start"); return
		else:
			if await lobbies[1].room.start_now(): fail("started with an offline player"); return
			# Recreate the old client's UI and resume from its private session file.
			var resumed = Lobby.new()
			root.add_child(resumed)
			resumed.coordinator_test = true
			resumed.session_override = host.session_override
			resumed.open(64, "migration-multi")
			resumed._transport.select(1)
			await resumed._resume_saved()
			host.session_override = ""
			host.queue_free()
			host = resumed
			lobbies[0] = resumed
			var until := Time.get_ticks_msec()
			while host._recovering and Time.get_ticks_msec() - until < 20000:
				await create_timer(0.1).timeout
			if host._recovering or host.is_host: fail("old host did not return as guest"); return
			await create_timer(1.0).timeout
			await lobbies[1].start_game()
			if not lobbies[1].room.is_started(): fail("new host could not start lobby after return"); return
	var frames := []
	for i in range(1, count): frames.append(lobbies[i].room.frames)
	await create_timer(3.0).timeout
	for i in range(1, count):
		if lobbies[i].room.frames <= frames[i - 1]: fail("client has no new frames: %d" % i); return
	print("PASS migration clients=", count, " phase=", args[2], " elapsedMs=", Time.get_ticks_msec() - t)
	_done(0)
func _done(status: int) -> void:
	for l in lobbies:
		if is_instance_valid(l):
			var session_dir: String = str(l.session_override).get_base_dir() if l.session_override != "" else ""
			await l.close_room()
			if session_dir.get_file().begins_with("4tox-session-test-"):
				DirAccess.remove_absolute(session_dir)
	quit(status)
