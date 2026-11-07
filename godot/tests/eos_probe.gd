extends SceneTree

## Ручной прогон настоящего EOS: нужен user://eos.cfg с рабочими ключами.
##   godot --headless --path . -s res://tests/eos_probe.gd
## Не входит в tests/eos.sh: без ключей он честно падает.

var errs := [""]

func _init() -> void:
	_run()

func _run() -> void:
	print("== eos live probe")
	await create_timer(0.6).timeout
	HLog.log_level = HLog.LogLevel.DEBUG
	create_timer(150.0).timeout.connect(func() -> void:
		print("  FAIL таймаут")
		quit(2))
	var script = load("res://scripts/eos/p2p_link.gd")
	if script == null or not script.can_instantiate():
		print("  FAIL загрузка p2p_link")
		quit(1)
		return
	var link = script.new()
	link.failed.connect(func(t: String) -> void:
		errs[0] = t
		print("  failed: ", t))
	link.packet.connect(func(from: int, data: PackedByteArray) -> void:
		print("  packet from ", from, " ", data.size()))
	print("  available=", link.available())
	var ok: bool = await link.start_host()
	print("  start_host=", ok, " room=", link.room_id())
	if not ok:
		print("  error: ", errs[0])
		quit(1)
		return
	for i in range(40):
		await create_timer(0.1).timeout
		link.poll()
	print("  peers=", link.peers())
	print("  describe=", link.describe())
	link.stop()
	print("  stopped")
	quit(0)
