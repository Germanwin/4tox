extends SceneTree

## Pixel gate: compares the Godot ground frame with the browser reference.
## Counts pixels whose worst channel differs by more than 12/255 and requires
## the share to stay under 0.5 %. Also writes a red diff mask for inspection.
##
## Run: Godot --headless --path . -s res://tests/test_render.gd -- z40

var DIR := "res://tests/fixtures"
const TOL := 12
const MAX_SHARE := 0.005


func _init() -> void:
	var env := OS.get_environment("TOX_FIXTURES")
	if env != "":
		DIR = env
	var tag := "ground_z40"
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		tag = args[0]
	var ref := Image.load_from_file(DIR + "/ref_" + tag + ".png")
	var got := Image.load_from_file(DIR + "/out_" + tag + ".png")
	if ref == null or got == null:
		print("нет кадров: ref/out " + tag)
		quit(1)
		return
	if ref.get_width() != got.get_width() or ref.get_height() != got.get_height():
		print("размеры разные: %dx%d и %dx%d" % [ref.get_width(), ref.get_height(), got.get_width(), got.get_height()])
		quit(1)
		return
	ref.convert(Image.FORMAT_RGBA8)
	got.convert(Image.FORMAT_RGBA8)
	var w := ref.get_width()
	var h := ref.get_height()
	var a := ref.get_data()
	var b := got.get_data()
	var mask := PackedByteArray()
	mask.resize(w * h * 3)
	var bad := 0
	var sum := 0
	var worst := 0
	var step := 0
	for i in range(w * h):
		var k := i * 4
		var d0 := absi(int(a[k]) - int(b[k]))
		var d1 := absi(int(a[k + 1]) - int(b[k + 1]))
		var d2 := absi(int(a[k + 2]) - int(b[k + 2]))
		var d := maxi(d0, maxi(d1, d2))
		sum += d
		if d > worst:
			worst = d
		if d > TOL:
			bad += 1
			var m := i * 3
			mask[m] = 255
			mask[m + 1] = 0
			mask[m + 2] = 0
		if d > 0:
			step += 1
	var share := float(bad) / float(w * h)
	var mean := float(sum) / float(w * h)
	print("кадр %s: %dx%d" % [tag, w, h])
	print("  пикселей с расхождением >%d: %d (%.3f %%)" % [TOL, bad, share * 100.0])
	print("  средняя дельта %.2f, худшая %d, отличие хоть на 1: %.1f %%" % [mean, worst, 100.0 * step / (w * h)])
	var diff := Image.create_from_data(w, h, false, Image.FORMAT_RGB8, mask)
	diff.save_png(DIR + "/diff_" + tag + ".png")
	var ok := share <= MAX_SHARE
	print("  порог %.1f %%: %s" % [MAX_SHARE * 100.0, "PASS" if ok else "FAIL"])
	quit(0 if ok else 1)
