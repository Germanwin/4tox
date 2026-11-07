extends SceneTree

# Два отдельных процесса с настоящим EOS: хост разрывает P2P, гость
# уничтожает свой peer из обработчика обрыва и остаётся живым.
var link
var disconnected := false
var connected := false

func _init() -> void:
	_run()

func _run() -> void:
	await process_frame
	var args := OS.get_cmdline_user_args()
	var host := args[0] == "host"
	var exchange := args[1]
	HLog.log_level = HLog.LogLevel.OFF
	link = load("res://scripts/eos/p2p_link.gd").new()
	link.set_coordinator_url("https://374412.fornex.cloud/api/eos-coordinator")
	link.peer_up.connect(func(_id: int) -> void: connected = true)
	link.peer_down.connect(func(_id: int) -> void:
		disconnected = true
		link.stop())
	var ok: bool = await link.start_host() if host else await link.start_client(FileAccess.get_file_as_string(exchange))
	if not ok:
		print("FAIL start: ", link.error_text())
		await _finish(1)
		return
	if host:
		var file := FileAccess.open(exchange, FileAccess.WRITE)
		file.store_string(link.room_id())
		file.close()
	var deadline := Time.get_ticks_msec() + 60000
	while Time.get_ticks_msec() < deadline and not connected:
		link.poll()
		await create_timer(0.05).timeout
	if not connected:
		print("FAIL peer connection")
		await _finish(1)
		return
	if host:
		await create_timer(2.0).timeout
		link.stop()
		await create_timer(3.0).timeout
	else:
		deadline = Time.get_ticks_msec() + 30000
		while Time.get_ticks_msec() < deadline and not disconnected:
			link.poll()
			await create_timer(0.05).timeout
		if not disconnected:
			print("FAIL disconnect notification")
			await _finish(1)
			return
		await create_timer(2.0).timeout
	print("PASS EOS disconnect ", "host" if host else "guest")
	await _finish(0)

func _finish(code: int) -> void:
	link.stop()
	load("res://scripts/eos/p2p_link.gd").shutdown_eos()
	quit(code)
