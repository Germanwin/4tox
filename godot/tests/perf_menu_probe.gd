extends SceneTree

## Временный замер: меню и экран сети на настоящей сцене приложения.
## Запуск окном (не headless), иначе fps нечего мерить:
##   Godot --path . -s res://tests/perf_menu_probe.gd

var _frames := 0
var _slow := 0
var _t0 := 0
var _last := 0
var _dt_sum := 0.0
var _dt_max := 0.0
var _main = null


func _init() -> void:
	_run()


func _sample(label: String, seconds: float) -> void:
	_frames = 0
	_slow = 0
	_dt_sum = 0.0
	_dt_max = 0.0
	_last = Time.get_ticks_usec()
	_t0 = _last
	var end := _last + int(seconds * 1000000.0)
	while Time.get_ticks_usec() < end:
		await process_frame
		var now := Time.get_ticks_usec()
		var d := float(now - _last) / 1000.0
		_last = now
		_frames += 1
		_dt_sum += d
		_dt_max = maxf(_dt_max, d)
		if d > 25.0:
			_slow += 1
	var total := float(Time.get_ticks_usec() - _t0) / 1000.0
	print("%s: кадров %d за %.0f мс, fps %.1f, средний %.2f мс, худший %.1f мс, >25мс %d" % [
		label, _frames, total, 1000.0 * float(_frames) / total,
		_dt_sum / float(maxi(1, _frames)), _dt_max, _slow])


func _run() -> void:
	root.size = Vector2i(1440, 900)
	Engine.max_fps = 60
	var scene: PackedScene = load("res://scenes/main.tscn")
	_main = scene.instantiate()
	root.add_child(_main)
	await process_frame
	await process_frame
	await create_timer(1.5).timeout
	await _sample("меню", 5.0)
	var big := false
	for a in OS.get_cmdline_user_args():
		if a == "big":
			big = true
	if big and _main != null:
		_main._make_preview(256)
		await create_timer(4.5).timeout
		await _sample("меню 256", 5.0)
	if _main != null:
		_main._open_net_lobby(64, "тихая-долина-701")
	await create_timer(2.0).timeout
	await _sample("экран сети", 5.0)
	quit(0)
