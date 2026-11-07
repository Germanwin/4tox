extends SceneTree

## Красный тест скорости меню: заставка не должна каждый кадр перебирать и
## рисовать все деревья острова по одному. Природа собирается в мировой меш
## ОДИН раз, а кадр рисует его одной командой.

const WorldView = preload("res://scripts/world_view.gd")
const Sim = preload("res://scripts/sim.gd")

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
	print("== статичная природа меню")
	var sim = Sim.new()
	sim.start("тихая-долина-701", 64, "solo")
	var view = WorldView.new()
	root.add_child(view)
	await process_frame
	view.setup(sim)
	await process_frame
	view.ensure_nature_mesh()
	var builds := int(view.nature_mesh_builds)
	check(builds == 1, "меш природы собран один раз (сборок %d)" % builds)
	check(int(view.static_nature_quads) > 100,
		"в меш попало много деревьев (%d)" % int(view.static_nature_quads))
	await process_frame
	await process_frame
	view.ensure_nature_mesh()
	check(int(view.nature_mesh_builds) == builds,
		"повторный кадр не пересобирает меш")
	check(int(view.nature_draw_calls) == 0,
		"природа больше не рисуется по одному объекту")
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
