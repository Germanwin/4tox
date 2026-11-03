class_name ToxGroundCache
extends RefCounted

## Ground cache — a port of `Renderer.paintCache` from mapgen2/js/render.js.
##
## The browser paints the cache in five passes: deep fill with the ripple
## pattern (multiply), the water-depth image (one pixel per cell, stretched
## bilinearly), the land filled with the grass pattern, the sand band with a
## dithered edge, and the wet-sand image clipped to the land.
##
## Here the same passes run in GDScript at cache resolution, so the result
## does not depend on a renderer and works headless. Two differences from a
## literal canvas port:
##   * the land and sand masks use the union of cell diamonds with a one-pixel
##     coverage ramp (the browser's path antialiasing), not per-cell alpha;
##   * the ripple is baked into a "deep with ripple" tile, so deep water and
##     the sea beyond the map cost one blit instead of a per-pixel loop.
## Everything else — colours, widths, the sand dither, the wet band, the
## bilinear stretch of the per-cell images — is the browser's numbers.

const TEX_REPEAT := 2
const CACHE_MIN_PX := 16
const CACHE_MAX_PX := 40

const DEEP := Color8(22, 78, 128)
const WATER := Color8(38, 112, 166)
const SHALLOW := Color8(86, 176, 205)
const SAND := Color8(232, 214, 152)
const SHALLOW_W := 2.6
const DEPTH_W := 6.4
const BEACH_CORE := 1.2
const BEACH_FRINGE := 3.1
const WET_W := 0.42
const WET_ALPHA := 0.18
const WET_COLOR := Color8(72, 86, 66)
const OVERLAP := 0.5
const SQRT5 := 2.23606797749979
const GRASS_FALLBACK := Color8(104, 168, 74)
const RIPPLE := Color8(255, 255, 255)

## Насколько кромка пути сдвинута наружу (в пикселях кэша) для заливки суши и
## песка. Подобрано замером кадра m96 ground_z24 (перебор 0.0..1.0): у суши
## минимум 0.4, у песка 0.45. Это не «на глаз»: числа дают 0.25 % вместо
## 0.83 % при нуле и 0.85 % при единице.
const GROW_LAND := 0.4
const GROW_SAND := 0.45

## One cell of u or v is px/sqrt(5) cache pixels across a diamond edge:
## one cell along u moves (px/2, px/4) and its projection on the edge normal
## is px/sqrt(5).


## Returns {image, px, off_x, off_y}. off_x/off_y is the cache origin of the
## world diamond, exactly as render.js computes it.
static func build(world, _host = null) -> Dictionary:
	var n: int = world.width * world.height
	var px := clampi(int(round(sqrt(9000000.0 / float(n)))), CACHE_MIN_PX, CACHE_MAX_PX)
	var w: int = world.width
	var h: int = world.height
	var cw := int(ceil((w + h) * px * 0.5)) + 2
	var ch := int(ceil((w + h) * px * 0.25)) + 2
	var period := maxi(8, int(round(TEX_REPEAT * px)))
	var offx := float(h * px) * 0.5

	var grass := _tile("res://assets/textures/grass.png", period, GRASS_FALLBACK)
	var sand := _tile("res://assets/textures/sand.png", period, SAND)
	var ripple := _tile("res://assets/textures/ripple.png", period, RIPPLE)
	var deep := _deep_ripple(ripple, period)

	var img := Image.create_empty(cw, ch, false, Image.FORMAT_RGBA8)
	_fill_all(img, deep)
	if _has_water(world):
		img = _water(img, world, px, offx, period, grass, sand, ripple)
	return {"image": img, "px": px, "off_x": offx, "off_y": 0.0}


## Kept for callers: the port no longer needs a renderer, so the async path is
## the synchronous one. Headless and windowed builds produce the same cache.
static func build_async(world, host = null) -> Dictionary:
	return build(world, host)


static func _has_water(world) -> bool:
	for i in range(world.is_land.size()):
		if world.is_land[i] == 0:
			return true
	return false


static func _water(img: Image, world, px: int, offx: float, period: int,
		grass: Image, sand: Image, ripple: Image) -> Image:
	var w: int = world.width
	var h: int = world.height
	var cw := img.get_width()
	var ch := img.get_height()
	var gd := grass.get_data()
	var sd := sand.get_data()
	var rd := ripple.get_data()
	var prof := OS.has_environment("TOX_PROFILE")
	var landm := PackedByteArray()
	var sandm := PackedByteArray()
	landm.resize(w * h)
	sandm.resize(w * h)
	for i in range(w * h):
		var is_land: bool = world.is_land[i] != 0
		landm[i] = 1 if is_land else 0
		sandm[i] = 1 if (is_land and world.dist_water[i] <= BEACH_CORE + 1e-6) else 0
	var t0 := Time.get_ticks_msec()

	# Глубина: картинка «клетка = пиксель», как paintWaterDepth.
	var depth := PackedByteArray()
	depth.resize(w * h * 4)
	for i in range(w * h):
		var col := SHALLOW
		if world.is_land[i] == 0:
			var d: float = world.dist_land[i]
			if d > DEPTH_W:
				col = DEEP
			elif d <= SHALLOW_W:
				col = SHALLOW.lerp(WATER, d / SHALLOW_W)
			else:
				col = WATER.lerp(DEEP, (d - SHALLOW_W) / (DEPTH_W - SHALLOW_W))
		var k := i * 4
		depth[k] = clampi(int(round(col.r * 255.0)), 0, 255)
		depth[k + 1] = clampi(int(round(col.g * 255.0)), 0, 255)
		depth[k + 2] = clampi(int(round(col.b * 255.0)), 0, 255)
		depth[k + 3] = 255
	img = _water_under(img, world, depth, rd, px, offx, period)
	if prof: print("  water pass ", Time.get_ticks_msec() - t0, " ms")
	t0 = Time.get_ticks_msec()

	# Суша: газон заливается полосами по строкам (быстро), AA-кромка — потом.
	_land_scanline(img, world, grass, px, offx, period)
	if prof: print("  land scan ", Time.get_ticks_msec() - t0, " ms")
	t0 = Time.get_ticks_msec()

	var data := img.get_data()
	# AA-кромка суши: только прибрежные клетки, покрытие по объединению ромбов.
	for j in range(h):
		for i in range(w):
			var ci := j * w + i
			if world.is_land[ci] != 0:
				if world.dist_water[ci] > 1.5:
					continue
			elif world.dist_land[ci] > 1.5:
				continue
			_cell_land_edge(data, landm, w, h, gd, cw, ch, px, offx, period, i, j)

	# Песок: сплошная полоса и дизеринг кромки.
	for j in range(h):
		for i in range(w):
			var ci := j * w + i
			if world.is_land[ci] != 0:
				if world.dist_water[ci] > BEACH_FRINGE:
					continue
			elif world.dist_land[ci] > 1.5:
				continue
			_cell_sand(data, sandm, w, h, sd, cw, ch, px, offx, period, i, j)
	for j in range(h):
		for i in range(w):
			var ci := j * w + i
			if world.is_land[ci] == 0:
				continue
			var d: float = world.dist_water[ci]
			if d <= BEACH_CORE + 1e-6 or d > BEACH_FRINGE:
				continue
			_grains(data, sd, world, cw, ch, px, offx, period, i, j, d)
	if prof: print("  sand pass ", Time.get_ticks_msec() - t0, " ms")
	t0 = Time.get_ticks_msec()

	# Мокрый песок у воды.
	var wet := PackedByteArray()
	wet.resize(w * h)
	for i in range(w * h):
		var a := 0.0
		if world.is_land[i] != 0:
			var d: float = world.dist_water[i]
			if d <= 1.0 + WET_W:
				a = (1.0 - (d - 1.0) / WET_W) * WET_ALPHA
		elif world.dist_land[i] <= 1.0:
			a = WET_ALPHA
		wet[i] = clampi(int(round(a * 255.0)), 0, 255)
	for j in range(h):
		for i in range(w):
			var ci := j * w + i
			if world.is_land[ci] != 0:
				if world.dist_water[ci] > 1.0 + WET_W + 0.75:
					continue
			elif world.dist_land[ci] > 1.6:
				continue
			_cell_wet(data, landm, w, h, wet, cw, ch, px, offx, i, j)
	if prof: print("  wet pass ", Time.get_ticks_msec() - t0, " ms")
	return Image.create_from_data(cw, ch, false, Image.FORMAT_RGBA8, data)


## Вода: градиент глубины с бликами. Глубина за полосой уже лежит заливкой
## (цвет там ровно DEEP), поэтому полоса — единственная per-pixel работа.
static func _water_under(img: Image, world, depth: PackedByteArray, rd: PackedByteArray,
		px: int, offx: float, period: int) -> Image:
	var w: int = world.width
	var h: int = world.height
	var cw := img.get_width()
	var ch := img.get_height()
	var data := img.get_data()
	for j in range(h):
		for i in range(w):
			var ci := j * w + i
			if world.is_land[ci] != 0:
				if world.dist_water[ci] > 1.5:
					continue
			elif world.dist_land[ci] > DEPTH_W + 1.5:
				continue
			_cell_water(data, world, depth, rd, cw, ch, px, offx, period, i, j, w, h)
	return Image.create_from_data(cw, ch, false, Image.FORMAT_RGBA8, data)


## Заливка суши полосами по строкам: вдоль строки клетки идут лесенкой, и
## объединение соседних клеток — непрерывный отрезок. Внутри отрезка рисунок
## копируется целыми кусками тайла; 2 px у кромки оставлены AA-проходу.
static func _land_scanline(img: Image, world, grass: Image, px: int, offx: float,
		period: int) -> void:
	var w: int = world.width
	var h: int = world.height
	var cw := img.get_width()
	var ch := img.get_height()
	var land: PackedByteArray = world.is_land
	var inv := 1.0 / float(px)
	for y in range(ch):
		var Y := float(y) + 0.5
		var x := 0
		var run_start := -1
		var run_end := -1
		while x < cw:
			var X := float(x) + 0.5
			var u := (X + 2.0 * Y - offx) * inv
			var v := (2.0 * Y - X + offx) * inv
			var i := int(round(u))
			var j := int(round(v))
			var xl := maxf(px * (float(i) - 0.5) - 2.0 * Y + offx - 0.5,
				2.0 * Y + offx - px * (float(j) + 0.5) - 0.5)
			var xr := minf(px * (float(i) + 0.5) - 2.0 * Y + offx - 0.5,
				2.0 * Y + offx - px * (float(j) - 0.5) - 0.5)
			var xa := maxi(x, int(ceil(xl)))
			var xb := mini(cw, int(ceil(xr)))
			if xb <= xa:
				x = maxi(x + 1, xb)
				continue
			var is_land: bool = i >= 0 and j >= 0 and i < w and j < h and land[j * w + i] != 0
			if is_land:
				if run_start < 0:
					run_start = xa
				run_end = xb
			else:
				if run_start >= 0:
					_flush_land(img, grass, y, run_start, run_end, period)
					run_start = -1
			x = xb
		if run_start >= 0:
			_flush_land(img, grass, y, run_start, run_end, period)


static func _flush_land(img: Image, grass: Image, y: int, x0: int, x1: int, period: int) -> void:
	var a := x0 + 2
	var b := x1 - 2
	if b <= a:
		return
	_blit_span(img, grass, y, a, b)


static func _blit_span(img: Image, tile: Image, y: int, x0: int, x1: int) -> void:
	var p := tile.get_width()
	var x := x0
	while x < x1:
		var sx := posmod(x, p)
		var w := mini(p - sx, x1 - x)
		img.blit_rect(tile, Rect2i(sx, posmod(y, p), w, 1), Vector2i(x, y))
		x += w


## Один ромб воды: цвет из растянутой картинки глубины, умноженный на блики.
## Каждый пиксель обрабатывает только своя клетка (round(u), round(v)).
static func _cell_water(data: PackedByteArray, world, depth: PackedByteArray,
		rd: PackedByteArray, cw: int, ch: int, px: int, offx: float, period: int,
		i: int, j: int, w: int, h: int) -> void:
	var cx := (float(i) - float(j)) * px * 0.5 + offx
	var cy := (float(i) + float(j)) * px * 0.25
	var x0 := maxi(0, int(floor(cx - px * 0.5)) - 1)
	var x1 := mini(cw - 1, int(ceil(cx + px * 0.5)) + 1)
	var y0 := maxi(0, int(floor(cy - px * 0.25)) - 1)
	var y1 := mini(ch - 1, int(ceil(cy + px * 0.25)) + 1)
	for y in range(y0, y1 + 1):
		for x in range(x0, x1 + 1):
			var u := (float(x) + 0.5 + 2.0 * (float(y) + 0.5) - offx) / float(px)
			var v := (2.0 * (float(y) + 0.5) - (float(x) + 0.5) + offx) / float(px)
			if int(round(u)) != i or int(round(v)) != j:
				continue
			var su := clampf(u, 0.0, float(w - 1))
			var sv := clampf(v, 0.0, float(h - 1))
			var bx0 := int(floor(su))
			var by0 := int(floor(sv))
			var bx1 := mini(bx0 + 1, w - 1)
			var by1 := mini(by0 + 1, h - 1)
			var fx := su - float(bx0)
			var fy := sv - float(by0)
			var i00 := (by0 * w + bx0) * 4
			var i10 := (by0 * w + bx1) * 4
			var i01 := (by1 * w + bx0) * 4
			var i11 := (by1 * w + bx1) * 4
			var rp := rd[(posmod(y, period) * period + posmod(x, period)) * 4]
			var m := 0.15 + 0.85 * float(rp) / 255.0
			var o := (y * cw + x) * 4
			for c in range(3):
				var a := float(depth[i00 + c]) * (1.0 - fx) + float(depth[i10 + c]) * fx
				var b := float(depth[i01 + c]) * (1.0 - fx) + float(depth[i11 + c]) * fx
				data[o + c] = clampi(int(round((a * (1.0 - fy) + b * fy) * m)), 0, 255)
			data[o + 3] = 255


static func _cell_land_edge(data: PackedByteArray, mask: PackedByteArray, w: int, h: int,
		gd: PackedByteArray, cw: int, ch: int, px: int, offx: float, period: int,
		i: int, j: int) -> void:
	var cx := (float(i) - float(j)) * px * 0.5 + offx
	var cy := (float(i) + float(j)) * px * 0.25
	var x0 := maxi(0, int(floor(cx - px * 0.5)) - 2)
	var x1 := mini(cw - 1, int(ceil(cx + px * 0.5)) + 2)
	var y0 := maxi(0, int(floor(cy - px * 0.25)) - 2)
	var y1 := mini(ch - 1, int(ceil(cy + px * 0.25)) + 2)
	for y in range(y0, y1 + 1):
		for x in range(x0, x1 + 1):
			var u := (float(x) + 0.5 + 2.0 * (float(y) + 0.5) - offx) / float(px)
			var v := (2.0 * (float(y) + 0.5) - (float(x) + 0.5) + offx) / float(px)
			if int(round(u)) != i or int(round(v)) != j:
				continue
			var cov := _cell_cov(mask, w, h, u, v, px, GROW_LAND)
			if cov <= 0.0:
				continue
			_blend(data, (y * cw + x) * 4, gd, posmod(x, period), posmod(y, period), period, cov)


static func _cell_sand(data: PackedByteArray, mask: PackedByteArray, w: int, h: int,
		sd: PackedByteArray, cw: int, ch: int, px: int, offx: float, period: int,
		i: int, j: int) -> void:
	var cx := (float(i) - float(j)) * px * 0.5 + offx
	var cy := (float(i) + float(j)) * px * 0.25
	var x0 := maxi(0, int(floor(cx - px * 0.5)) - 2)
	var x1 := mini(cw - 1, int(ceil(cx + px * 0.5)) + 2)
	var y0 := maxi(0, int(floor(cy - px * 0.25)) - 2)
	var y1 := mini(ch - 1, int(ceil(cy + px * 0.25)) + 2)
	for y in range(y0, y1 + 1):
		for x in range(x0, x1 + 1):
			var u := (float(x) + 0.5 + 2.0 * (float(y) + 0.5) - offx) / float(px)
			var v := (2.0 * (float(y) + 0.5) - (float(x) + 0.5) + offx) / float(px)
			if int(round(u)) != i or int(round(v)) != j:
				continue
			var cov := _cell_cov(mask, w, h, u, v, px, GROW_SAND)
			if cov <= 0.0:
				continue
			_blend(data, (y * cw + x) * 4, sd, posmod(x, period), posmod(y, period), period, cov)


static func _grains(data: PackedByteArray, sd: PackedByteArray, world,
		cw: int, ch: int, px: int, offx: float, period: int, i: int, j: int, d: float) -> void:
	var n := 3
	var pc := 0.25
	if d <= 2.1:
		n = 6
		pc = 0.9
	elif d <= 3.1:
		n = 4
		pc = 0.55
	if _hash2(i, j, 9137) > pc:
		return
	for gi in range(n):
		var h1 := _hash2(i * 17 + gi, j * 31 + gi, 9138)
		var h2 := _hash2(i * 29 + gi, j * 13 + gi, 9139)
		var h3 := _hash2(i * 7 + gi, j * 23 + gi, 9140)
		var hw := (0.03 + h3 * 0.05) * float(px)
		var hh := hw * 0.5
		var su := float(i) + 0.08 + h1 * 0.84
		var sv := float(j) + 0.08 + h2 * 0.84
		var cx := (su - sv) * float(px) * 0.5 + offx
		var cy := (su + sv) * float(px) * 0.25
		var x0 := maxi(0, int(floor(cx - hw)) - 1)
		var x1 := mini(cw - 1, int(ceil(cx + hw)) + 1)
		var y0 := maxi(0, int(floor(cy - hh)) - 1)
		var y1 := mini(ch - 1, int(ceil(cy + hh)) + 1)
		for y in range(y0, y1 + 1):
			for x in range(x0, x1 + 1):
				var cov := _diamond_cov(cx, cy, hw, hh, float(x), float(y))
				if cov <= 0.0:
					continue
				_blend(data, (y * cw + x) * 4, sd, posmod(x, period), posmod(y, period), period, cov)


static func _cell_wet(data: PackedByteArray, mask: PackedByteArray, w: int, h: int,
		wet: PackedByteArray, cw: int, ch: int, px: int, offx: float, i: int, j: int) -> void:
	var cx := (float(i) - float(j)) * px * 0.5 + offx
	var cy := (float(i) + float(j)) * px * 0.25
	var x0 := maxi(0, int(floor(cx - px * 0.5)) - 1)
	var x1 := mini(cw - 1, int(ceil(cx + px * 0.5)) + 1)
	var y0 := maxi(0, int(floor(cy - px * 0.25)) - 1)
	var y1 := mini(ch - 1, int(ceil(cy + px * 0.25)) + 1)
	for y in range(y0, y1 + 1):
		for x in range(x0, x1 + 1):
			var u := (float(x) + 0.5 + 2.0 * (float(y) + 0.5) - offx) / float(px)
			var v := (2.0 * (float(y) + 0.5) - (float(x) + 0.5) + offx) / float(px)
			if int(round(u)) != i or int(round(v)) != j:
				continue
			var su := clampf(u, 0.0, float(w - 1))
			var sv := clampf(v, 0.0, float(h - 1))
			var bx0 := int(floor(su))
			var by0 := int(floor(sv))
			var bx1 := mini(bx0 + 1, w - 1)
			var by1 := mini(by0 + 1, h - 1)
			var fx := su - float(bx0)
			var fy := sv - float(by0)
			var va := float(wet[by0 * w + bx0]) * (1.0 - fx) + float(wet[by0 * w + bx1]) * fx
			var vb := float(wet[by1 * w + bx0]) * (1.0 - fx) + float(wet[by1 * w + bx1]) * fx
			var a := (va * (1.0 - fy) + vb * fy) * (1.0 / 255.0)
			if a <= 0.0:
				continue
			a *= _cell_cov(mask, w, h, u, v, px, 0.0)
			if a <= 0.0:
				continue
			var o := (y * cw + x) * 4
			data[o] = clampi(int(round(float(data[o]) * (1.0 - a) + WET_COLOR.r * 255.0 * a)), 0, 255)
			data[o + 1] = clampi(int(round(float(data[o + 1]) * (1.0 - a) + WET_COLOR.g * 255.0 * a)), 0, 255)
			data[o + 2] = clampi(int(round(float(data[o + 2]) * (1.0 - a) + WET_COLOR.b * 255.0 * a)), 0, 255)


## Покрытие пикселя объединением ромбов маски: 1 внутри, 0 снаружи, 1 px AA.
## mask: 1 — суша, 2 — полоса песка (суша с distWater <= BEACH_CORE).
## grow — на сколько canvas-путь раздут по X/Y (render.js: OVERLAP); в
## перпендикуляре к кромке это ~0.5 px, поэтому 50% кромки сдвинуты наружу.
static func _cell_cov(mask: PackedByteArray, w: int, h: int, u: float, v: float, px: int,
		grow: float) -> float:
	var i := int(floor(u + 0.5))
	var j := int(floor(v + 0.5))
	var inside := _mask_at(mask, w, h, i, j)
	var du := u - float(i)
	var dv := v - float(j)
	var d := 1e9
	if _mask_at(mask, w, h, i + 1, j) != inside:
		d = minf(d, 0.5 - du)
	if _mask_at(mask, w, h, i - 1, j) != inside:
		d = minf(d, 0.5 + du)
	if _mask_at(mask, w, h, i, j + 1) != inside:
		d = minf(d, 0.5 - dv)
	if _mask_at(mask, w, h, i, j - 1) != inside:
		d = minf(d, 0.5 + dv)
	if d > 1e8:
		return 1.0 if inside else 0.0
	var dpx := d * float(px) / SQRT5
	if inside:
		return clampf(0.5 + dpx + grow, 0.0, 1.0)
	return clampf(0.5 - dpx + grow, 0.0, 1.0)


static func _mask_at(mask: PackedByteArray, w: int, h: int, i: int, j: int) -> bool:
	if i < 0 or j < 0 or i >= w or j >= h:
		return false
	return mask[j * w + i] != 0


# --------------------------------------------------------------- tiles / blit

static func _tile(path: String, period: int, fallback: Color) -> Image:
	# Сначала импортированный ресурс (так работает и в экспорте), затем файл
	# как запасной путь для случая, когда импорт ещё не собран.
	var img: Image = null
	var tex := load(path) as Texture2D
	if tex != null:
		img = tex.get_image()
	if img == null:
		img = Image.load_from_file(path)
	if img == null:
		img = Image.create_empty(period, period, false, Image.FORMAT_RGBA8)
		img.fill(fallback)
		return img
	img.convert(Image.FORMAT_RGBA8)
	img.resize(period, period, Image.INTERPOLATE_BILINEAR)
	return img


## Море: цвет глубины, умноженный на блики, как drawSeaTexture (multiply 0.85).
static func _deep_ripple(ripple: Image, period: int) -> Image:
	var rd := ripple.get_data()
	var b := PackedByteArray()
	b.resize(period * period * 4)
	for y in range(period):
		for x in range(period):
			var i := (y * period + x) * 4
			var m := 0.15 + 0.85 * float(rd[i]) / 255.0
			b[i] = clampi(int(round(DEEP.r * 255.0 * m)), 0, 255)
			b[i + 1] = clampi(int(round(DEEP.g * 255.0 * m)), 0, 255)
			b[i + 2] = clampi(int(round(DEEP.b * 255.0 * m)), 0, 255)
			b[i + 3] = 255
	return Image.create_from_data(period, period, false, Image.FORMAT_RGBA8, b)


static func _fill_all(img: Image, tile: Image) -> void:
	var p := tile.get_width()
	var cw := img.get_width()
	var ch := img.get_height()
	for y in range(0, ch, p):
		for x in range(0, cw, p):
			img.blit_rect(tile, Rect2i(0, 0, mini(p, cw - x), mini(p, ch - y)), Vector2i(x, y))


## Покрытие пикселя ромбом зёрен песка: суперсэмплинг 4x4 (16 уровней).
## Аналитическое отсечение ромба квадратом давало бы точнее, но стоило
## 1.5 с на кадр — а зёрна это мелкая крупа в 2–3 px, где 1/16 достаточно.
static func _diamond_cov(cx: float, cy: float, hw: float, hh: float, x: float, y: float) -> float:
	var ihw := 1.0 / hw
	var ihh := 1.0 / hh
	var cov := 0.0
	for sy in [0.125, 0.375, 0.625, 0.875]:
		var dy := absf(y + sy - cy) * ihh
		for sx in [0.125, 0.375, 0.625, 0.875]:
			if absf(x + sx - cx) * ihw + dy <= 1.0:
				cov += 0.0625
	return cov


static func _blend(data: PackedByteArray, o: int, tile: PackedByteArray, tx: int, ty: int,
		period: int, a: float) -> void:
	if a <= 0.0:
		return
	var t := (ty * period + tx) * 4
	if a >= 1.0:
		data[o] = tile[t]
		data[o + 1] = tile[t + 1]
		data[o + 2] = tile[t + 2]
		data[o + 3] = 255
		return
	var ia := 1.0 - a
	data[o] = clampi(int(round(float(data[o]) * ia + float(tile[t]) * a)), 0, 255)
	data[o + 1] = clampi(int(round(float(data[o + 1]) * ia + float(tile[t + 1]) * a)), 0, 255)
	data[o + 2] = clampi(int(round(float(data[o + 2]) * ia + float(tile[t + 2]) * a)), 0, 255)
	data[o + 3] = 255


## Детерминированный хеш клетки — тот же, что в render.js (32-битная арифметика).
static func _hash2(x: int, y: int, salt: int) -> float:
	var h := (x * 374761393 + y * 668265263 + salt * 1442695041) & 0xFFFFFFFF
	var u := h & 0xFFFFFFFF
	var sh := (u >> 13) & 0x1FFFFF
	h = ((h ^ sh) * 1274126177) & 0xFFFFFFFF
	u = h & 0xFFFFFFFF
	sh = (u >> 16) & 0xFFFF
	h = (h ^ sh) & 0xFFFFFFFF
	return float(h & 0xFFFFFFFF) / 4294967296.0
