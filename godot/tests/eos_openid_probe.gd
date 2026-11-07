extends SceneTree

func _init() -> void:
	_run()

func _run() -> void:
	await create_timer(0.5).timeout
	HLog.log_level = HLog.LogLevel.OFF
	var script = load("res://tests/eos_openid_probe_link.gd")
	var link = script.new()
	link.set_coordinator_url("https://374412.fornex.cloud/api/eos-coordinator")
	var ok: bool = link.available() and await link.start_host()
	if not ok:
		print("EOS OPENID ERROR: ", link.error_text())
	link.stop()
	script.shutdown_eos()
	print("EOS OPENID PROBE: ", "PASS" if ok else "FAIL")
	quit(0 if ok else 1)
