extends SceneTree

var fails := 0
func check(c: bool, s: String) -> void:
	print(("  ok  " if c else "  FAIL ") + s)
	if not c: fails += 1

func _init() -> void:
	print("== training and army")
	var sim := ToxSim.new()
	sim.start("тихая-долина-701", 64, "solo")
	sim.town(0).logs = 1000
	var th: Dictionary = sim.town(0).townhall
	var near := Vector2i(int(th.x) + 1, int(th.y) + 2)
	var brs := ToxBuildings.find_site(sim.world, sim.buildings, "barracks", "a", 90, near, 34, true, sim.villagers)
	check(not brs.is_empty(), "barracks site")
	var br := sim.build("barracks", 90, Vector2i(brs.x, brs.y))
	check(br.ok, "barracks built")
	var wcs := ToxBuildings.find_site(sim.world, sim.buildings, "warcamp", "x", 90, near, 36, true, sim.villagers)
	check(not wcs.is_empty(), "warcamp site")
	var wc := sim.build("warcamp", 90, Vector2i(wcs.x, wcs.y))
	check(wc.ok, "warcamp built")
	var n := sim.train_all(br.building)
	print("  trained ", n)
	check(n == 3, "three trainees")
	for i in range(2400):
		sim.update(0.05)
		if i % 400 == 0:
			print("  t=%d warriors=%d" % [int(sim.time), sim.warriors_of(0).size()])
	check(sim.warriors_of(0).size() == 3, "three warriors")
	var groups := sim.army_groups(0)
	check(groups.size() >= 2, "army groups")
	var total := 0
	for g in groups:
		total += int(g.count)
	check(total == 3, "warriors assigned to groups")
	var ids := []
	for v in sim.warriors_of(0):
		ids.append(v.id)
	sim.order_army(ids, Vector2i(int(th.x) + 2, int(th.y) + 2))
	check(sim.warriors_of(0)[0].order_active, "order active")
	for i in range(200):
		sim.update(0.05)
	sim.stop_army(ids)
	check(sim.warriors_of(0)[0].hold_fire, "stop holds fire")

	print("== birth")
	var birthsim := ToxSim.new()
	birthsim.start("тихая-долина-701", 64, "solo")
	var before := birthsim.villagers.size()
	for i in range(800):
		birthsim.update(0.05)
	print("  villagers ", before, " -> ", birthsim.villagers.size())
	check(birthsim.villagers.size() > before, "villager born")

	print("== bot combat")
	var bot := ToxSim.new()
	bot.start("зелёная-пойма-202", 64, "bot")
	bot.town(0).logs = 1000
	var bth: Dictionary = bot.town(0).townhall
	# Give the player a warcamp and three warriors near the town hall.
	var bnear := Vector2i(int(bth.x) + 1, int(bth.y) + 2)
	var pwc := ToxBuildings.find_site(bot.world, bot.buildings, "warcamp", "x", 90, bnear, 30, true, bot.villagers)
	if not pwc.is_empty():
		bot.build("warcamp", 90, Vector2i(pwc.x, pwc.y))
	for i in range(3):
		var v := bot._spawn_at(0, -1, Vector2i(int(bth.x) + 2, int(bth.y) + 2), false)
		v.warrior = true
		v.hp = 25
		v.max_hp = 25
		v.warcamp_id = bot._id_of(pwc) if not pwc.is_empty() else -1
	# Enemy warriors are spawned by the bot AI; run two minutes.
	for i in range(2400):
		bot.update(0.05)
	print("  time ", bot.time, " enemy warriors ", bot.warriors_of(1).size(), " player warriors ", bot.warriors_of(0).size())
	check(bot.warriors_of(1).size() > 0, "enemy trained warriors")
	check(bot.villagers.size() >= 6, "both villages alive")

	print("")
	print("ALL FEATURE TESTS PASSED" if fails == 0 else "%d FEATURE TESTS FAILED" % fails)
	quit(1 if fails > 0 else 0)
