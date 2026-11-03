class_name ToxWorldGen
extends RefCounted

## Island generation, a Godot port of mapgen2/js/worldgen.js.
## The shape is the same cellular automaton family: radial envelope + three
## harmonics + fBm, a water quantile, one landmass, beaches and shallow water.

const T := {"DEEP": 0, "WATER": 1, "SHALLOW": 2, "SAND": 3, "GRASS": 4}
const T_DEEP := 0
const T_WATER := 1
const T_SHALLOW := 2
const T_SAND := 3
const T_GRASS := 4

const DEFAULTS := {
	"seed": "тихая-долина-701",
	"size": 64,
	"land": 0.62,
	"coast": 0.5,
	"forest": 0.5,
	"rock": 0.5,
	"trees": 0.45,
	"rocks": 0.6,
	"sea": null
}

const TREE_VARIANTS := ["oak", "pine", "birch", "autumn"]
const TREE_WEIGHTS := [5.0, 3.4, 2.2, 1.0]

static func clampf01(v: float) -> float:
	return clampf(v, 0.0, 1.0)

static func smoothstep(a: float, b: float, x: float) -> float:
	var t := clampf01((x - a) / (b - a if absf(b - a) > 1e-9 else 1e-6))
	return t * t * (3.0 - 2.0 * t)

static func _noise(seed_value: int, freq: float, octaves: int, kind: int = FastNoiseLite.TYPE_SIMPLEX_SMOOTH) -> FastNoiseLite:
	var n := FastNoiseLite.new()
	n.noise_type = kind
	n.seed = seed_value
	n.frequency = freq
	n.fractal_type = FastNoiseLite.FRACTAL_FBM
	n.fractal_octaves = octaves
	n.fractal_lacunarity = 2.0
	n.fractal_gain = 0.5
	return n

static func _noise01(n: FastNoiseLite, x: float, y: float) -> float:
	return n.get_noise_2d(x, y) * 0.5 + 0.5

static func generate(user_params: Dictionary = {}) -> ToxWorld:
	var t0 := Time.get_ticks_msec()
	var p := DEFAULTS.duplicate()
	for k in user_params.keys():
		if user_params[k] != null:
			p[k] = user_params[k]
	var GW: int = maxi(24, int(round(float(p.size))))
	var GH := GW
	var N := GW * GH
	var rng := ToxRNG.new(str(p.seed))
	var S := rng.seed

	var cx := 0.5
	var cy := 0.5
	var shape_seed := (S ^ 0x51ed2701) & 0xFFFFFFFF
	var coast_seed := (S ^ 0x1b873593) & 0xFFFFFFFF
	var edge_seed := (S ^ 0x2545f491) & 0xFFFFFFFF
	var cont_seed := (S ^ 0x27d4eb2d) & 0xFFFFFFFF
	var grove_seed := (S ^ 0x85ebca6b) & 0xFFFFFFFF
	var lobe_seed := (S ^ 0x68e31da4) & 0xFFFFFFFF
	var forest_seed := (S ^ 0x7feb352d) & 0xFFFFFFFF
	var stone_seed := (S ^ 0x165667b1) & 0xFFFFFFFF
	var moist_seed := (S ^ 0x9e3779b1) & 0xFFFFFFFF

	var lw1 := 0.55 + ToxNoise.hash2i(1, 0, lobe_seed) * 0.75
	var lw2 := 0.55 + ToxNoise.hash2i(2, 0, lobe_seed) * 0.75
	var lw3 := 0.55 + ToxNoise.hash2i(3, 0, lobe_seed) * 0.75
	var lw_sum := lw1 + lw2 + lw3
	var lph1 := ToxNoise.hash2i(4, 0, lobe_seed) * TAU
	var lph2 := ToxNoise.hash2i(5, 0, lobe_seed) * TAU
	var lph3 := ToxNoise.hash2i(6, 0, lobe_seed) * TAU

	var coast: float = float(p.coast)
	var A_CONT := 0.90 * coast
	var A_LOBE := 0.50 * coast
	var A_WARP := 0.26 * coast
	var A_RIDGE := 0.26 * coast
	var A_EDGE := 0.05 * coast
	var A_FINE := 0.32 * coast

	var kWarp := 1.4 / GW
	var kCont := 3.3 / GW
	var kCoast := 1.8 / GW
	var kEdge := 6.0 / GW
	var kFine := 16.0 / GW
	var kForest := (9.5 * 1.15) / GW
	var kGrove := (18.0 * 1.15) / GW
	var kStone := 9.0 / GW
	var kMoist := 3.0 / GW

	var n_cont := _noise(cont_seed, kCont, 4)
	var n_ridge := _noise(coast_seed, kCoast, 3, FastNoiseLite.TYPE_SIMPLEX)
	var n_edge := _noise(edge_seed, kEdge, 3)
	var n_fine := _noise((edge_seed + 33) & 0xFFFFFFFF, kFine, 3)
	var n_forest := _noise(forest_seed, kForest, 4)
	var n_grove := _noise(grove_seed, kGrove, 3)
	var n_stone := _noise(stone_seed, kStone, 3, FastNoiseLite.TYPE_SIMPLEX)
	var n_moist := _noise(moist_seed, kMoist, 3)
	var n_warp_x := _noise(shape_seed, kWarp, 3)
	var n_warp_y := _noise((shape_seed + 77) & 0xFFFFFFFF, kWarp, 3)
	var n_dapple := _noise((S ^ 0x9e3779b1) & 0xFFFFFFFF, 20.0 / GW, 3)

	var height_field := PackedFloat32Array()
	height_field.resize(N)
	var forest_field := PackedFloat32Array()
	forest_field.resize(N)
	var stony_field := PackedFloat32Array()
	stony_field.resize(N)
	var moisture := PackedFloat32Array()
	moisture.resize(N)

	for y in range(GH):
		for x in range(GW):
			var i := y * GW + x
			var u := ((float(x) + 0.5) / GW - cx) * 2.0
			var v := ((float(y) + 0.5) / GH - cy) * 2.0
			var ox := (n_warp_x.get_noise_2d(x, y)) * A_WARP
			var oy := (n_warp_y.get_noise_2d(x, y)) * A_WARP
			var uu := u + ox
			var vv := v + oy
			var rr := sqrt(uu * uu + vv * vv)
			var env := 1.0 - smoothstep(0.55, 1.05, rr)
			var lobe := 0.0
			if A_LOBE > 0.0:
				var th := atan2(vv, uu)
				lobe = (lw1 * cos(2.0 * th + lph1) + lw2 * cos(3.0 * th + lph2) + lw3 * cos(5.0 * th + lph3)) / lw_sum
			var cont := (n_cont.get_noise_2d(x, y)) * 0.5 if A_CONT > 0.0 else 0.0
			var base := 0.08 + env * 0.50 + cont * A_CONT + lobe * A_LOBE
			var envelope := minf(1.0, env * 6.0)
			var ridge := (1.0 - absf(n_ridge.get_noise_2d(x, y))) - 0.42
			var edge := (n_edge.get_noise_2d(x, y)) * 0.5
			var fine := (n_fine.get_noise_2d(x, y)) * 0.5
			height_field[i] = base + (ridge * A_RIDGE + edge * A_EDGE + fine * A_FINE) * envelope
			forest_field[i] = (n_forest.get_noise_2d(x, y) * 0.5 + 0.5) * 0.7 + (n_grove.get_noise_2d(x, y) * 0.5 + 0.5) * 0.3
			stony_field[i] = 1.0 - absf(n_stone.get_noise_2d(x, y))
			moisture[i] = n_moist.get_noise_2d(x, y) * 0.5 + 0.5

	# Two box passes remove single-cell salt-and-pepper on the coast.
	height_field = _box_blur(height_field, GW, GH, 2)

	var rim: int = maxi(1, int(round(GW / 50.0)))
	var inner_area := (GW - 2 * rim) * (GH - 2 * rim)
	var rim_max_land := clampf01(float(inner_area) / N * 0.99)
	for y in range(GH):
		for x in range(GW):
			if x < rim or y < rim or x >= GW - rim or y >= GH - rim:
				height_field[y * GW + x] = 0.0

	var h_min := INF
	var h_max := -INF
	for hv in height_field:
		h_min = minf(h_min, hv)
		h_max = maxf(h_max, hv)
	if not (h_max > h_min):
		h_max = h_min + 1e-6
	var h_span := h_max - h_min
	var bins := 2048
	var hist := PackedInt32Array()
	hist.resize(bins)
	for hv in height_field:
		var b := clampi(int(floor((hv - h_min) / h_span * bins)), 0, bins - 1)
		hist[b] += 1
	var land_share := clampf(float(p.land), 0.15, rim_max_land)
	var target := clampf01(1.0 - land_share) * N
	var run := 0
	var water_threshold := h_max
	for b in range(bins):
		run += hist[b]
		if run >= target:
			water_threshold = h_min + (float(b) / bins) * h_span
			break

	var is_land := PackedByteArray()
	is_land.resize(N)
	for i in range(N):
		is_land[i] = 1 if (height_field[i] > water_threshold and height_field[i] > 0.02) else 0
	_keep_largest_component(is_land, GW, GH)
	_fill_enclosed_water(is_land, GW, GH)

	var land_count := 0
	var elevation := PackedFloat32Array()
	elevation.resize(N)
	for i in range(N):
		if is_land[i] == 0:
			elevation[i] = 0.0
			continue
		land_count += 1
		var el := clampf01((height_field[i] - water_threshold) / maxf(1e-4, 1.0 - water_threshold))
		elevation[i] = maxf(0.02, el)

	var dist_land := _distance_from(is_land, GW, GH, 1)
	var water_mask := PackedByteArray()
	water_mask.resize(N)
	for i in range(N):
		water_mask[i] = 0 if is_land[i] == 1 else 1
	var dist_water := _distance_from(water_mask, GW, GH, 1)

	var beach_w := 1.3
	var shallow_w := 2.6
	var tile := PackedByteArray()
	tile.resize(N)
	for i in range(N):
		if is_land[i] == 1:
			tile[i] = T_SAND if dist_water[i] <= beach_w else T_GRASS
		else:
			var d := dist_land[i]
			tile[i] = T_SHALLOW if d <= shallow_w else (T_WATER if d <= shallow_w * 2.4 else T_DEEP)

	# Forest/stony cut by quantiles on land.
	var land_values: Array[float] = []
	var stone_values: Array[float] = []
	for i in range(N):
		if is_land[i] == 1:
			land_values.append(forest_field[i])
			stone_values.append(stony_field[i])
	land_values.sort()
	stone_values.sort()
	var forest_share := 0.25
	if p.has("forest"):
		forest_share = clampf(float(p.forest) * 0.50, 0.0, 0.40)
	var rock_share := clampf(float(p.rock) * 0.075, 0.0, 0.12)
	var forest_cut := INF
	var forest_max := 1.0
	if land_values.size() > 2 and forest_share > 0.0:
		forest_cut = land_values[clampi(int(floor((1.0 - forest_share) * (land_values.size() - 1))), 0, land_values.size() - 1)]
		forest_max = land_values[land_values.size() - 1]
	else:
		forest_cut = 1.0
		forest_max = 1.0
	var rock_cut := INF
	var rock_max := 1.0
	if stone_values.size() > 2 and rock_share > 0.0:
		rock_cut = stone_values[clampi(int(floor((1.0 - rock_share) * (stone_values.size() - 1))), 0, stone_values.size() - 1)]
		rock_max = stone_values[stone_values.size() - 1]
	else:
		rock_cut = 1.0
		rock_max = 1.0

	var forestness := PackedFloat32Array()
	forestness.resize(N)
	var stonyness := PackedFloat32Array()
	stonyness.resize(N)
	var fertility := PackedFloat32Array()
	fertility.resize(N)
	var f_scale := 1.0 / maxf(1e-4, forest_max - forest_cut)
	var s_scale := 1.0 / maxf(1e-4, rock_max - rock_cut)
	for i in range(N):
		if is_land[i] == 0:
			continue
		forestness[i] = clampf01((forest_field[i] - forest_cut) * f_scale)
		stonyness[i] = clampf01((stony_field[i] - rock_cut) * s_scale)
		fertility[i] = clampf01(0.35 + moisture[i] * 0.4 + (1.0 - forestness[i]) * 0.25 - stonyness[i] * 0.35)

	# Pad with sea. The original game also adds a margin of deep water so the
	# shallows finish inside the map.
	var sea: int = int(p.sea) if p.sea != null else maxi(4, 8 - rim)
	var W := GW + 2 * sea
	var H := GH + 2 * sea
	var world := ToxWorld.new()
	world.width = W
	world.height = H
	world.seed_text = str(p.seed)
	world.seed_int = S
	world.params = p.duplicate()
	world.sea = sea
	world.rim = rim
	world.island_size = GW
	world.tile = PackedByteArray()
	world.tile.resize(W * H)
	world.is_land = PackedByteArray()
	world.is_land.resize(W * H)
	world.height_field = PackedFloat32Array()
	world.height_field.resize(W * H)
	world.elevation = PackedFloat32Array()
	world.elevation.resize(W * H)
	world.forestness = PackedFloat32Array()
	world.forestness.resize(W * H)
	world.stonyness = PackedFloat32Array()
	world.stonyness.resize(W * H)
	world.moisture = PackedFloat32Array()
	world.moisture.resize(W * H)
	world.fertility = PackedFloat32Array()
	world.fertility.resize(W * H)
	for y in range(GH):
		for x in range(GW):
			var src := y * GW + x
			var dst := (y + sea) * W + (x + sea)
			world.is_land[dst] = is_land[src]
			world.height_field[dst] = height_field[src]
			world.elevation[dst] = elevation[src]
			world.forestness[dst] = forestness[src]
			world.stonyness[dst] = stonyness[src]
			world.moisture[dst] = moisture[src]
			world.fertility[dst] = fertility[src]
	world.dist_land = _distance_from(world.is_land, W, H, 1)
	var full_water := PackedByteArray()
	full_water.resize(W * H)
	for i in range(W * H):
		full_water[i] = 0 if world.is_land[i] == 1 else 1
	world.dist_water = _distance_from(full_water, W, H, 1)
	for i in range(W * H):
		if world.is_land[i] == 1:
			world.tile[i] = T_SAND if world.dist_water[i] <= beach_w else T_GRASS
		else:
			var d2 := world.dist_land[i]
			world.tile[i] = T_SHALLOW if d2 <= shallow_w else (T_WATER if d2 <= shallow_w * 2.4 else T_DEEP)
	world.land_bounds = _land_bounds(world.is_land, W, H)

	# Objects, sorted by depth once.
	place_objects(world, rng, n_dapple)
	world.objects.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return (a.x + a.y) < (b.x + b.y))
	for i in world.objects.size():
		world.objects[i].id = i
	world.object_total = world.objects.size()

	var stats := {
		"tiles": W * H, "landTiles": land_count, "landShare": float(land_count) / float(GW * GH),
		"water": 0, "sand": 0, "grass": 0, "trees": 0, "rocks": 0,
		"smallRocks": 0, "mineable": 0, "decor": 0
	}
	for i in range(W * H):
		var tv := world.tile[i]
		if tv == T_GRASS:
			stats.grass += 1
		elif tv == T_SAND:
			stats.sand += 1
		else:
			stats.water += 1
	for o in world.objects:
		if o.kind == "tree":
			stats.trees += 1
		elif o.get("mineable", false):
			stats.rocks += 1
			stats.mineable += 1
		elif o.kind == "stone":
			stats.smallRocks += 1
		else:
			stats.decor += 1
	stats["genTimeMs"] = Time.get_ticks_msec() - t0
	world.stats = stats
	world.time = 0.0
	return world

static func _box_blur(src: PackedFloat32Array, w: int, h: int, passes: int) -> PackedFloat32Array:
	var cur := src
	for _pass in range(passes):
		var out := PackedFloat32Array()
		out.resize(w * h)
		for y in range(h):
			for x in range(w):
				var total := 0.0
				var count := 0
				for dy in range(-1, 2):
					var yy := y + dy
					if yy < 0 or yy >= h:
						continue
					for dx in range(-1, 2):
						var xx := x + dx
						if xx < 0 or xx >= w:
							continue
						total += cur[yy * w + xx]
						count += 1
				out[y * w + x] = total / float(count)
		cur = out
	return cur

static func _keep_largest_component(is_land: PackedByteArray, w: int, h: int) -> void:
	var n := w * h
	var label := PackedInt32Array()
	label.resize(n)
	var best := -1
	var best_size := 0
	var cur := 0
	var stack := PackedInt32Array()
	stack.resize(n)
	for s in n:
		if is_land[s] == 0 or label[s] != 0:
			continue
		cur += 1
		var sp := 0
		var count := 0
		stack[sp] = s
		sp += 1
		label[s] = cur
		while sp > 0:
			sp -= 1
			var i := stack[sp]
			count += 1
			var x := i % w
			var y := int(i / w)
			if x > 0 and is_land[i - 1] == 1 and label[i - 1] == 0:
				label[i - 1] = cur
				stack[sp] = i - 1
				sp += 1
			if x < w - 1 and is_land[i + 1] == 1 and label[i + 1] == 0:
				label[i + 1] = cur
				stack[sp] = i + 1
				sp += 1
			if y > 0 and is_land[i - w] == 1 and label[i - w] == 0:
				label[i - w] = cur
				stack[sp] = i - w
				sp += 1
			if y < h - 1 and is_land[i + w] == 1 and label[i + w] == 0:
				label[i + w] = cur
				stack[sp] = i + w
				sp += 1
		if count > best_size:
			best_size = count
			best = cur
	if best < 0:
		return
	for i in n:
		if is_land[i] == 1 and label[i] != best:
			is_land[i] = 0

static func _fill_enclosed_water(is_land: PackedByteArray, w: int, h: int) -> void:
	var n := w * h
	var seen := PackedByteArray()
	seen.resize(n)
	var q := PackedInt32Array()
	q.resize(n)
	var head := 0
	var tail := 0
	for x in range(w):
		for yv in [0, h - 1]:
			var i: int = int(yv) * w + x
			if is_land[i] == 0 and seen[i] == 0:
				seen[i] = 1
				q[tail] = i
				tail += 1
	for y in range(h):
		for xv in [0, w - 1]:
			var i: int = y * w + int(xv)
			if is_land[i] == 0 and seen[i] == 0:
				seen[i] = 1
				q[tail] = i
				tail += 1
	while head < tail:
		var i := q[head]
		head += 1
		var x := i % w
		var y := int(i / w)
		if x > 0 and is_land[i - 1] == 0 and seen[i - 1] == 0:
			seen[i - 1] = 1
			q[tail] = i - 1
			tail += 1
		if x < w - 1 and is_land[i + 1] == 0 and seen[i + 1] == 0:
			seen[i + 1] = 1
			q[tail] = i + 1
			tail += 1
		if y > 0 and is_land[i - w] == 0 and seen[i - w] == 0:
			seen[i - w] = 1
			q[tail] = i - w
			tail += 1
		if y < h - 1 and is_land[i + w] == 0 and seen[i + w] == 0:
			seen[i + w] = 1
			q[tail] = i + w
			tail += 1
	for i in n:
		if is_land[i] == 0 and seen[i] == 0:
			is_land[i] = 1

static func _distance_from(mask: PackedByteArray, w: int, h: int, target: int) -> PackedFloat32Array:
	var n := w * h
	var dist := PackedFloat32Array()
	dist.resize(n)
	for i in n:
		dist[i] = -1.0
	var q := PackedInt32Array()
	q.resize(n)
	var head := 0
	var tail := 0
	for i in n:
		if mask[i] == target:
			dist[i] = 0.0
			q[tail] = i
			tail += 1
	while head < tail:
		var i := q[head]
		head += 1
		var d := dist[i] + 1.0
		var x := i % w
		var y := int(i / w)
		if x > 0 and dist[i - 1] < 0.0:
			dist[i - 1] = d
			q[tail] = i - 1
			tail += 1
		if x < w - 1 and dist[i + 1] < 0.0:
			dist[i + 1] = d
			q[tail] = i + 1
			tail += 1
		if y > 0 and dist[i - w] < 0.0:
			dist[i - w] = d
			q[tail] = i - w
			tail += 1
		if y < h - 1 and dist[i + w] < 0.0:
			dist[i + w] = d
			q[tail] = i + w
			tail += 1
	for i in n:
		if dist[i] < 0.0:
			dist[i] = 100.0
	return dist

static func _land_bounds(is_land: PackedByteArray, w: int, h: int) -> Rect2i:
	var x0 := w
	var y0 := h
	var x1 := -1
	var y1 := -1
	for y in range(h):
		for x in range(w):
			if is_land[y * w + x] == 1:
				x0 = mini(x0, x)
				y0 = mini(y0, y)
				x1 = maxi(x1, x)
				y1 = maxi(y1, y)
	if x1 < 0:
		return Rect2i(0, 0, w, h)
	return Rect2i(x0, y0, x1 - x0 + 1, y1 - y0 + 1)

static func place_objects(world: ToxWorld, rng: ToxRNG, dapple_noise: FastNoiseLite) -> void:
	var W := world.width
	var H := world.height
	var tile := world.tile
	var is_land := world.is_land
	var p := world.params
	var clear_r: int = maxi(4, int(round(world.island_size * 0.06)))
	var ccx := W * 0.5
	var ccy := H * 0.5
	var cell := 1.4
	var grid := {}
	var tree_density: float = float(p.trees) * 9.0
	var rock_density: float = float(p.rocks) * 2.4 * (1.0 + 0.22 * float(p.forest))

	var far_enough := func(px: float, py: float, min_d: float) -> bool:
		var gx := int(floor(px / cell)) + 1
		var gy := int(floor(py / cell)) + 1
		for yy in range(gy - 1, gy + 2):
			for xx in range(gx - 1, gx + 2):
				var key := Vector2i(xx, yy)
				if not grid.has(key):
					continue
				for o in grid[key]:
					var dx: float = o.x - px
					var dy: float = o.y - py
					if dx * dx + dy * dy < min_d * min_d:
						return false
		return true
	var push := func(o: Dictionary) -> void:
		var key := Vector2i(int(floor(o.x / cell)) + 1, int(floor(o.y / cell)) + 1)
		if not grid.has(key):
			grid[key] = []
		grid[key].append(o)
		world.objects.append(o)

	for y in H:
		for x in W:
			var i := y * W + x
			if is_land[i] == 0:
				continue
			var px := x + rng.range_f(0.18, 0.82)
			var py := y + rng.range_f(0.18, 0.82)
			var t := tile[i]
			var f := world.forestness[i]
			var st := world.stonyness[i]
			var near_water := world.dist_water[i]
			var in_village := Vector2(px - ccx, py - ccy).length() < clear_r
			if t == T_GRASS and near_water > 1.2 and f > 0.0 and not in_village:
				var tree_chance := tree_density * (0.03 + f * f)
				var dapple := dapple_noise.get_noise_2d(x, y) * 0.5 + 0.5
				tree_chance *= 0.40 + dapple
				if st > 0.55:
					tree_chance *= 0.12
				if rng.chance(minf(0.92, tree_chance)) and far_enough.call(px, py, 0.55):
					var weights := PackedFloat32Array([TREE_WEIGHTS[0], TREE_WEIGHTS[1] * (0.5 + f), TREE_WEIGHTS[2] * (1.3 - f * 0.6), TREE_WEIGHTS[3]])
					var vi := rng.weighted(weights)
					push.call({
						"kind": "tree", "variant": TREE_VARIANTS[vi], "x": px, "y": py,
						"scale": rng.range_f(0.88, 1.14), "phase": rng.range_f(0.0, TAU),
						"removed": false, "shake": 0.0
					})
					continue
			if t != T_SAND and st > 0.0 and not in_village:
				var stone_chance := rock_density * (0.05 + 1.5 * st * st)
				if rng.chance(minf(0.85, stone_chance)):
					var ore := st > 0.62 and rng.chance(0.22)
					var variant := ""
					if ore:
						variant = "iron" if rng.chance(0.72) else "salt"
					else:
						variant = "boulder" if rng.chance(0.45) else "rock"
					if far_enough.call(px, py, 0.5):
						push.call({
							"kind": "stone", "variant": variant, "x": px, "y": py,
							"scale": rng.range_f(0.85, 1.2), "mineable": true, "node": ore,
							"amount": rng.range_i(180, 320) if ore else rng.range_i(60, 140),
							"removed": false
						})
				elif st < 0.35 and rng.chance(0.05):
					if far_enough.call(px, py, 0.35):
						push.call({
							"kind": "stone", "variant": "pebble", "x": px, "y": py,
							"scale": rng.range_f(0.7, 1.05), "phase": rng.range_f(0.0, TAU),
							"removed": false
						})
			if t == T_GRASS and near_water > 1.4 and rng.chance(0.10):
				var roll := rng.next_float()
				var kind := "tuft" if roll < 0.5 else ("bush" if roll < 0.82 else "flower")
				var dfar := 0.30 if kind == "tuft" else 0.45
				if far_enough.call(px, py, dfar):
					push.call({
						"kind": kind,
						"variant": ("f" + str(rng.range_i(1, 3))) if kind == "flower" else null,
						"x": px, "y": py, "scale": rng.range_f(0.75, 1.15),
						"phase": rng.range_f(0.0, TAU), "removed": false
					})
			elif t == T_SAND and near_water < 2.2 and rng.chance(0.08):
				if far_enough.call(px, py, 0.3):
					push.call({
						"kind": "reed", "variant": null, "x": px, "y": py,
						"scale": rng.range_f(0.8, 1.2), "phase": rng.range_f(0.0, TAU),
						"removed": false
					})

static func find_spawn_site(world: ToxWorld, footprint: Vector2i, prefer_center: bool = true, avoid: Array = []) -> Vector2i:
	## Spiral search for a clear, flat, grass-only footprint. Returns the
	## north-west cell of the footprint or (-1,-1).
	var W := world.width
	var H := world.height
	var cx := int(W / 2)
	var cy := int(H / 2)
	var best := Vector2i(-1, -1)
	var best_score := -INF
	var max_r := maxi(W, H)
	for r in range(0, max_r, 2):
		for dy in range(-r, r + 1, 2):
			for dx in range(-r, r + 1, 2):
				if maxi(abs(dx), abs(dy)) != r:
					continue
				var bx := cx + dx - int(footprint.x / 2)
				var by := cy + dy - int(footprint.y / 2)
				if bx < 2 or by < 2 or bx + footprint.x >= W - 2 or by + footprint.y >= H - 2:
					continue
				var ok := true
				for j in footprint.y:
					for i in footprint.x:
						if world.tile[(by + j) * W + bx + i] != T_GRASS:
							ok = false
							break
					if not ok:
						break
				if not ok:
					continue
				var too_close := false
				for a in avoid:
					if abs(a.x - bx) < 8 and abs(a.y - by) < 8:
						too_close = true
						break
				if too_close:
					continue
				var score := 0.0
				if prefer_center:
					score = -Vector2(bx - cx, by - cy).length()
				else:
					score = Vector2(bx - cx, by - cy).length()
				if score > best_score:
					best_score = score
					best = Vector2i(bx, by)
		if best.x >= 0 and r > 8:
			break
	return best
