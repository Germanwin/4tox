class_name ToxPathfinder
extends RefCounted

## Grid A* used by villagers, warriors and the bot. Four directions, no
## corner cutting, with a cached navigation map rebuilt when the world changes.

const DIRS := [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]

static func nav_map(world: ToxWorld, buildings: Array) -> Dictionary:
	var key := "%d:%d" % [world.build_rev, buildings.size()]
	var cached: Dictionary = world.get_meta("nav", {})
	if not cached.is_empty() and cached.get("key", "") == key:
		return cached
	var solid := {}
	for o in world.objects:
		if o.get("removed", false):
			continue
		if o.get("kind", "") == "tree" or (o.get("kind", "") == "stone" and o.get("variant", "") != "pebble"):
			solid[Vector2i(floori(float(o.x)), floori(float(o.y)))] = true
	for b in buildings:
		if b == null or b.get("rubble", false):
			continue
		if ToxBuildings.type_of(b) == "warcamp":
			for c in ToxBuildings.model_cells(b):
				solid[c] = true
		else:
			for c in ToxBuildings.cells(b):
				solid[c] = true
	var map := {"key": key, "solid": solid}
	world.set_meta("nav", map)
	return map

static func is_walkable(world: ToxWorld, nav: Dictionary, cell: Vector2i) -> bool:
	if not world.walkable_cell(cell.x, cell.y):
		return false
	return not nav.solid.has(cell)

static func nearest_walkable(world: ToxWorld, nav: Dictionary, cell: Vector2i, max_r: int = 8) -> Vector2i:
	if is_walkable(world, nav, cell):
		return cell
	for r in range(1, max_r + 1):
		for dy in range(-r, r + 1):
			for dx in range(-r, r + 1):
				if maxi(abs(dx), abs(dy)) != r:
					continue
				var c := cell + Vector2i(dx, dy)
				if is_walkable(world, nav, c):
					return c
	return Vector2i(-1, -1)

static func find_path(world: ToxWorld, buildings: Array, start: Vector2i, goal: Vector2i, allow_blocked_goal: bool = false) -> Array[Vector2i]:
	var nav := nav_map(world, buildings)
	var goal_cell := goal
	if not is_walkable(world, nav, goal_cell):
		if allow_blocked_goal:
			goal_cell = nearest_walkable(world, nav, goal, 3)
		else:
			goal_cell = nearest_walkable(world, nav, goal, 6)
	if goal_cell.x < 0:
		return []
	var start_cell := nearest_walkable(world, nav, start, 8)
	if start_cell.x < 0:
		return []
	if start_cell == goal_cell:
		return [goal_cell]
	var open: Array[Vector2i] = [start_cell]
	var came := {}
	var g := {start_cell: 0.0}
	var f := {start_cell: float(abs(goal_cell.x - start_cell.x) + abs(goal_cell.y - start_cell.y))}
	var closed := {}
	while not open.is_empty():
		var best_i := 0
		var best_f: float = f[open[0]]
		for i in range(1, open.size()):
			var fi: float = f.get(open[i], INF)
			if fi < best_f:
				best_f = fi
				best_i = i
		var cur: Vector2i = open[best_i]
		if cur == goal_cell:
			var path: Array[Vector2i] = []
			var node := cur
			while node != start_cell:
				path.append(node)
				node = came.get(node, start_cell)
			path.reverse()
			return path
		open.remove_at(best_i)
		closed[cur] = true
		var base_g: float = g.get(cur, INF)
		for d in DIRS:
			var nb: Vector2i = cur + d
			if closed.has(nb) or not is_walkable(world, nav, nb):
				continue
			var ng := base_g + 1.0
			if ng < float(g.get(nb, INF)):
				g[nb] = ng
				came[nb] = cur
				f[nb] = ng + float(abs(goal_cell.x - nb.x) + abs(goal_cell.y - nb.y))
				if not open.has(nb):
					open.append(nb)
	return []

static func random_walkable_near(world: ToxWorld, buildings: Array, anchor: Vector2, radius: float, rng: ToxRNG, tries: int = 24) -> Vector2i:
	var nav := nav_map(world, buildings)
	for _i in range(tries):
		var angle := rng.range_f(0.0, TAU)
		var r := sqrt(rng.next_float()) * radius
		var c := Vector2i(floori(anchor.x + cos(angle) * r), floori(anchor.y + sin(angle) * r))
		if is_walkable(world, nav, c):
			return c
	return nearest_walkable(world, nav, Vector2i(floori(anchor.x), floori(anchor.y)), 10)

static func line_clear(world: ToxWorld, buildings: Array, a: Vector2, b: Vector2) -> bool:
	var nav := nav_map(world, buildings)
	var steps := int(maxf(absf(b.x - a.x), absf(b.y - a.y)) * 3.0) + 1
	for i in range(steps + 1):
		var t := float(i) / float(steps)
		var p := a.lerp(b, t)
		var c := Vector2i(floori(p.x), floori(p.y))
		if not is_walkable(world, nav, c):
			return false
	return true

static func smooth(path: Array[Vector2i], world: ToxWorld, buildings: Array) -> Array[Vector2i]:
	if path.size() < 3:
		return path
	var out: Array[Vector2i] = []
	var i := 0
	while i < path.size():
		out.append(path[i])
		var j := path.size() - 1
		var advanced := false
		while j > i + 1:
			if line_clear(world, buildings, Vector2(path[i]) + Vector2(0.5, 0.5), Vector2(path[j]) + Vector2(0.5, 0.5)):
				out.append(path[j])
				i = j
				advanced = true
				break
			j -= 1
		if not advanced:
			i += 1
	return out
