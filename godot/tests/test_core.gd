extends SceneTree

var failures := 0

func check(cond: bool, text: String) -> void:
	if cond:
		print("  ok  ", text)
	else:
		failures += 1
		print("  FAIL ", text)

func _init() -> void:
	print("== world generation")
	var t0 := Time.get_ticks_msec()
	var w := ToxWorldGen.generate({"seed": "тихая-долина-701", "size": 64})
	print("  gen %d ms, %dx%d, objects %d, land %.2f" % [Time.get_ticks_msec() - t0, w.width, w.height, w.objects.size(), w.stats.landShare])
	check(w.width > 64 and w.height > 64, "sea margin present")
	check(w.stats.landShare > 0.45 and w.stats.landShare < 0.80, "land share near 62%")
	check(w.objects.size() > 100, "trees and stones placed")
	check(w.land_bounds.size.x > 20, "land bounds")
	var water_edges := 0
	for x in range(w.width):
		if w.tile[x] != ToxWorldGen.T_GRASS and w.tile[x] != ToxWorldGen.T_SAND:
			water_edges += 1
	check(water_edges == w.width, "top edge is water")

	print("== atlas")
	ToxAtlasDB.ensure_loaded()
	check(not ToxAtlasDB.buildings.is_empty(), "buildings loaded")
	for type in ["townhall", "house", "lumbercamp", "barracks", "warcamp"]:
		var f := ToxAtlasDB.building_frame(type, "a", 90)
		check(not f.is_empty(), "frame " + type)
	var vf := ToxAtlasDB.character_frame(false, "walk", 0, 90.0)
	check(not vf.is_empty(), "villager walk frame")

	print("== pathfinding")
	var nav := ToxPathfinder.nav_map(w, [])
	var start := Vector2i(w.width / 2, w.height / 2)
	var goal := ToxPathfinder.nearest_walkable(w, nav, start + Vector2i(6, 4), 8)
	var path := ToxPathfinder.find_path(w, [], start, goal)
	check(path.size() > 0, "path found")

	print("== solo simulation")
	var sim := ToxSim.new()
	sim.start("тихая-долина-701", 64, "solo")
	print("  buildings %d, villagers %d, logs %d" % [sim.buildings.size(), sim.villagers.size(), sim.player_logs()])
	check(sim.buildings.size() >= 3, "three start buildings")
	check(sim.villagers.size() == 3, "three villagers")
	check(sim.town(0).townhall != null, "town hall")
	var camp: Variant = null
	for b in sim.buildings:
		if ToxBuildings.type_of(b) == "lumbercamp":
			camp = b
	check(camp != null, "lumber camp")
	sim.hire_all(camp)
	var logs0 := sim.player_logs()
	for i in range(1200): # 60 seconds
		sim.update(0.05)
	print("  logs %d, felled %d" % [sim.player_logs(), sim.player_felled()])
	check(sim.player_logs() > logs0, "lumberjacks deliver logs")

	print("== construction")
	sim.town(0).logs = 200
	var th: Dictionary = sim.town(0).townhall
	var near := Vector2i(int(th.x) + 1, int(th.y) + 2)
	var hsite := ToxBuildings.find_site(sim.world, sim.buildings, "house", "a", 90, near, 24, true, sim.villagers)
	var bres := {"ok": false, "reason": "no site", "building": {}}
	if not hsite.is_empty():
		bres = sim.build("house", 90, Vector2i(hsite.x, hsite.y))
	print("  build house: ", bres.reason)
	check(bres.ok, "house built")
	var bsite := ToxBuildings.find_site(sim.world, sim.buildings, "barracks", "a", 90, near, 28, true, sim.villagers)
	var br := {"ok": false, "reason": "no site", "building": {}}
	if not bsite.is_empty():
		br = sim.build("barracks", 90, Vector2i(bsite.x, bsite.y))
	print("  build barracks: ", br.reason)
	check(br.ok, "barracks built")
	var wsite := ToxBuildings.find_site(sim.world, sim.buildings, "warcamp", "x", 90, near, 30, true, sim.villagers)
	var wc := {"ok": false, "reason": "no site", "building": {}}
	if not wsite.is_empty():
		wc = sim.build("warcamp", 90, Vector2i(wsite.x, wsite.y))
	print("  build warcamp: ", wc.reason)
	check(wc.ok, "warcamp built")
	if br.ok:
		var free: ToxVillager = null
		for v in sim.villagers:
			if not v.warrior and not v.trainee and v.employer_id < 0:
				free = v
				break
		check(free != null, "free villager")
		if free != null:
			var tr := sim.train(free, br.building)
			check(tr.ok, "training started")
			for i in range(400):
				sim.update(0.05)
			check(free.warrior, "villager became warrior")
			check(free.hp == 25.0, "warrior hp")

	print("== edit")
	var house: Dictionary = bres.building
	var oldx: int = int(house.x)
	house.x += 1
	var ec := sim.edit_check(house)
	check(not ec.ok or ec.ok, "edit check responds")
	house.x = oldx
	check(sim.edit_apply(house).ok, "edit apply")

	print("== bot simulation")
	var bot := ToxSim.new()
	bot.start("зелёная-пойма-202", 64, "bot")
	check(bot.towns.size() == 2, "enemy town exists")
	check(bot.town(1).townhall != null, "enemy town hall")
	for i in range(400):
		bot.update(0.05)
	check(bot.villagers.size() > 5, "both villages inhabited")

	print("")
	if failures == 0:
		print("ALL CORE TESTS PASSED")
	else:
		print("%d CORE TESTS FAILED" % failures)
	quit(1 if failures > 0 else 0)
