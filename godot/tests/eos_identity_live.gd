extends SceneTree
## Optional real SDK probe: reuses existing Device ID, never prints identifiers.
func _init() -> void:
	_run()
func _run() -> void:
	await create_timer(0.5).timeout
	HLog.log_level = HLog.LogLevel.OFF
	var script = load("res://scripts/eos/p2p_link.gd")
	var first = script.new()
	if not first.available() or not await first.start_host():
		print("EOS IDENTITY PROBE: unavailable")
		quit(2)
		return
	var identity: String = first._local_user
	first.stop()
	var second = script.new()
	var ok: bool = await second.start_host()
	var stable: bool = ok and identity != "" and identity == second._local_user
	second.stop()
	script.shutdown_eos()
	print("EOS IDENTITY PROBE: ", "PASS same process" if stable else "FAIL")
	quit(0 if stable else 1)
