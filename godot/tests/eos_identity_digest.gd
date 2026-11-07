extends SceneTree
## Only a per-run keyed digest leaves the process; no ID or credential is printed.
func _init() -> void:
	_run()
func _run() -> void:
	await create_timer(0.5).timeout
	HLog.log_level = HLog.LogLevel.OFF
	var script = load("res://scripts/eos/p2p_link.gd")
	var link = script.new()
	if not link.available() or not await link.start_host():
		print("IDENTITY_UNAVAILABLE")
		quit(2)
		return
	var salt := OS.get_cmdline_user_args()[0].hex_decode()
	var proof := Crypto.new().hmac_digest(HashingContext.HASH_SHA256, salt, str(link._local_user).to_utf8_buffer()).hex_encode()
	link.stop()
	script.shutdown_eos()
	print("IDENTITY_CHECK:", proof)
	quit(0)
