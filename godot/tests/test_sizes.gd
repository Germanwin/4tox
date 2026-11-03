extends SceneTree
func _init():
	for s in [48, 64, 96, 128, 192, 256]:
		var t0 := Time.get_ticks_msec()
		var w := ToxWorldGen.generate({"seed":"тест-%d" % s, "size":s})
		var t1 := Time.get_ticks_msec()
		var tex := ToxTerrain.build(w)
		var t2 := Time.get_ticks_msec()
		print("%d: world %d ms, terrain %d ms, map %dx%d, objects %d, tex %dx%d" % [s, t1-t0, t2-t1, w.width, w.height, w.objects.size(), tex.image_w, tex.image_h])
	quit()
