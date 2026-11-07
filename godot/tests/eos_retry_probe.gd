extends SceneTree

func _init() -> void:
	_run()

func _run() -> void:
	await create_timer(0.5).timeout
	var script = load("res://tests/eos_retry_probe_link.gd")
	var first = script.new()
	first.set_coordinator_url("https://374412.fornex.cloud/api/eos-coordinator")
	var first_ok: bool = await first.start_host()
	if first_ok or first.error_text() != "simulated connection failure":
		print("RETRY PROBE: first stage failed: ", first.error_text())
		script.shutdown_eos()
		quit(1)
		return
	first.stop()
	var second = script.new()
	second.set_coordinator_url("https://374412.fornex.cloud/api/eos-coordinator")
	var ok: bool = await second.start_host()
	print("RETRY PROBE: ", "PASS" if ok else "FAIL: " + second.error_text())
	second.stop()
	script.shutdown_eos()
	quit(0 if ok else 1)
