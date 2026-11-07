extends SceneTree
const Lobby = preload("res://scripts/eos/lobby.gd")
var host
var guest
func _init() -> void:
	_run()
func _run() -> void:
	create_timer(70.0).timeout.connect(func() -> void: push_error("migration test timed out"); _done(1))
	await process_frame
	host = Lobby.new()
	guest = Lobby.new()
	root.add_child(host)
	root.add_child(guest)
	host.coordinator_test = true
	guest.coordinator_test = true
	host.coordinator_base = OS.get_cmdline_user_args()[0]
	guest.coordinator_base = host.coordinator_base
	host.open(64, "migration-integration")
	guest.open(64, "migration-integration")
	host._transport.select(1)
	guest._transport.select(1)
	host._name.text = "Host"
	guest._name.text = "Guest"
	await host.host_game()
	assert(host.joined and host.coordinator != null)
	guest._code.text = host.coordinator.code
	await guest.join_game()
	assert(guest.joined)
	await host.room.set_ready(true)
	await guest.room.set_ready(true)
	assert(await host.room.start_now())
	var started := Time.get_ticks_msec()
	while (not guest.room.is_started() or guest.room.frames == 0 or not host.coordinator.state.get("started", false)) and Time.get_ticks_msec() - started < 20000:
		await create_timer(0.1).timeout
	assert(guest.room.is_started() and guest.room.frames > 0)
	var prior: int = guest.room.frames
	guest.link.stop()
	var reconnected := Time.get_ticks_msec()
	while (guest._recovering or guest.room.frames <= prior) and Time.get_ticks_msec() - reconnected < 15000:
		await create_timer(0.1).timeout
	assert(not guest._recovering and guest.room.frames > prior)
	# Wait for a checkpoint that includes the started game and both players.
	await create_timer(4.0).timeout
	print("backup status: ", host._last_backup_error, " available=", host.coordinator.state.get("backupAvailable", false))
	var coordinator_code: String = host.coordinator.code
	var before: int = guest.room.frames
	# Simulate a crash: no leave request and no fresh backup.
	host.coordinator.stop()
	host.room.pause_migration()
	host.server.stop()
	host.tunnel.stop()
	host.link.stop()
	host.joined = false
	started = Time.get_ticks_msec()
	var last_report := 0
	while (not guest.is_host or guest._recovering or guest.room.frames <= before) and Time.get_ticks_msec() - started < 40000:
		if Time.get_ticks_msec() - last_report > 3000:
			last_report = Time.get_ticks_msec()
			print("migration status phase=", guest.coordinator.state.get("state", "none"), " generation=", guest.coordinator.generation, " candidate=", guest.coordinator.state.get("candidate", false), " recovering=", guest._recovering, " busy=", guest._candidate_busy, " error=", guest._last_recovery_error, " host=", guest.is_host, " frames=", guest.room.frames, " running=", guest.coordinator._running, " heartbeat=", guest.coordinator._heartbeat_busy, " notice=", guest._status_label.text)
		await create_timer(0.1).timeout
	assert(guest.is_host and not guest._recovering and guest.room.frames > before)
	assert(guest.coordinator.code == coordinator_code)
	print("PASS unexpected host loss: coordinator elects guest and restores real Node world; elapsedMs=", Time.get_ticks_msec() - started)
	_done(0)
func _done(status: int) -> void:
	if is_instance_valid(host): await host.close_room()
	if is_instance_valid(guest): await guest.close_room()
	quit(status)
