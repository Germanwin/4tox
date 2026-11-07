extends SceneTree

## Две копии EOS на одной машине: хозяин поднимает сокет, гость входит по
## коду <Product User ID>.<ключ> и обменивается пакетом. Проверяет настоящий
## транспорт, без Node и без петли.
##
##   godot --headless --path . -s res://tests/eos_pair.gd -- --host
##   godot --headless --path . -s res://tests/eos_pair.gd -- --guest=<код>

var got := false
var role := "host"
var room := ""

func _init() -> void:
	_run()

func _run() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--guest="):
			role = "guest"
			room = a.substr(8)
	print("== eos pair ", role)
	create_timer(120.0).timeout.connect(func() -> void:
		print("TIMEOUT")
		quit(3))
	await create_timer(0.6).timeout
	var openid_test := OS.get_environment("FOURTOX_TEST_OPENID") == "1"
	var script = load("res://tests/eos_openid_probe_link.gd" if openid_test else "res://scripts/eos/p2p_link.gd")
	var link = script.new()
	if openid_test:
		link.set_coordinator_url("https://374412.fornex.cloud/api/eos-coordinator")
	link.failed.connect(func(t: String) -> void: print("FAILED ", t))
	var ok := false
	if role == "host":
		ok = await link.start_host()
		print("ROOM ", link.room_id())
	else:
		ok = await link.start_client(room)
	print("start=", ok)
	if not ok:
		link.shutdown()
		quit(2)
		return
	link.peer_up.connect(func(id: int) -> void:
		print("PEER_UP ", id)
		link.send(id, ("ping" if role == "host" else "pong").to_utf8_buffer()))
	link.packet.connect(func(from: int, data: PackedByteArray) -> void:
		print("PACKET ", from, " ", data.get_string_from_utf8())
		got = true)
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < 60000 and not got:
		link.poll()
		await create_timer(0.1).timeout
	print("RESULT ", "OK" if got else "NO_PACKET")
	link.stop()
	link.shutdown()
	quit(0 if got else 4)
