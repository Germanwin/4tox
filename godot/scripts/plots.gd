class_name ToxPlots
extends RefCounted

## Plot turf under buildings — port of `Renderer.bakeTurfTexture` from
## mapgen2/js/render.js.
##
## The browser bakes each plot into its own canvas: the footprint inset by
## 0.12 cells, grown by 0.28 with a ragged edge (a point every 0.085 cells,
## jitter ±0.10 cells), filled with the 2x2-cell `plot_grass` tile (four
## rotations, phase from the building position), soft-masked with
## `filter: blur(22px)` and finally a fringe of short leaves drawn OUTSIDE
## that mask along the same ragged edge.
##
## Only the mask differs in implementation. The canvas blur is a Gaussian
## whose std deviation was measured on a long straight edge: 23 bake px
## (half-alpha at the edge, RMS 2.4/255 against the erf model). A pixel at
## signed distance d from the polygon therefore gets alpha = Phi(d / 23).
## Distance is measured in canvas pixels: one cell of (u, v) is BAKE/sqrt(5)
## pixels across a diamond edge. The leaf fringe is a literal port — same
## LCG, same order, same numbers.

const BAKE := 128
const INSET := 0.12
const MARGIN := 0.85
const EDGE := 0.28
const EDGE_JITTER := 0.10
const EDGE_STEP := 0.085
const SIGMA := 23.0
const TEX_CELLS := 2
const M := 12
const FRINGE := [Color8(94, 152, 70), Color8(118, 180, 88), Color8(140, 200, 104)]

## One cell of u or v is this many canvas pixels across a diamond edge.
const PER_CELL := BAKE / 2.23606797749979

static var _base_tile: Image = null


## Deterministic LCG — the browser's `rnd()` inside plotGrassEdge / the fringe.
class Lcg:
	var state: int

	func _init(s: int) -> void:
		state = s

	func f() -> float:
		state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
		return float(state) / 4294967296.0


static func build_for(buildings: Array, bdata) -> Array:
	var out: Array = []
	for b in buildings:
		# Под завалом газона нет: участок принадлежит целой постройке.
		if bool(b.get("rubble", false)):
			continue
		var t0 := Time.get_ticks_msec()
		var img = _one(b, bdata)
		print("plot bake ", b.get("type", "?"), " ", Time.get_ticks_msec() - t0, " ms")
		if img != null:
			out.append(img)
	return out


## Draw baked plot layers in cache space (the browser's drawPlots transform).
## Shared by WorldLayer and the build slice so the gate measures one path.
static func draw_layers(ci: CanvasItem, layers: Array, cam: Dictionary, z: float,
		css: Vector2) -> void:
	var half := css * 0.5
	var cam_px := (0.0 - float(cam["x"]) + float(cam["y"])) * z * 0.5
	var cam_py := (0.0 - float(cam["x"]) - float(cam["y"])) * z * 0.25
	var s := z / float(BAKE)
	for p in layers:
		var tex: Texture2D = p["tex"]
		var pos := Vector2(half.x + cam_px + float(p["ox"]) * s,
			half.y + cam_py + float(p["oy"]) * s)
		ci.draw_texture_rect(tex, Rect2(pos, tex.get_size() * s), false)


static func _one(b: Dictionary, bdata) -> Variant:
	if bdata == null:
		return null
	var type := str(b.get("type", "townhall"))
	var f: Dictionary = bdata.frame_for(type, str(b.get("variant", "a")), int(b.get("rot", 0)))
	if f.is_empty():
		return null
	var fp: Array = f["fp"]
	var x0 := float(b["x"]) + INSET
	var y0 := float(b["y"]) + INSET
	var x1 := float(b["x"]) + float(fp[0]) - INSET
	var y1 := float(b["y"]) + float(fp[1]) - INSET
	var pad := MARGIN
	var bx0 := (x0 - pad - (y1 + pad)) * BAKE * 0.5
	var bx1 := (x1 + pad - (y0 - pad)) * BAKE * 0.5
	var by0 := (x0 - pad + (y0 - pad)) * BAKE * 0.25
	var by1 := (x1 + pad + y1 + pad) * BAKE * 0.25
	var ox := int(floor(bx0 - M))
	var oy := int(floor(by0 - M))
	var cw := maxi(1, int(ceil(bx1 - bx0 + 2.0 * M)))
	var ch := maxi(1, int(ceil(by1 - by0 + 2.0 * M)))

	var tile := _tile(int(b["x"]), int(b["y"]), int(b.get("rot", 0)))
	var tw := tile.get_width()
	# Canvas pattern is anchored at (phx, phy) in canvas space: a device pixel
	# X samples tile (X − phx) mod tw (measured with a probe).
	var phx := posmod(int(float(b["x"])) * 73 + int(float(b["y"])) * 131, tw)
	var phy := posmod(int(float(b["x"])) * 151 + int(float(b["y"])) * 47, tw)
	var td := tile.get_data()

	var out := PackedByteArray()
	out.resize(cw * ch * 4)

	# --- ragged edge: the same points and the same LCG order as the browser.
	var seed := ((int(float(b["x"])) * 2246822519) ^ (int(float(b["y"])) * 3266489917)
		^ ((int(b.get("rot", 0)) + 7) * 668265263)) & 0xFFFFFFFF
	if seed == 0:
		seed = 0x9E3779B9
	var lcg := Lcg.new(seed)
	sides_edges = []
	var sides := {"x0": x0, "y0": y0, "x1": x1, "y1": y1}
	sides["top"] = _seg(lcg, x0, y0, x1, y0, 0.0, -1.0, x0, x1)
	sides["right"] = _seg(lcg, x1, y0, x1, y1, 1.0, 0.0, y0, y1)
	sides["bot"] = _seg(lcg, x1, y1, x0, y1, 0.0, 1.0, x1, x0)
	sides["left"] = _seg(lcg, x0, y1, x0, y0, -1.0, 0.0, y1, y0)
	sides["edges"] = sides_edges

	for py in range(ch):
		for px in range(cw):
			# экранный пиксель слоя -> клетки участка (обратная изометрия)
			var X := float(ox + px)
			var Y := float(oy + py)
			var u := (X + Y * 2.0) / BAKE
			var v := (Y * 2.0 - X) / BAKE
			var d := _signed(sides, u, v) * PER_CELL
			# The browser blurs the mask but paints it into a canvas that is
			# already clipped by the ragged polygon: the edge stays hard and
			# the Gaussian ramp goes INWARD. Clip coverage adds the 1 px AA.
			if d < -0.5:
				continue
			var a: float
			if d > SIGMA * 3.2:
				a = 1.0
			else:
				a = clampf(d + 0.5, 0.0, 1.0) * _phi(d / SIGMA)
			if a <= 0.003:
				continue
			var tx := posmod(px - phx, tw)
			var ty := posmod(py - phy, tw)
			var ti := (ty * tw + tx) * 4
			var o := (py * cw + px) * 4
			out[o] = td[ti]
			out[o + 1] = td[ti + 1]
			out[o + 2] = td[ti + 2]
			out[o + 3] = int(a * 255.0)

	# --- fringe leaves on top of the mask, exactly as bakeTurfTexture does.
	_fringe(out, cw, ch, ox, oy, b, x0, y0, x1, y1, sides["edges"])

	var img := Image.create_from_data(cw, ch, false, Image.FORMAT_RGBA8, out)
	return {"tex": ImageTexture.create_from_image(img), "ox": ox, "oy": oy}


## One jittered side. `tab` holds n random offsets plus the exact-grow corner
## point the browser pushes after each side. Returns {tab, n, base, len}.
static func _seg(lcg: Lcg, ax: float, ay: float, bx: float, by: float,
		nx: float, ny: float, along0: float, along1: float) -> Dictionary:
	var dx := bx - ax
	var dy := by - ay
	var ln := sqrt(dx * dx + dy * dy)
	var tab: Array = []
	if ln <= 0.0:
		return {"tab": [EDGE, EDGE], "n": 1, "base": along0, "len": 1.0}
	var n := maxi(10, int(round(ln / EDGE_STEP)))
	for i in range(n):
		var t := float(i) / float(n)
		var w := EDGE + (lcg.f() - 0.5) * EDGE_JITTER * 2.0
		tab.append(w)
		sides_edges.push_back([ax + dx * t + nx * w, ay + dy * t + ny * w,
			nx, ny, dx / ln, dy / ln])
	tab.append(EDGE)
	return {"tab": tab, "n": n, "base": along0, "len": ln, "dir": 1.0 if along1 >= along0 else -1.0}


static var sides_edges: Array = []


static func _side_val(side: Dictionary, along: float) -> float:
	var tab: Array = side["tab"]
	var n: int = side["n"]
	var ln: float = side["len"]
	var t := (along - float(side["base"])) / ln * float(n) * float(side["dir"])
	if t <= 0.0:
		return float(tab[0])
	if t >= float(n):
		return float(tab[n])
	var i := int(t)
	var fr := t - float(i)
	return float(tab[i]) * (1.0 - fr) + float(tab[i + 1]) * fr


## Signed distance (in cells, positive inside) to the ragged plot polygon:
## min over the four jittered sides. Corners are covered by the leaf fringe
## and sit well inside the blur.
static func _signed(s: Dictionary, u: float, v: float) -> float:
	var d := v - (float(s["y0"]) - _side_val(s["top"], u))
	d = minf(d, (float(s["y1"]) + _side_val(s["bot"], u)) - v)
	d = minf(d, u - (float(s["x0"]) - _side_val(s["left"], v)))
	return minf(d, (float(s["x1"]) + _side_val(s["right"], v)) - u)


static func _phi(z: float) -> float:
	# Phi(z) = 0.5 * (1 + erf(z / sqrt(2))) via the Abramowitz-Stegun erf
	# approximation (max error 1.5e-7).
	var x := z * 0.7071067811865476
	var ax := absf(x)
	var t := 1.0 / (1.0 + 0.3275911 * ax)
	var poly := ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
		- 0.284496736) * t + 0.254829592) * t
	var erf := signf(x) * (1.0 - poly * exp(-ax * ax))
	return 0.5 * (1.0 + erf)


## Бахрома: короткие листья из-за кромки. Порт 1:1: тот же LCG, тот же
## порядок вызовов, те же числа, что в bakeTurfTexture.
static func _fringe(out: PackedByteArray, cw: int, ch: int, ox: int, oy: int,
		b: Dictionary, x0: float, y0: float, x1: float, y1: float, eg: Array) -> void:
	var seed := ((int(float(b["x"])) * 374761393) ^ (int(float(b["y"])) * 668265263)
		^ ((int(b.get("rot", 0)) + 3) * 1442695041)) & 0xFFFFFFFF
	if seed == 0:
		seed = 0x85EBCA6B
	var lcg := Lcg.new(seed)
	for e in eg:
		if lcg.f() > 0.12:
			continue
		var jt := (lcg.f() - 0.5) * 0.07
		_blade(out, cw, ch, ox, oy,
			float(e[0]) + float(e[4]) * jt, float(e[1]) + float(e[5]) * jt,
			float(e[2]), float(e[3]), float(e[4]), float(e[5]), lcg)
	var corners := [
		[x1, y0, 1.0, -1.0], [x1, y1, 1.0, 1.0],
		[x0, y1, -1.0, 1.0], [x0, y0, -1.0, -1.0],
	]
	for c in corners:
		for k in range(4):
			var cx2 := float(c[0]) + float(c[2]) * (0.08 + lcg.f() * 0.08)
			var cy2 := float(c[1]) + float(c[3]) * (0.08 + lcg.f() * 0.08)
			_blade(out, cw, ch, ox, oy, cx2, cy2,
				float(c[2]), float(c[3]), float(c[3]), -float(c[2]), lcg)


## One leaf: two quadratic curves flattened into a polygon and rasterised with
## 2x2 supersampling so the blade edge is antialiased like the canvas fill.
static func _blade(out: PackedByteArray, cw: int, ch: int, ox: int, oy: int,
		pu: float, pv: float, nx: float, ny: float, tx: float, ty: float, lcg: Lcg) -> void:
	var ln := 0.10 + lcg.f() * 0.12
	var wid := 0.024 + lcg.f() * 0.026
	var bend := (lcg.f() - 0.5) * ln * 0.55
	var px := (pu - pv) * BAKE * 0.5 - ox
	var py := (pu + pv) * BAKE * 0.25 - oy

	var dx := (nx * ln - ny * ln) * BAKE * 0.5
	var dy := (nx * ln + ny * ln) * BAKE * 0.25
	var bx := px + dx + (tx * bend - ty * bend) * BAKE * 0.5
	var by := py + dy + (tx * bend + ty * bend) * BAKE * 0.25
	var lx := px - (tx * wid * 0.5 - ty * wid * 0.5) * BAKE * 0.5
	var ly := py - (tx * wid * 0.5 + ty * wid * 0.5) * BAKE * 0.25
	var rx := px + (tx * wid * 0.5 - ty * wid * 0.5) * BAKE * 0.5
	var ry := py + (tx * wid * 0.5 + ty * wid * 0.5) * BAKE * 0.25
	var c1x := px + dx * 0.55 + (tx * (bend * 0.3 + wid * 0.7) - ty * (bend * 0.3 + wid * 0.7)) * BAKE * 0.5
	var c1y := py + dy * 0.55 + (tx * (bend * 0.3 + wid * 0.7) + ty * (bend * 0.3 + wid * 0.7)) * BAKE * 0.25
	var c2x := px + dx * 0.55 + (tx * (bend * 0.3 - wid * 0.7) - ty * (bend * 0.3 - wid * 0.7)) * BAKE * 0.5
	var c2y := py + dy * 0.55 + (tx * (bend * 0.3 - wid * 0.7) + ty * (bend * 0.3 - wid * 0.7)) * BAKE * 0.25
	var col: Color = FRINGE[int(lcg.f() * 3.0) % 3]

	var pts := PackedVector2Array()
	_quad(pts, Vector2(lx, ly), Vector2(c1x, c1y), Vector2(bx, by))
	_quad(pts, Vector2(bx, by), Vector2(c2x, c2y), Vector2(rx, ry))
	var minx := maxi(0, int(floor(minf(minf(lx, rx), bx))) - 1)
	var maxx := mini(cw - 1, int(ceil(maxf(maxf(lx, rx), bx))) + 1)
	var miny := maxi(0, int(floor(minf(minf(ly, ry), by))) - 1)
	var maxy := mini(ch - 1, int(ceil(maxf(maxf(ly, ry), by))) + 1)
	for yy in range(miny, maxy + 1):
		for xx in range(minx, maxx + 1):
			var cov := 0.0
			if _inside(pts, float(xx) + 0.25, float(yy) + 0.25):
				cov += 0.25
			if _inside(pts, float(xx) + 0.75, float(yy) + 0.25):
				cov += 0.25
			if _inside(pts, float(xx) + 0.25, float(yy) + 0.75):
				cov += 0.25
			if _inside(pts, float(xx) + 0.75, float(yy) + 0.75):
				cov += 0.25
			if cov <= 0.0:
				continue
			_blend(out, (yy * cw + xx) * 4, col, cov)


static func _quad(pts: PackedVector2Array, p0: Vector2, p1: Vector2, p2: Vector2) -> void:
	for i in range(9):
		var t := float(i) / 8.0
		var mt := 1.0 - t
		pts.append(p0 * mt * mt + p1 * 2.0 * mt * t + p2 * t * t)


static func _inside(pts: PackedVector2Array, x: float, y: float) -> bool:
	var n := pts.size()
	var inside := false
	var j := n - 1
	for i in range(n):
		var a := pts[i]
		var b := pts[j]
		if ((a.y > y) != (b.y > y)) and (x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x):
			inside = not inside
		j = i
	return inside


static func _blend(out: PackedByteArray, o: int, c: Color, cov: float) -> void:
	var ad := float(out[o + 3]) / 255.0
	var ao := cov + ad * (1.0 - cov)
	if ao <= 0.0:
		return
	var cr := c.r * 255.0
	var cg := c.g * 255.0
	var cb := c.b * 255.0
	out[o] = int((cr * cov + float(out[o]) * ad * (1.0 - cov)) / ao)
	out[o + 1] = int((cg * cov + float(out[o + 1]) * ad * (1.0 - cov)) / ao)
	out[o + 2] = int((cb * cov + float(out[o + 2]) * ad * (1.0 - cov)) / ao)
	out[o + 3] = int(ao * 255.0)


static func _tile(bx: int, by: int, rot: int) -> Image:
	if _base_tile == null:
		var tex := load("res://assets/textures/plot_grass.png") as Texture2D
		var base := tex.get_image()
		base.convert(Image.FORMAT_RGBA8)
		var size := TEX_CELLS * BAKE
		base.resize(size, size, Image.INTERPOLATE_BILINEAR)
		_base_tile = base
	var img := _base_tile.duplicate() as Image
	var r := ((bx * 7) ^ (by * 13) ^ rot) & 3
	for i in range(r):
		img.rotate_90(CLOCKWISE)
	return img
