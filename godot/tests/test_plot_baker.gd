extends SceneTree

## Фоновый запекатель газонов: работа уходит в поток, картинка возвращается
## на главный. Без этого новый дом на секунду замирал на запекании.

const PlotBaker = preload("res://scripts/plot_baker.gd")
const BuildingsData = preload("res://scripts/buildings_data.gd")

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== фоновый запекатель газонов")
	var bdata = BuildingsData.new()
	var b := {"id": "b0", "type": "house", "variant": "a", "rot": 90, "x": 10, "y": 10}
	var f: Dictionary = bdata.frame_for("house", "a", 90)
	var baker = PlotBaker.new()
	baker.start()
	var t0 := Time.get_ticks_msec()
	baker.enqueue("k0", b, f)
	var enqueue_ms := Time.get_ticks_msec() - t0
	check(enqueue_ms < 80, "постановка в очередь не блокирует кадр (%d мс)" % enqueue_ms)
	var got: Dictionary = {}
	var deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline:
		await process_frame
		for r in baker.poll():
			got = r
		if not got.is_empty():
			break
	check(not got.is_empty(), "фоновый поток вернул газон")
	if not got.is_empty():
		var bake: Dictionary = got.get("bake", {})
		check(not bake.is_empty() and (bake.get("image") as Image) != null,
			"вернулась картинка газона")
	baker.stop()
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
