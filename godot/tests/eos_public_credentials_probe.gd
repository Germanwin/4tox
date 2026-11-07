extends SceneTree

# Optional real EOS test. The input is an external, private JSON file; neither
# its contents nor player identifiers are printed or written to the project.
func _init() -> void:
	_run()

func _run() -> void:
	await create_timer(0.5).timeout
	HLog.log_level = HLog.LogLevel.OFF
	var coordinator := OS.get_environment("FOURTOX_EOS_TEST_COORDINATOR")
	var script = load("res://scripts/eos/p2p_link.gd" if coordinator != "" else "res://tests/eos_public_probe_link.gd")
	var link = script.new()
	if coordinator != "":
		link.set_coordinator_url(coordinator)
	var ok: bool = link.available() and await link.start_host()
	if not ok:
		print("EOS PUBLIC CLIENT ERROR: ", link.error_text())
	link.stop()
	script.shutdown_eos()
	print("EOS PUBLIC CLIENT PROBE: ", "PASS" if ok else "FAIL")
	quit(0 if ok else 1)
