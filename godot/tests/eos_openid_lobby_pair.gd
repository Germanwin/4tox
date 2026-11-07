extends SceneTree

const Lobby = preload("res://scripts/eos/lobby.gd")
var lobby
var done := false

func _init() -> void:
	_run()

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var host := args[0] == "host"
	var exchange := args[1]
	create_timer(150.0).timeout.connect(func() -> void:
		if not done:
			print("FAIL timeout")
			quit(3))
	await process_frame
	lobby = Lobby.new()
	root.add_child(lobby)
	lobby.coordinator_base = "https://374412.fornex.cloud/api/eos-coordinator"
	lobby.session_override = exchange + (".host" if host else ".guest")
	lobby.open(64, "test-public-lobby")
	lobby._transport.select(0)
	lobby._name.text = "Godot"
	lobby._capacity.select(0)
	if host:
		await lobby.host_game()
		if lobby.joined:
			var f := FileAccess.open(exchange, FileAccess.WRITE)
			f.store_string(lobby.coordinator.code)
			f.close()
	else:
		lobby._code.text = FileAccess.get_file_as_string(exchange)
		await lobby.join_game()
	if not lobby.joined:
		print("FAIL join or create: ", lobby._status_label.text)
		await _finish(1)
		return
	if not host and lobby._name.text != "Godot 2":
		print("FAIL duplicate name")
		await _finish(1)
		return
	await lobby.room.set_ready(true)
	var deadline := Time.get_ticks_msec() + 90000
	while Time.get_ticks_msec() < deadline:
		if host and lobby.room.lobby_players.size() >= 2:
			var ready := true
			for player in lobby.room.lobby_players:
				if not player.get("ready", false): ready = false
			if ready and not lobby.room.is_started(): await lobby.start_game()
		if lobby.room.is_started() and lobby.room.frames > 0:
			print("PASS room joined and world frames received")
			await create_timer(3.0).timeout
			await _finish(0)
			return
		await create_timer(0.25).timeout
	print("FAIL waiting for game frames")
	await _finish(1)

func _finish(status: int) -> void:
	done = true
	await lobby.close_room()
	quit(status)
