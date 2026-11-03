class_name ToxSim
extends RefCounted

## The authoritative little world: buildings, villagers, economy, training,
## combat and the enemy village. This is the gameplay port of session.js,
## villager.js, combat.js and army.js.

signal event_log(text: String)
signal toast(text: String)
signal game_over(win: bool)
signal changed
signal delivery(amount: int, camp: Dictionary)
signal town_fell(owner: int)

const TEAM_COLORS := ["#4a90d9", "#d94a4a", "#9b59b6", "#e0a030"]
const NET_MAX_PLAYERS := 4
const TRAIN_TIME := 5.0
const BIRTH_EVERY := 30.0
const SPEED := 0.63
const CARRY_SPEED := 0.52
const CHOP_TIME := 5.0
const ATTACK_UNIT := 0.8
const ATTACK_BUILDING := 1.5
const DAMAGE_UNIT := 6.0
const DAMAGE_BUILDING := 2.0
const BUILD_RANGE := 1.7
const AGGRO := 8.0
const DEFEND_R := 12.0

var world: ToxWorld
var buildings: Array = []
var villagers: Array = []
var towns: Array = []
var player_owner: int = 0
var mode: String = "solo"
var time: float = 0.0
var birth_clock: float = BIRTH_EVERY
var over: bool = false
var winner: int = -1
var rng: ToxRNG
var next_villager_id: int = 1
var events: Array = []
var bot_think: float = 0.0
var bot_attack: float = 0.0
var bot_spawn: float = 0.0
var stats := {"felled": 0, "deliveries": 0, "built": 0}
var next_build_nid: int = 1
var event_total: int = 0
var net_players: Array = []

func _init() -> void:
	rng = ToxRNG.new(1)

func start(seed_text: String, size: int, p_mode: String = "solo") -> void:
	mode = p_mode
	time = 0.0
	over = false
	winner = -1
	buildings.clear()
	villagers.clear()
	towns.clear()
	events.clear()
	next_villager_id = 1
	next_build_nid = 1
	event_total = 0
	net_players.clear()
	stats = {"felled": 0, "deliveries": 0, "built": 0}
	rng = ToxRNG.new(seed_text)
	world = ToxWorldGen.generate({"seed": seed_text, "size": size})
	world.time = 0.0
	var player := new_town(0, "Деревня")
	player.is_bot = false
	_place_village(player, false)
	_spawn_start_villagers(player, 3)
	if mode == "bot":
		var enemy := new_town(1, "Деревня 2")
		enemy.is_bot = true
		_place_enemy_village(enemy)
		_spawn_start_villagers(enemy, 2)
		enemy.logs = 100
		birth_clock = BIRTH_EVERY
	world.village = player
	world.towns = towns
	# The camera starts on the town hall, then the shell pulls back to the
	# overview — same arrival as the browser game.
	player_owner = 0
	birth_clock = BIRTH_EVERY
	emit_signal("changed")

func start_net(seed_text: String, size: int, players: Array) -> void:
	## Host-authoritative match: one island, one village per player. Both host
	## and clients run this with the same seed/players, so the terrain and the
	## starting villages are identical; the host then sends snapshots.
	mode = "net"
	time = 0.0
	over = false
	winner = -1
	buildings.clear()
	villagers.clear()
	towns.clear()
	events.clear()
	next_villager_id = 1
	next_build_nid = 1
	event_total = 0
	net_players = players.duplicate(true)
	stats = {"felled": 0, "deliveries": 0, "built": 0}
	rng = ToxRNG.new(seed_text)
	world = ToxWorldGen.generate({"seed": seed_text, "size": size})
	world.time = 0.0
	var avoid := []
	for p in net_players:
		var owner := int(p.get("owner", 0))
		var display := str(p.get("name", "Деревня"))
		if display.strip_edges().is_empty():
			display = "Деревня %d" % (owner + 1)
		var t := new_town(owner, display)
		_place_village_at(t, owner == 0, avoid)
		var th: Variant = t.get("townhall", null)
		if th != null:
			avoid.append(Vector2i(int(th.x), int(th.y)))
		_spawn_start_villagers(t, 3)
	player_owner = 0
	birth_clock = BIRTH_EVERY
	world.towns = towns
	world.village = town(player_owner)
	emit_signal("changed")

func set_player_owner(owner: int) -> void:
	player_owner = owner
	if world != null:
		world.village = town(owner)

func abandon_town(owner: int) -> void:
	## A guest left the match. Their village stays on the island as a ghost,
	## but it no longer counts as a contender, otherwise two remaining players
	## could never finish the match.
	var t := town(owner)
	if t.is_empty() or not bool(t.get("alive", true)):
		return
	t.alive = false
	_log("Деревня %d осталась без хозяина" % (owner + 1))
	emit_signal("changed")

func new_town(owner: int, town_name: String) -> Dictionary:
	var t := {
		"id": towns.size(), "owner": owner, "name": town_name,
		"color": TEAM_COLORS[owner % TEAM_COLORS.size()],
		"alive": true, "is_bot": false, "logs": 0, "deliveries": 0,
		"felled": 0, "buildings": [], "villagers": [], "townhall": null
	}
	towns.append(t)
	if owner == 0:
		world.village = t if world != null else null
	return t

func town(owner: int) -> Dictionary:
	for t in towns:
		if int(t.owner) == owner:
			return t
	return {}

func player_town() -> Dictionary:
	return town(player_owner)

func add_building(b: Dictionary, t: Dictionary = {}) -> void:
	buildings.append(b)
	var town_ref := t if not t.is_empty() else town(int(b.get("owner", 0)))
	if not town_ref.is_empty():
		town_ref.buildings.append(b)
		if ToxBuildings.type_of(b) == "townhall" and town_ref.townhall == null:
			town_ref.townhall = b
	world.build_rev += 1
	world.buildings = buildings
	emit_signal("changed")

func add_villager(v: ToxVillager, t: Dictionary = {}) -> void:
	v.owner = int(t.get("owner", v.owner))
	if not t.is_empty():
		t.villagers.append(v)
		if v.home_id < 0:
			var house := find_house(t)
			if house != null:
				v.home_id = _id_of(house)
	villagers.append(v)
	world.villagers = villagers
	emit_signal("changed")

func _id_of(b: Variant) -> int:
	if b == null:
		return -1
	return int(b.get("_nid", -1))

func bld(id: int) -> Variant:
	for b in buildings:
		if int(b.get("_nid", -1)) == id and not b.get("rubble", false):
			return b
	return null

func bld_any(id: int) -> Variant:
	for b in buildings:
		if int(b.get("_nid", -1)) == id:
			return b
	return null

func type_buildings(t: Dictionary, type: String) -> Array:
	var out := []
	for b in t.get("buildings", []):
		if b != null and not b.get("rubble", false) and ToxBuildings.type_of(b) == type:
			out.append(b)
	return out

func town_of_villager(v: ToxVillager) -> Dictionary:
	return town(v.owner)

func find_house(t: Dictionary) -> Variant:
	for b in t.get("buildings", []):
		if b != null and not b.get("rubble", false) and ToxBuildings.type_of(b) == "house":
			return b
	return null

func residents(t: Dictionary) -> Array:
	var out := []
	for v in villagers:
		if v.owner == int(t.owner) and not v.dead:
			out.append(v)
	return out

func housing_free(t: Dictionary) -> int:
	var cap := 0
	for b in t.get("buildings", []):
		if b != null and not b.get("rubble", false):
			cap += ToxBuildings.housing(b)
	var used := 0
	for v in villagers:
		if v.owner == int(t.owner) and not v.dead:
			used += 1
	return maxi(0, cap - used)

func next_name(owner: int) -> String:
	var n := 1
	for v in villagers:
		if v.owner == owner:
			n += 1
	return "Житель №%d" % n

func _base_villager(owner: int) -> ToxVillager:
	var v := ToxVillager.new(int(rng.next_float() * 1000000.0) + next_villager_id * 97)
	v.id = next_villager_id
	next_villager_id += 1
	v.owner = owner
	v.name = next_name(owner)
	v.speed = SPEED
	v.hp = 15.0
	v.max_hp = 15.0
	return v

func _spawn_at(owner: int, home_id: int, cell: Vector2i, appear: bool = true) -> ToxVillager:
	var v := _base_villager(owner)
	v.home_id = home_id
	var nav := ToxPathfinder.nav_map(world, buildings)
	var c := ToxPathfinder.nearest_walkable(world, nav, cell, 10)
	if c.x < 0:
		c = cell
	v.x = float(c.x) + 0.5
	v.y = float(c.y) + 0.5
	v.anchor = Vector2(v.x, v.y)
	v.state = "wander"
	v.wait_t = rng.range_f(0.2, 2.5)
	v.appear_t = 0.5 if appear else 0.0
	add_villager(v, town(owner))
	return v

func _spawn_start_villagers(t: Dictionary, count: int) -> void:
	var house := find_house(t)
	var spot := Vector2i(int(world.width / 2), int(world.height / 2))
	if house != null:
		spot = ToxBuildings.front_spot(house, 1)
	for i in range(count):
		var c := spot + Vector2i(i % 3, int(i / 3))
		_spawn_at(int(t.owner), _id_of(house), c, true)

func _place_village(t: Dictionary, _is_enemy: bool) -> void:
	_place_village_at(t, true, [])

func _place_village_at(t: Dictionary, prefer_center: bool, avoid: Array) -> void:
	var th_fp := ToxBuildings.footprint(ToxBuildings.FACE_ROT, "townhall")
	var th_pos := ToxWorldGen.find_spawn_site(world, th_fp, prefer_center, avoid)
	if th_pos.x < 0:
		th_pos = _far_site(th_fp)
	if th_pos.x < 0:
		th_pos = Vector2i(world.width / 2 - 2, world.height / 2 - 2)
	var th := ToxBuildings.make("townhall", "c", ToxBuildings.FACE_ROT, th_pos.x, th_pos.y, int(t.owner))
	_add_nid(th)
	ToxBuildings.settle(world, th, true)
	add_building(th, t)
	t.townhall = th
	var center_cell := Vector2i(th.x + 2, th.y + 2)
	var house := ToxBuildings.find_site(world, buildings, "house", "a", ToxBuildings.FACE_ROT, center_cell, 14, false, villagers)
	if house.is_empty():
		house = ToxBuildings.make("house", "a", ToxBuildings.FACE_ROT, th.x + 4, th.y, int(t.owner))
	_add_nid(house)
	house.owner = int(t.owner)
	ToxBuildings.settle(world, house, true)
	add_building(house, t)
	var camp := ToxBuildings.find_site(world, buildings, "lumbercamp", "a", ToxBuildings.FACE_ROT, center_cell, 16, false, villagers)
	if camp.is_empty():
		camp = ToxBuildings.make("lumbercamp", "a", ToxBuildings.FACE_ROT, th.x - 3, th.y + 2, int(t.owner))
	_add_nid(camp)
	camp.owner = int(t.owner)
	ToxBuildings.settle(world, camp, true)
	add_building(camp, t)

func _place_enemy_village(t: Dictionary) -> void:
	var th_pos := _far_site(Vector2i(3, 4))
	if th_pos.x < 0:
		th_pos = Vector2i(8, 8)
	var th := ToxBuildings.make("townhall", "c", ToxBuildings.FACE_ROT, th_pos.x, th_pos.y, int(t.owner))
	_add_nid(th)
	ToxBuildings.settle(world, th, true)
	add_building(th, t)
	t.townhall = th
	var center_cell := Vector2i(th.x + 2, th.y + 2)
	var house := ToxBuildings.find_site(world, buildings, "house", "a", ToxBuildings.FACE_ROT, center_cell, 14, false, villagers)
	if house.is_empty():
		house = ToxBuildings.make("house", "a", ToxBuildings.FACE_ROT, th.x + 4, th.y, int(t.owner))
	_add_nid(house)
	house.owner = int(t.owner)
	ToxBuildings.settle(world, house, true)
	add_building(house, t)
	var camp := ToxBuildings.find_site(world, buildings, "lumbercamp", "a", ToxBuildings.FACE_ROT, center_cell, 16, false, villagers)
	if camp.is_empty():
		camp = ToxBuildings.make("lumbercamp", "a", ToxBuildings.FACE_ROT, th.x - 3, th.y + 2, int(t.owner))
	_add_nid(camp)
	camp.owner = int(t.owner)
	ToxBuildings.settle(world, camp, true)
	add_building(camp, t)
	for type in ["barracks", "warcamp"]:
		var b := ToxBuildings.find_site(world, buildings, type, "a" if type == "barracks" else "x", ToxBuildings.FACE_ROT, center_cell, 22, false, villagers)
		if not b.is_empty():
			b.owner = int(t.owner)
			_add_nid(b)
			ToxBuildings.settle(world, b, true)
			add_building(b, t)

func _add_nid(b: Dictionary) -> void:
	b["_nid"] = next_build_nid
	next_build_nid += 1

func _far_site(fp: Vector2i) -> Vector2i:
	var best := Vector2i(-1, -1)
	var best_d := -1.0
	var player_th: Variant = town(0).get("townhall", null)
	var pc := Vector2(world.width * 0.5, world.height * 0.5)
	if player_th != null:
		pc = Vector2(player_th.x, player_th.y)
	for y in range(4, world.height - fp.y - 4, 3):
		for x in range(4, world.width - fp.x - 4, 3):
			var ok := true
			for j in range(fp.y):
				for i in range(fp.x):
					if world.tile[(y + j) * world.width + x + i] != ToxWorldGen.T_GRASS:
						ok = false
						break
				if not ok:
					break
			if not ok:
				continue
			var d := Vector2(x - pc.x, y - pc.y).length()
			if d > best_d:
				best_d = d
				best = Vector2i(x, y)
	return best

# ---------------------------------------------------------------- update

func update(dt: float) -> void:
	if world == null or over:
		return
	time += dt
	world.time = time
	for b in buildings:
		if float(b.get("flinch", 0.0)) > 0.0:
			b.flinch = maxf(0.0, float(b.flinch) - dt)
	for v in villagers:
		if v.flinch > 0.0:
			v.flinch = maxf(0.0, v.flinch - dt)
	for v in villagers.duplicate():
		if not v.dead:
			_update_villager(v, dt)
	_update_birth(dt)
	if mode == "bot":
		_update_bot(dt)
	_cleanup_dead()
	_check_end()

func _update_villager(v: ToxVillager, dt: float) -> void:
	v.tick_anim(dt)
	if v.appear_t > 0.0:
		v.appear_t = maxf(0.0, v.appear_t - dt)
	if v.emerge_t > 0.0:
		v.emerge_t = maxf(0.0, v.emerge_t - dt)
	if v.hidden:
		if v.state == "training":
			v.train_t += dt
			if v.train_t >= TRAIN_TIME:
				_finish_training(v)
		return
	if v.vanish_t > 0.0:
		v.vanish_t = maxf(0.0, v.vanish_t - dt)
		if v.vanish_t <= 0.0:
			v.hidden = true
		return
	if v.state == "entering":
		_update_entering(v, dt)
		return
	if v.warrior:
		_update_warrior(v, dt)
	elif v.state == "to_barracks":
		_update_to_barracks(v, dt)
	elif v.employer_id >= 0:
		_update_worker(v, dt)
	elif v.trainee:
		_update_to_barracks(v, dt)
	else:
		_update_wander(v, dt)

func _move(v: ToxVillager, dt: float, speed: float = -1.0) -> bool:
	if v.path.is_empty():
		return true
	if v.path_i >= v.path.size():
		v.path.clear()
		v.path_i = 0
		return true
	var target := Vector2(v.path[v.path_i]) + Vector2(0.5, 0.5)
	var to := target - Vector2(v.x, v.y)
	var dist := to.length()
	var sp := (v.speed if speed < 0.0 else speed)
	var step := sp * dt
	if dist <= step + 0.03:
		v.x = target.x
		v.y = target.y
		v.path_i += 1
		if v.path_i >= v.path.size():
			v.path.clear()
			v.path_i = 0
			return true
		return false
	v.x += to.x / dist * step
	v.y += to.y / dist * step
	v.face_to(to)
	return false

func _plan(v: ToxVillager, goal: Vector2i, allow_blocked: bool = false) -> bool:
	var start := Vector2i(floori(v.x), floori(v.y))
	var p := ToxPathfinder.find_path(world, buildings, start, goal, allow_blocked)
	v.path = p
	v.path_i = 0
	v.goal = goal
	return not p.is_empty()

func _update_wander(v: ToxVillager, dt: float) -> void:
	if not v.path.is_empty():
		v.set_anim("walk")
		if _move(v, dt):
			v.wait_t = v.rng.range_f(2.0, 5.0)
			v.set_anim("idle")
		return
	v.wait_t -= dt
	v.set_anim("idle")
	if v.wait_t <= 0.0:
		v.wait_t = v.rng.range_f(2.5, 6.0)
		var c := ToxPathfinder.random_walkable_near(world, buildings, v.anchor, 10.0, v.rng)
		if c.x >= 0:
			_plan(v, c)

func _camp_work_cell(camp: Dictionary) -> Vector2i:
	var spot := ToxBuildings.front_spot(camp, 1)
	var nav := ToxPathfinder.nav_map(world, buildings)
	return ToxPathfinder.nearest_walkable(world, nav, spot, 6)

func _update_worker(v: ToxVillager, dt: float) -> void:
	var camp := bld(v.employer_id)
	if camp == null:
		if v.tree != null:
			v.tree["claimed_by"] = -1
			v.tree = null
		v.employer_id = -1
		v.state = "wander"
		v.wait_t = 0.0
		return
	var work := _camp_work_cell(camp)
	match v.state:
		"to_camp":
			v.set_anim("walk_axe")
			if v.path.is_empty():
				_plan(v, work)
			if _move(v, dt):
				v.state = "seek_tree"
				v.work_retry = 0.0
		"seek_tree":
			v.set_anim("idle")
			v.work_retry -= dt
			if v.work_retry > 0.0:
				return
			if _claim_tree(v):
				v.state = "to_tree"
			else:
				v.state = "stand"
				v.wait_t = 10.0
				_log("%s: работать негде — деревьев нет" % v.name)
		"to_tree":
			v.set_anim("walk_axe")
			if v.path.is_empty() and v.tree != null:
				var tc := Vector2i(floori(float(v.tree.x)), floori(float(v.tree.y)))
				_plan(v, tc, true)
			if _move(v, dt):
				v.state = "chop"
				v.chop_t = 0.0
				v.set_anim("work")
				if v.tree != null:
					v.face_to(Vector2(float(v.tree.x) - v.x, float(v.tree.y) - v.y))
		"chop":
			if v.tree == null or v.tree.get("removed", false):
				v.state = "seek_tree"
				return
			v.set_anim("work")
			v.chop_t += dt
			var hit_before := int(floor((v.chop_t - dt) / 0.625))
			var hit_after := int(floor(v.chop_t / 0.625))
			if hit_after > hit_before:
				v.tree["shake_until"] = time + 0.35
			if v.chop_t >= CHOP_TIME:
				ToxBuildings.chop(world, v.tree)
				var t := town_of_villager(v)
				t.felled = int(t.get("felled", 0)) + 1
				stats.felled += 1
				v.tree["claimed_by"] = -1
				v.tree = null
				v.carry = 4
				v.state = "carry"
				v.set_anim("carry")
				_plan(v, work)
		"carry":
			v.set_anim("carry")
			if v.path.is_empty():
				_plan(v, work)
			if _move(v, dt, CARRY_SPEED):
				v.state = "drop"
				v.drop_t = 0.9
				v.set_anim("carry_put")
		"drop":
			v.set_anim("carry_put")
			v.drop_t -= dt
			if v.drop_t <= 0.0:
				var t2 := town_of_villager(v)
				var delivered := v.carry
				t2.logs = int(t2.get("logs", 0)) + delivered
				t2.deliveries = int(t2.get("deliveries", 0)) + 1
				stats.deliveries += 1
				emit_signal("delivery", delivered, camp)
				v.carry = 0
				v.state = "seek_tree"
				v.set_anim("idle")
		"stand":
			v.set_anim("idle")
			v.wait_t -= dt
			if v.wait_t <= 0.0:
				v.state = "seek_tree"
		_:
			v.state = "to_camp"

func _claim_tree(v: ToxVillager) -> bool:
	var candidates := []
	for o in world.objects:
		if o.get("removed", false) or o.get("kind", "") != "tree":
			continue
		if int(o.get("claimed_by", -1)) >= 0 and int(o.get("claimed_by", -1)) != v.id:
			continue
		var d := Vector2(float(o.x) - v.x, float(o.y) - v.y).length_squared()
		if d < 2500.0:
			candidates.append([d, o])
	candidates.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])
	var tries := 0
	for pair in candidates:
		if tries >= 18:
			break
		tries += 1
		var o: Dictionary = pair[1]
		var tc := Vector2i(floori(float(o.x)), floori(float(o.y)))
		if _plan(v, tc, true):
			o["claimed_by"] = v.id
			v.tree = o
			return true
	return false

func _update_to_barracks(v: ToxVillager, dt: float) -> void:
	var b := bld(v.training_at_id)
	if b == null:
		v.trainee = false
		v.training_at_id = -1
		v.state = "wander"
		return
	var e := ToxBuildings.entrance(b)
	v.set_anim("walk")
	if v.path.is_empty():
		_plan(v, e.outCell)
	if _move(v, dt):
		v.state = "entering"
		v.enter_from = Vector2(v.x, v.y)
		v.enter_to = e["in"]
		v.enter_t = 0.0

func _update_entering(v: ToxVillager, dt: float) -> void:
	var t: float = v.enter_t + dt
	v.enter_t = t
	var k := clampf(t / 0.45, 0.0, 1.0)
	var from: Vector2 = v.enter_from
	var to: Vector2 = v.enter_to
	var p := from.lerp(to, k)
	v.x = p.x
	v.y = p.y
	v.set_anim("walk")
	if k >= 1.0:
		v.hidden = true
		v.vanish_t = 0.0
		v.state = "training"
		v.train_t = 0.0
		v.set_anim("idle")

func _finish_training(v: ToxVillager) -> void:
	var b := bld_any(v.training_at_id)
	v.hidden = false
	v.vanish_t = 0.0
	v.train_t = 0.0
	v.trainee = false
	v.warrior = true
	v.hp = 25.0
	v.max_hp = 25.0
	v.anim_t = 0.0
	v.phase = 0.0
	v.anim = "idle"
	if b != null:
		var e := ToxBuildings.entrance(b)
		v.x = e.outCell.x + 0.5
		v.y = e.outCell.y + 0.5
		v.training_at_id = -1
		v.emerge_t = 0.55
	v.state = "to_warcamp"
	_assign_warrior_destination(v, true)
	_log("%s прошёл обучение и стал воином" % v.name)

func _assign_warrior_destination(v: ToxVillager, fresh: bool = false) -> void:
	var t := town_of_villager(v)
	var camps := type_buildings(t, "warcamp")
	var best: Variant = null
	for c in camps:
		var count := 0
		for w in villagers:
			if w.warrior and w.warcamp_id == _id_of(c):
				count += 1
		if count < ToxBuildings.WARCAMP_CAP:
			best = c
			break
	if best != null:
		v.warcamp_id = _id_of(best)
		v.garrison_id = -1
		v.state = "to_warcamp"
		var cells := ToxBuildings.patrol_cells(best)
		if not cells.is_empty():
			_plan(v, cells[v.id % cells.size()], true)
	else:
		v.warcamp_id = -1
		var barracks := type_buildings(t, "barracks")
		if not barracks.is_empty():
			v.garrison_id = _id_of(barracks[0])
			v.state = "garrison"
			_plan(v, ToxBuildings.front_spot(barracks[0], 1), true)
		else:
			v.state = "wander"

func _update_warrior(v: ToxVillager, dt: float) -> void:
	if v.warcamp_id >= 0 and bld(v.warcamp_id) == null:
		v.warcamp_id = -1
		_assign_warrior_destination(v)
		return
	v.attack_t = maxf(0.0, v.attack_t - dt)
	v.think_t -= dt
	if v.think_t <= 0.0:
		v.think_t = 0.2
		if not _target_valid(v):
			v.target = null
		if v.target == null and not v.hold_fire:
			var found := _find_target(v)
			if found != null:
				v.target = found
				v.order_active = false
	if v.target != null and _target_valid(v):
		var tgt: Variant = v.target
		var d := _distance_to_target(v, tgt)
		if d <= 1.9:
			v.path.clear()
			v.path_i = 0
			v.set_anim("work")
			if tgt is ToxVillager:
				v.face_to(Vector2(tgt.x - v.x, tgt.y - v.y))
			elif tgt is Dictionary:
				var c := ToxBuildings.center(tgt)
				v.face_to(c - Vector2(v.x, v.y))
			if v.attack_t <= 0.0:
				_hit(v, tgt)
				v.attack_t = ATTACK_UNIT if tgt is ToxVillager else ATTACK_BUILDING
			return
		var goal := _goal_for_target(tgt)
		if v.path.is_empty():
			_plan(v, goal, true)
		v.set_anim("walk")
		_move(v, dt)
		return
	v.target = null
	if v.order_active:
		v.set_anim("walk")
		if v.path.is_empty():
			_plan(v, v.order, true)
		if _move(v, dt):
			v.order_active = false
			v.hold_fire = false
			v.wait_t = v.rng.range_f(1.0, 2.0)
		return
	if v.warcamp_id >= 0:
		var camp := bld(v.warcamp_id)
		if camp != null:
			if v.path.is_empty():
				v.wait_t -= dt
				v.set_anim("idle")
				if v.wait_t <= 0.0:
					v.wait_t = v.rng.range_f(2.0, 5.0)
					var cells := ToxBuildings.patrol_cells(camp)
					if not cells.is_empty():
						_plan(v, cells[v.rng.range_i(0, cells.size() - 1)], true)
			else:
				v.set_anim("walk")
				_move(v, dt)
			return
	if v.garrison_id >= 0:
		var bar := bld(v.garrison_id)
		if bar != null:
			if v.path.is_empty():
				v.set_anim("idle")
			else:
				v.set_anim("walk")
				_move(v, dt)
			return
	_update_wander(v, dt)

func _target_valid(v: ToxVillager) -> bool:
	if v.target == null:
		return false
	if v.target is ToxVillager:
		var u: ToxVillager = v.target
		return not u.dead and u.owner != v.owner
	if v.target is Dictionary:
		var b: Dictionary = v.target
		return not b.get("rubble", false) and int(b.get("owner", 0)) != v.owner
	return false

func _distance_to_target(v: ToxVillager, tgt: Variant) -> float:
	if tgt is ToxVillager:
		var u: ToxVillager = tgt
		return Vector2(u.x - v.x, u.y - v.y).length()
	if tgt is Dictionary:
		var b: Dictionary = tgt
		var r := ToxBuildings.bounds(b)
		var nx := clampf(v.x, float(r.position.x), float(r.position.x + r.size.x))
		var ny := clampf(v.y, float(r.position.y), float(r.position.y + r.size.y))
		return Vector2(nx - v.x, ny - v.y).length()
	return 999.0

func _goal_for_target(tgt: Variant) -> Vector2i:
	if tgt is ToxVillager:
		var u: ToxVillager = tgt
		return Vector2i(floori(u.x), floori(u.y))
	if tgt is Dictionary:
		var b: Dictionary = tgt
		var c := ToxBuildings.center(b)
		var nav := ToxPathfinder.nav_map(world, buildings)
		return ToxPathfinder.nearest_walkable(world, nav, Vector2i(floori(c.x), floori(c.y)), 6)
	return Vector2i(-1, -1)

func _find_target(v: ToxVillager) -> Variant:
	var best_unit: ToxVillager = null
	var best_d := AGGRO
	for u in villagers:
		if u.dead or u.owner == v.owner or u.hidden:
			continue
		var d := Vector2(u.x - v.x, u.y - v.y).length()
		if d < best_d:
			best_d = d
			best_unit = u
	if best_unit != null:
		return best_unit
	var best_b: Variant = null
	best_d = AGGRO
	for b in buildings:
		if int(b.get("owner", 0)) == v.owner or b.get("rubble", false):
			continue
		var d2 := _distance_to_target(v, b)
		if d2 < best_d:
			best_d = d2
			best_b = b
	return best_b

func _hit(v: ToxVillager, tgt: Variant) -> void:
	if tgt is ToxVillager:
		var u: ToxVillager = tgt
		if u.dead:
			return
		u.hp -= DAMAGE_UNIT
		u.flinch = 0.16
		if u.hp <= 0.0:
			u.dead = true
			_log("%s погиб в бою" % u.name)
		return
	if tgt is Dictionary:
		var b: Dictionary = tgt
		if b.get("rubble", false):
			return
		if ToxBuildings.damage(b, DAMAGE_BUILDING):
			b.rubble = true
			_on_building_destroyed(b)
		else:
			pass

func _on_building_destroyed(b: Dictionary) -> void:
	var kind := ToxBuildings.type_of(b)
	_log("%s разрушена" % ToxBuildings.NAMES.get(kind, "Постройка"))
	if kind == "townhall":
		var owner := int(b.get("owner", 0))
		var t := town(owner)
		if not t.is_empty() and t.get("alive", true):
			t.alive = false
			emit_signal("town_fell", owner)
	world.build_rev += 1
	_refresh_nav()

func _refresh_nav() -> void:
	world.set_meta("nav", {})

func _cleanup_dead() -> void:
	var changed_any := false
	for v in villagers.duplicate():
		if v.dead:
			if v.tree != null:
				v.tree["claimed_by"] = -1
			villagers.erase(v)
			for t in towns:
				t.villagers.erase(v)
			changed_any = true
	if changed_any:
		world.villagers = villagers
		emit_signal("changed")

func _check_end() -> void:
	if over:
		return
	if mode == "net":
		var alive := []
		for t in towns:
			if t.get("alive", true):
				alive.append(t)
		if towns.size() > 1 and alive.size() <= 1:
			over = true
			winner = int(alive[0].owner) if alive.size() == 1 else -1
			emit_signal("game_over", winner == player_owner)
		return
	var pt := town(player_owner)
	var th: Variant = pt.get("townhall", null)
	if th != null and th.get("rubble", false):
		over = true
		winner = 1 if mode == "bot" else -1
		emit_signal("game_over", false)
		return
	if mode == "bot":
		var et := town(1)
		var eth: Variant = et.get("townhall", null)
		if eth != null and eth.get("rubble", false):
			over = true
			winner = player_owner
			emit_signal("game_over", true)

# ---------------------------------------------------------------- birth

func _update_birth(dt: float) -> void:
	birth_clock -= dt
	if birth_clock > 0.0:
		return
	birth_clock = BIRTH_EVERY
	for t in towns:
		if not t.get("alive", true):
			continue
		if housing_free(t) <= 0:
			continue
		var house: Variant = find_house(t)
		if house == null:
			continue
		var spot := ToxBuildings.front_spot(house, 1)
		var v := _spawn_at(int(t.owner), _id_of(house), spot, true)
		v.home_id = _id_of(house)
		_log("В деревне родился %s" % v.name)

# ---------------------------------------------------------------- bot

func _update_bot(dt: float) -> void:
	var t := town(1)
	if t.is_empty() or not t.get("alive", true):
		return
	var eth: Variant = t.get("townhall", null)
	if eth == null:
		return
	bot_spawn -= dt
	if bot_spawn <= 0.0:
		bot_spawn = 18.0
		var camp: Variant = null
		for b in type_buildings(t, "warcamp"):
			camp = b
			break
		if camp != null:
			var count := 0
			for w in villagers:
				if w.owner == 1 and w.warrior and not w.dead:
					count += 1
			if count < 8:
				var cells := ToxBuildings.patrol_cells(camp)
				if not cells.is_empty():
					var c := cells[rng.range_i(0, cells.size() - 1)]
					var wv := _spawn_at(1, _id_of(find_house(t)), c, false)
					wv.warrior = true
					wv.hp = 25.0
					wv.max_hp = 25.0
					wv.warcamp_id = _id_of(camp)
					wv.state = "patrol"
					_log("Разведка: у врага новый воин")
	bot_attack -= dt
	if bot_attack <= 0.0 and time > 35.0:
		bot_attack = 55.0
		var th: Variant = town(player_owner).get("townhall", null)
		if th != null:
			var ids := []
			for w in villagers:
				if w.owner == 1 and w.warrior and not w.dead:
					ids.append(w.id)
			if not ids.is_empty():
				order_army(ids, Vector2i(th.x + 1, th.y + 2))
				_log("Вражеские воины идут к ратуше")

# ---------------------------------------------------------------- orders

func warriors_of(owner: int) -> Array:
	var out := []
	for v in villagers:
		if v.owner == owner and v.warrior and not v.dead:
			out.append(v)
	return out

func order_army(ids: Array, cell: Vector2i) -> void:
	for v in villagers:
		if v.id in ids and v.warrior and not v.dead:
			v.target = null
			v.hold_fire = false
			v.order = cell
			v.order_active = true
			v.state = "order"
			_plan(v, cell, true)

func stop_army(ids: Array) -> void:
	for v in villagers:
		if v.id in ids and v.warrior and not v.dead:
			v.target = null
			v.order_active = false
			v.hold_fire = true
			v.path.clear()
			v.path_i = 0
			v.state = "patrol" if v.warcamp_id >= 0 else "garrison"

func army_groups(owner: int) -> Array:
	var out := []
	var t := town(owner)
	for b in t.get("buildings", []):
		if b == null or b.get("rubble", false):
			continue
		var typ := ToxBuildings.type_of(b)
		if typ != "warcamp" and typ != "barracks":
			continue
		var ids := []
		for v in villagers:
			if v.owner == owner and v.warrior and not v.dead:
				if (typ == "warcamp" and v.warcamp_id == _id_of(b)) or (typ == "barracks" and v.garrison_id == _id_of(b)):
					ids.append(v.id)
		var cap := ToxBuildings.WARCAMP_CAP if typ == "warcamp" else ToxBuildings.BARRACKS_YARD_CAP
		out.append({
			"building": b, "type": typ, "cap": cap, "ids": ids, "count": ids.size(),
			"label": ("Лагерь" if typ == "warcamp" else "Двор казармы") + " №%d" % (out.size() + 1)
		})
	return out

# ---------------------------------------------------------------- work / training

func work_slots(camp: Dictionary) -> int:
	return ToxBuildings.work_slots(camp)

func training_slots(barracks: Dictionary) -> int:
	return ToxBuildings.training_slots(barracks)

func workers_of(camp: Dictionary) -> Array:
	var out := []
	for v in villagers:
		if v.employer_id == _id_of(camp) and not v.dead:
			out.append(v)
	return out

func trainees_of(barracks: Dictionary) -> Array:
	var out := []
	for v in villagers:
		if v.trainee and v.training_at_id == _id_of(barracks) and not v.dead:
			out.append(v)
	return out

func can_hire(v: ToxVillager, camp: Dictionary) -> Dictionary:
	if v.warrior:
		return {"ok": false, "reason": "это воин"}
	if v.trainee:
		return {"ok": false, "reason": "учится в казарме"}
	if v.employer_id >= 0:
		return {"ok": false, "reason": "уже работает"}
	if workers_of(camp).size() >= work_slots(camp):
		return {"ok": false, "reason": "в лагере нет свободных мест"}
	return {"ok": true, "reason": ""}

func hire(v: ToxVillager, camp: Dictionary) -> Dictionary:
	var check := can_hire(v, camp)
	if not check.ok:
		return check
	v.employer_id = _id_of(camp)
	v.state = "to_camp"
	v.path.clear()
	v.path_i = 0
	_plan(v, _camp_work_cell(camp))
	_log("%s нанят в лагерь" % v.name)
	return {"ok": true, "reason": ""}

func fire(v: ToxVillager) -> void:
	if v.employer_id < 0:
		return
	if v.tree != null:
		v.tree["claimed_by"] = -1
		v.tree = null
	v.employer_id = -1
	v.state = "wander"
	v.path.clear()
	v.path_i = 0
	v.anchor = Vector2(v.x, v.y)
	v.wait_t = 0.0
	_log("%s уволен" % v.name)

func hire_all(camp: Dictionary) -> int:
	var n := 0
	for v in villagers:
		if workers_of(camp).size() >= work_slots(camp):
			break
		if v.owner == int(camp.get("owner", 0)) and can_hire(v, camp).ok:
			hire(v, camp)
			n += 1
	return n

func fire_all(camp: Dictionary) -> int:
	var n := 0
	for v in workers_of(camp).duplicate():
		fire(v)
		n += 1
	return n

func can_train(v: ToxVillager, barracks: Dictionary) -> Dictionary:
	if v.warrior:
		return {"ok": false, "reason": "уже воин"}
	if v.trainee:
		return {"ok": false, "reason": "уже учится"}
	if v.employer_id >= 0:
		return {"ok": false, "reason": "работает в лагере"}
	if trainees_of(barracks).size() >= training_slots(barracks):
		return {"ok": false, "reason": "нет свободных мест"}
	return {"ok": true, "reason": ""}

func train(v: ToxVillager, barracks: Dictionary) -> Dictionary:
	var check := can_train(v, barracks)
	if not check.ok:
		return check
	v.trainee = true
	v.training_at_id = _id_of(barracks)
	v.state = "to_barracks"
	v.path.clear()
	v.path_i = 0
	var e := ToxBuildings.entrance(barracks)
	_plan(v, e.outCell, true)
	_log("%s идёт учиться в казарму" % v.name)
	return {"ok": true, "reason": ""}

func train_all(barracks: Dictionary) -> int:
	var n := 0
	for v in villagers:
		if trainees_of(barracks).size() >= training_slots(barracks):
			break
		if v.owner == int(barracks.get("owner", 0)) and can_train(v, barracks).ok:
			train(v, barracks)
			n += 1
	return n

func cancel_training(v: ToxVillager) -> void:
	if not v.trainee:
		return
	v.trainee = false
	v.training_at_id = -1
	v.hidden = false
	v.vanish_t = 0.0
	v.state = "wander"
	v.path.clear()
	v.path_i = 0
	v.wait_t = 0.0
	_log("Обучение отменено: %s" % v.name)

func hire_order(camp: Dictionary) -> Array:
	var out := []
	var own := int(camp.get("owner", 0))
	for v in villagers:
		if v.owner != own or v.dead:
			continue
		var group := 2
		if v.employer_id == _id_of(camp):
			group = 0
		elif v.employer_id < 0 and not v.trainee and not v.warrior:
			group = 1
		out.append({"v": v, "group": group, "check": can_hire(v, camp)})
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		if a.group != b.group:
			return a.group < b.group
		return a.v.id < b.v.id)
	return out

func training_order(barracks: Dictionary) -> Array:
	var out := []
	var own := int(barracks.get("owner", 0))
	for v in villagers:
		if v.owner != own or v.dead:
			continue
		var group := 3
		if v.trainee and v.training_at_id == _id_of(barracks):
			group = 0
		elif v.warrior:
			group = 2
		elif v.employer_id < 0 and not v.trainee:
			group = 1
		out.append({"v": v, "group": group, "check": can_train(v, barracks)})
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		if a.group != b.group:
			return a.group < b.group
		return a.v.id < b.v.id)
	return out

func work_word(v: ToxVillager) -> String:
	if v.warrior:
		return "воин в лагере" if v.warcamp_id >= 0 else "ждёт в казарме"
	if v.trainee:
		return "учится в казарме" if v.state == "training" else "идёт в казарму"
	if v.employer_id >= 0:
		match v.state:
			"chop": return "рубит дерево"
			"carry": return "несёт брёвна"
			"drop": return "сдаёт брёвна"
			"to_tree": return "идёт к дереву"
			"to_camp": return "идёт в лагерь"
			"stand": return "работать негде"
			_: return "работает в лагере"
	return "гуляет по деревне"

# ---------------------------------------------------------------- economy / building

func build_price(type: String) -> int:
	match type:
		"house": return 12
		"lumbercamp": return 20
		"barracks": return 28
		"warcamp": return 24
	return 0

func build_variant(type: String) -> String:
	return "x" if type == "warcamp" else "a"

func can_build(type: String, rot: int, cell: Vector2i, owner: int = 0) -> Dictionary:
	var t := town(owner)
	var price := build_price(type)
	if int(t.get("logs", 0)) < price:
		return {"ok": false, "reason": "нужно %d брёвен" % price}
	var b := ToxBuildings.make(type, build_variant(type), rot, cell.x, cell.y, owner)
	b["_nid"] = next_build_nid
	var res := ToxBuildings.can_place(world, buildings, b, {
		"requireClear": true, "clearable": false, "villagers": villagers
	})
	res["building"] = b
	return res

func build(type: String, rot: int, cell: Vector2i, owner: int = 0) -> Dictionary:
	var check := can_build(type, rot, cell, owner)
	if not check.ok:
		return check
	var b: Dictionary = check.building
	next_build_nid += 1
	var t := town(owner)
	t.logs = int(t.get("logs", 0)) - build_price(type)
	ToxBuildings.settle(world, b, false)
	add_building(b, t)
	stats.built += 1
	_log("%s построена" % ToxBuildings.NAMES.get(type, "Постройка"))
	if type == "warcamp":
		_rebalance_warriors()
	return {"ok": true, "reason": "построено", "building": b}

func _rebalance_warriors() -> void:
	for v in villagers:
		if not v.warrior or v.dead:
			continue
		if v.warcamp_id < 0 and v.garrison_id >= 0:
			_assign_warrior_destination(v)

func edit_check(b: Dictionary) -> Dictionary:
	var list := []
	for other in buildings:
		if other != b:
			list.append(other)
	var allowed := []
	var bid := _id_of(b)
	for v in villagers:
		if v.employer_id == bid or v.training_at_id == bid or v.warcamp_id == bid or v.garrison_id == bid:
			continue
		allowed.append(v)
	return ToxBuildings.can_place(world, list, b, {
		"requireClear": true, "clearable": false, "villagers": allowed
	})

func edit_apply(b: Dictionary) -> Dictionary:
	var check := edit_check(b)
	if not check.ok:
		return check
	ToxBuildings.settle(world, b, false)
	world.build_rev += 1
	_refresh_nav()
	_log("%s переставлена" % ToxBuildings.NAMES.get(ToxBuildings.type_of(b), "Постройка"))
	return {"ok": true, "reason": ""}

func edit_remove(b: Dictionary) -> Dictionary:
	var type := ToxBuildings.type_of(b)
	if type == "townhall":
		return {"ok": false, "reason": "ратушу снести нельзя"}
	if type == "warcamp":
		return {"ok": false, "reason": "военный лагерь снести нельзя"}
	buildings.erase(b)
	for t in towns:
		t.buildings.erase(b)
	world.build_rev += 1
	_refresh_nav()
	_log("%s снесена" % ToxBuildings.NAMES.get(type, "Постройка"))
	return {"ok": true, "reason": ""}

# ---------------------------------------------------------------- network

func net_command(owner: int, cmd: Dictionary) -> Dictionary:
	## Host-side authority for a guest command. Ownership is decided by the
	## host's peer table, never by a field the client sent.
	if world == null:
		return {"ok": false, "reason": "мир не создан"}
	if over:
		return {"ok": false, "reason": "матч окончен"}
	var t_owner := town(owner)
	if t_owner.is_empty() or not bool(t_owner.get("alive", true)):
		return {"ok": false, "reason": "деревня пала"}
	var kind := str(cmd.get("kind", ""))
	match kind:
		"build":
			var type := str(cmd.get("type", ""))
			if not ["house", "lumbercamp", "barracks", "warcamp"].has(type):
				return {"ok": false, "reason": "неизвестная постройка"}
			var rot := ToxBuildings.norm_rot(int(cmd.get("rot", 90)))
			var cell := Vector2i(int(cmd.get("x", -1)), int(cmd.get("y", -1)))
			return build(type, rot, cell, owner)
		"edit_apply":
			var b: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if b == null:
				return {"ok": false, "reason": "это чужая постройка"}
			var old := {"x": int(b.x), "y": int(b.y), "rot": int(b.rot)}
			b.x = int(cmd.get("x", b.x))
			b.y = int(cmd.get("y", b.y))
			b.rot = ToxBuildings.norm_rot(int(cmd.get("rot", b.rot)))
			var res := edit_apply(b)
			if not res.ok:
				b.x = old.x
				b.y = old.y
				b.rot = old.rot
				world.build_rev += 1
				_refresh_nav()
			return res
		"edit_remove":
			var b: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if b == null:
				return {"ok": false, "reason": "это чужая постройка"}
			return edit_remove(b)
		"hire":
			var v: Variant = _net_own_villager(owner, int(cmd.get("vid", -1)))
			var camp: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if v == null or camp == null:
				return {"ok": false, "reason": "это чужие жители или лагерь"}
			return hire(v, camp)
		"fire":
			var v: Variant = _net_own_villager(owner, int(cmd.get("vid", -1)))
			if v == null:
				return {"ok": false, "reason": "это чужой житель"}
			fire(v)
			return {"ok": true, "reason": ""}
		"hire_all":
			var camp: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if camp == null:
				return {"ok": false, "reason": "это чужой лагерь"}
			var n := hire_all(camp)
			return {"ok": true, "reason": "", "count": n}
		"fire_all":
			var camp: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if camp == null:
				return {"ok": false, "reason": "это чужой лагерь"}
			var n := fire_all(camp)
			return {"ok": true, "reason": "", "count": n}
		"train":
			var v: Variant = _net_own_villager(owner, int(cmd.get("vid", -1)))
			var bar: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if v == null or bar == null:
				return {"ok": false, "reason": "это чужие жители или казарма"}
			return train(v, bar)
		"train_all":
			var bar: Variant = _net_own_building(owner, int(cmd.get("nid", -1)))
			if bar == null:
				return {"ok": false, "reason": "это чужая казарма"}
			var n := train_all(bar)
			return {"ok": true, "reason": "", "count": n}
		"order":
			var ids := []
			for id in cmd.get("ids", []):
				var v: Variant = _net_own_villager(owner, int(id))
				if v != null and v.warrior:
					ids.append(v.id)
			if ids.is_empty():
				return {"ok": false, "reason": "нет своих воинов"}
			var cell := Vector2i(int(cmd.get("x", -1)), int(cmd.get("y", -1)))
			if not world.inside(cell.x, cell.y):
				return {"ok": false, "reason": "приказ за краем карты"}
			order_army(ids, cell)
			return {"ok": true, "reason": "", "count": ids.size()}
		"stop":
			var ids := []
			for id in cmd.get("ids", []):
				var v: Variant = _net_own_villager(owner, int(id))
				if v != null and v.warrior:
					ids.append(v.id)
			if ids.is_empty():
				return {"ok": false, "reason": "нет своих воинов"}
			stop_army(ids)
			return {"ok": true, "reason": "", "count": ids.size()}
	return {"ok": false, "reason": "неизвестная команда"}

func _net_own_building(owner: int, nid: int) -> Variant:
	var b: Variant = bld_any(nid)
	if b == null or b.get("rubble", false) or int(b.get("owner", -1)) != owner:
		return null
	return b

func _net_own_villager(owner: int, vid: int) -> Variant:
	for v in villagers:
		if v.id == vid and v.owner == owner and not v.dead:
			return v
	return null

func net_state() -> Dictionary:
	## Absolute snapshot. It is intentionally self-healing: buildings,
	## villagers and the removed-object bitmap are all sent in full, so a
	## dropped snapshot costs nothing but a frame of smoothness.
	var st := {
		"time": time, "over": over, "winner": winner,
		"build_rev": world.build_rev, "object_total": world.object_total,
		"towns": [], "buildings": [], "villagers": [], "events": [],
		"stats": stats.duplicate(true), "removed": PackedInt32Array()
	}
	for t in towns:
		st.towns.append({
			"owner": int(t.owner), "name": str(t.name), "color": str(t.color),
			"alive": bool(t.get("alive", true)), "is_bot": bool(t.get("is_bot", false)),
			"logs": int(t.get("logs", 0)), "deliveries": int(t.get("deliveries", 0)),
			"felled": int(t.get("felled", 0)), "townhall": _id_of(t.get("townhall", null))
		})
	for b in buildings:
		st.buildings.append({
			"_nid": int(b.get("_nid", -1)), "id": str(b.get("id", "")),
			"kind": "building", "type": ToxBuildings.type_of(b),
			"variant": str(b.get("variant", "a")), "rot": int(b.get("rot", 0)),
			"x": int(b.x), "y": int(b.y), "owner": int(b.get("owner", 0)),
			"level": int(b.get("level", 1)), "rubble": bool(b.get("rubble", false)),
			"flinch": float(b.get("flinch", 0.0)),
			"hp": float(b.get("hp", 50.0)), "max_hp": float(b.get("max_hp", 50.0))
		})
	for v in villagers:
		if v.dead:
			continue
		st.villagers.append({
			"id": v.id, "name": v.name, "owner": v.owner, "home_id": v.home_id,
			"x": v.x, "y": v.y, "rot": v.rot, "anim": v.anim,
			"state": v.state, "hidden": v.hidden,
			"vanish_t": v.vanish_t, "emerge_t": v.emerge_t, "appear_t": v.appear_t,
			"hp": v.hp, "max_hp": v.max_hp, "speed": v.speed,
			"warrior": v.warrior, "trainee": v.trainee,
			"employer_id": v.employer_id, "training_at_id": v.training_at_id,
			"warcamp_id": v.warcamp_id, "garrison_id": v.garrison_id,
			"carry": v.carry, "flinch": v.flinch
		})
	var start := maxi(0, events.size() - 12)
	for i in range(start, events.size()):
		st.events.append(events[i].duplicate(true))
	var rem := PackedInt32Array()
	for o in world.objects:
		if o.get("removed", false):
			rem.append(int(o.get("id", -1)))
	st.removed = rem
	return st

func apply_net_state(state: Dictionary, skip_building_nid: int = -1, silent_events: bool = false) -> void:
	if world == null:
		return
	var was_over := over
	time = float(state.get("time", time))
	world.time = time
	over = bool(state.get("over", over))
	winner = int(state.get("winner", winner))
	# --- towns
	var town_by_owner := {}
	var was_alive := {}
	for t in towns:
		town_by_owner[int(t.owner)] = t
		was_alive[int(t.owner)] = bool(t.get("alive", true))
	var fallen := []
	for ts in state.get("towns", []):
		var owner := int(ts.get("owner", 0))
		var t: Variant = town_by_owner.get(owner, null)
		if t == null:
			t = new_town(owner, str(ts.get("name", "Деревня")))
			town_by_owner[owner] = t
			was_alive[owner] = true
		t.name = str(ts.get("name", t.name))
		t.color = str(ts.get("color", t.color))
		var alive := bool(ts.get("alive", true))
		if bool(was_alive.get(owner, true)) and not alive:
			fallen.append(owner)
		t.alive = alive
		t.is_bot = bool(ts.get("is_bot", false))
		t.logs = int(ts.get("logs", 0))
		t.deliveries = int(ts.get("deliveries", 0))
		t.felled = int(ts.get("felled", 0))
	# --- buildings (reuse the dictionary so selection/edit keeps working)
	var fresh_buildings := []
	var max_nid := 0
	for bs in state.get("buildings", []):
		var nid := int(bs.get("_nid", -1))
		max_nid = maxi(max_nid, nid)
		var b: Variant = bld_any(nid)
		if b == null:
			b = {
				"kind": "building", "type": str(bs.get("type", "townhall")),
				"variant": str(bs.get("variant", "a")), "rot": int(bs.get("rot", 0)),
				"x": int(bs.get("x", 0)), "y": int(bs.get("y", 0)),
				"owner": int(bs.get("owner", 0)), "level": int(bs.get("level", 1)),
				"id": str(bs.get("id", "b%d" % nid)), "rubble": false,
				"flinch": 0.0, "hp": 50.0, "max_hp": 50.0,
				"workers": [], "trainees": [], "garrison": []
			}
		elif nid != skip_building_nid:
			b.x = int(bs.get("x", b.x))
			b.y = int(bs.get("y", b.y))
			b.rot = int(bs.get("rot", b.rot))
		b["_nid"] = nid
		b["id"] = str(bs.get("id", b.get("id", "")))
		b["type"] = str(bs.get("type", b.get("type", "townhall")))
		b["variant"] = str(bs.get("variant", b.get("variant", "a")))
		b["owner"] = int(bs.get("owner", b.get("owner", 0)))
		b["level"] = int(bs.get("level", b.get("level", 1)))
		b["rubble"] = bool(bs.get("rubble", false))
		b["flinch"] = float(bs.get("flinch", 0.0))
		b["hp"] = float(bs.get("hp", 50.0))
		b["max_hp"] = float(bs.get("max_hp", 50.0))
		fresh_buildings.append(b)
	buildings = fresh_buildings
	# --- villagers
	var fresh_villagers := []
	var seen := {}
	var max_vid := 0
	for vs in state.get("villagers", []):
		var vid := int(vs.get("id", 0))
		max_vid = maxi(max_vid, vid)
		seen[vid] = true
		var v: Variant = null
		for old in villagers:
			if old.id == vid:
				v = old
				break
		if v == null:
			v = ToxVillager.new(vid * 2654435761 + 17)
			v.id = vid
			v.appear_t = 0.0
		v.name = str(vs.get("name", v.name))
		v.owner = int(vs.get("owner", 0))
		v.home_id = int(vs.get("home_id", -1))
		var nx := float(vs.get("x", v.x))
		var ny := float(vs.get("y", v.y))
		if v.net_x < 0.0 or Vector2(nx - v.x, ny - v.y).length() > 3.0:
			v.x = nx
			v.y = ny
		v.net_x = nx
		v.net_y = ny
		v.rot = float(vs.get("rot", v.rot))
		var anim := str(vs.get("anim", "idle"))
		if v.anim != anim:
			v.anim = anim
			v.anim_t = 0.0
			v.phase = 0.0
		v.state = str(vs.get("state", "wander"))
		v.hidden = bool(vs.get("hidden", false))
		v.vanish_t = float(vs.get("vanish_t", 0.0))
		v.emerge_t = float(vs.get("emerge_t", 0.0))
		v.appear_t = float(vs.get("appear_t", 0.0))
		v.hp = float(vs.get("hp", 15.0))
		v.max_hp = float(vs.get("max_hp", 15.0))
		v.speed = float(vs.get("speed", 0.63))
		v.warrior = bool(vs.get("warrior", false))
		v.trainee = bool(vs.get("trainee", false))
		v.employer_id = int(vs.get("employer_id", -1))
		v.training_at_id = int(vs.get("training_at_id", -1))
		v.warcamp_id = int(vs.get("warcamp_id", -1))
		v.garrison_id = int(vs.get("garrison_id", -1))
		v.carry = int(vs.get("carry", 0))
		v.flinch = float(vs.get("flinch", 0.0))
		fresh_villagers.append(v)
	for old in villagers:
		if not seen.has(old.id):
			old.dead = true
	villagers = fresh_villagers
	# --- rebuild the town indexes
	for t in towns:
		t.buildings = []
		t.villagers = []
		t.townhall = null
	for b in buildings:
		var t2 := town(int(b.get("owner", 0)))
		if not t2.is_empty():
			t2.buildings.append(b)
			if ToxBuildings.type_of(b) == "townhall" and not b.get("rubble", false):
				t2.townhall = b
	for v in villagers:
		var t3 := town(v.owner)
		if not t3.is_empty():
			t3.villagers.append(v)
	# --- world bookkeeping
	world.buildings = buildings
	world.villagers = villagers
	world.towns = towns
	world.village = town(player_owner)
	world.build_rev = int(state.get("build_rev", world.build_rev))
	world.object_total = int(state.get("object_total", world.object_total))
	world.time = time
	next_build_nid = maxi(next_build_nid, max_nid + 1)
	next_villager_id = maxi(next_villager_id, max_vid + 1)
	# --- removed nature objects (absolute bitmap, self-healing)
	var rem: PackedInt32Array = state.get("removed", PackedInt32Array())
	if rem.size() > 0:
		var rs := {}
		for id in rem:
			rs[int(id)] = true
		for o in world.objects:
			if rs.has(int(o.get("id", -1))):
				o["removed"] = true
	# --- events
	for e in state.get("events", []):
		var n := int(e.get("n", 0))
		if n <= event_total:
			continue
		event_total = n
		events.append(e.duplicate(true))
		if not silent_events:
			emit_signal("event_log", str(e.get("text", "")))
	while events.size() > 60:
		events.pop_front()
	world.village = town(player_owner)
	emit_signal("changed")
	for owner in fallen:
		emit_signal("town_fell", int(owner))
	if over and not was_over:
		emit_signal("game_over", winner == player_owner)

func update_remote(dt: float) -> void:
	## Clients never simulate gameplay; they only advance animation clocks and
	## ease bodies toward the last authoritative positions.
	if world == null:
		return
	time += dt
	world.time = time
	for v in villagers:
		v.tick_anim(dt)
		if v.flinch > 0.0:
			v.flinch = maxf(0.0, v.flinch - dt)
		if v.appear_t > 0.0:
			v.appear_t = maxf(0.0, v.appear_t - dt)
		if v.emerge_t > 0.0:
			v.emerge_t = maxf(0.0, v.emerge_t - dt)
		if v.vanish_t > 0.0:
			v.vanish_t = maxf(0.0, v.vanish_t - dt)
		if v.net_x >= 0.0:
			var k := 1.0 - exp(-14.0 * dt)
			v.x = lerpf(v.x, v.net_x, k)
			v.y = lerpf(v.y, v.net_y, k)
			if absf(v.x - v.net_x) + absf(v.y - v.net_y) < 0.004:
				v.x = v.net_x
				v.y = v.net_y

func world_hash() -> String:
	## Used once at start to prove host and client generated the same island.
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(PackedInt32Array([world.width, world.height]).to_byte_array())
	h.update(world.tile)
	h.update(world.is_land)
	var nums := PackedInt32Array()
	for o in world.objects:
		nums.append(int(round(float(o.x) * 1000.0)))
		nums.append(int(round(float(o.y) * 1000.0)))
		nums.append(ToxRNG.hash_string(str(o.get("kind", "")) + ":" + str(o.get("variant", ""))))
	h.update(nums.to_byte_array())
	return h.finish().hex_encode()

# ---------------------------------------------------------------- helpers

func _log(text: String) -> void:
	event_total += 1
	events.append({"n": event_total, "t": time, "text": text})
	if events.size() > 60:
		events.pop_front()
	emit_signal("event_log", text)

func log_event(text: String) -> void:
	_log(text)

func player_logs() -> int:
	return int(player_town().get("logs", 0))

func player_felled() -> int:
	return int(player_town().get("felled", 0))

func player_deliveries() -> int:
	return int(player_town().get("deliveries", 0))

func selected_data() -> Dictionary:
	return {}
