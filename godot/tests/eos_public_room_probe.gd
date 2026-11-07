extends SceneTree

# Optional integration probe against a configured HTTPS coordinator and the
# real EOS SDK. Never prints room codes, player IDs, or credentials.
const Lobby = preload("res://scripts/eos/lobby.gd")
var lobby
var private_dir := ""

func _init() -> void:
	_run()

func _run() -> void:
	await process_frame
	var base := OS.get_environment("FOURTOX_EOS_TEST_COORDINATOR")
	if not base.begins_with("https://"):
		print("EOS PUBLIC ROOM PROBE: missing HTTPS coordinator")
		quit(2)
		return
	lobby = Lobby.new()
	root.add_child(lobby)
	private_dir = OS.get_environment("TMPDIR").path_join("4tox-public-probe-" + Crypto.new().generate_random_bytes(12).hex_encode())
	lobby.session_override = private_dir.path_join("session.cfg")
	lobby.coordinator_base = base
	lobby.open(64, "public-probe")
	lobby._transport.select(0)
	lobby._name.text = "Probe"
	lobby._capacity.select(0)
	await lobby.host_game()
	if not lobby.joined or not lobby.is_host:
		print("EOS PUBLIC ROOM PROBE: create failed: ", lobby._status_label.text)
		await _finish(1)
		return
	var deadline := Time.get_ticks_msec() + 15000
	var saved := false
	while Time.get_ticks_msec() < deadline:
		var state: Dictionary = await lobby.coordinator.request("heartbeat", {})
		if state.get("backupAvailable", false):
			saved = true
			break
		await create_timer(0.5).timeout
	print("EOS PUBLIC ROOM PROBE: ", "PASS" if saved else "backup unavailable")
	await _finish(0 if saved else 1)

func _finish(code: int) -> void:
	if is_instance_valid(lobby):
		await lobby.close_room()
	if private_dir != "" and DirAccess.dir_exists_absolute(private_dir):
		DirAccess.remove_absolute(private_dir)
	quit(code)
