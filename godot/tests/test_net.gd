extends SceneTree

var fails := 0

func check(cond: bool, text: String) -> void:
	if cond:
		print("  ok  ", text)
	else:
		fails += 1
		print("  FAIL ", text)

func players3() -> Array:
	return [
		{"owner": 0, "name": "Хозяин"},
		{"owner": 1, "name": "Гость"},
		{"owner": 2, "name": "Третий"},
	]

func camp_of(sim: ToxSim, owner: int) -> Variant:
	for b in sim.buildings:
		if int(b.get("owner", 0)) == owner and ToxBuildings.type_of(b) == "lumbercamp":
			return b
	return null

func house_of(sim: ToxSim, owner: int) -> Variant:
	for b in sim.buildings:
		if int(b.get("owner", 0)) == owner and ToxBuildings.type_of(b) == "house":
			return b
	return null

func _init() -> void:
	print("== networked world")
	var host := ToxSim.new()
	host.start_net("тихая-долина-701", 64, players3())
	check(host.towns.size() == 3, "three player towns")
	check(host.buildings.size() == 9, "three starting villages")
	check(host.villagers.size() == 9, "three villagers per village")
	var halls := {}
	for t in host.towns:
		var th: Variant = t.get("townhall", null)
		check(th != null, "town hall for owner %d" % int(t.owner))
		if th != null:
			halls[Vector2i(int(th.x), int(th.y))] = true
	check(halls.size() == 3, "village sites are distinct")

	var other := ToxSim.new()
	other.start_net("тихая-долина-701", 64, players3())
	check(host.world_hash() == other.world_hash(), "same seed and players give the same island")
	var different := ToxSim.new()
	different.start_net("зелёная-пойма-202", 64, players3())
	check(host.world_hash() != different.world_hash(), "different seed gives a different island")

	print("== commands are host-authoritative")
	host.town(1).logs = 300
	var camp1: Variant = camp_of(host, 1)
	var camp0: Variant = camp_of(host, 0)
	var house0: Variant = house_of(host, 0)
	check(camp1 != null and camp0 != null and house0 != null, "camps and house found")
	var foreign_remove := host.net_command(1, {"kind": "edit_remove", "nid": host._id_of(house0)})
	check(not foreign_remove.ok, "guest cannot remove host building: " + str(foreign_remove.reason))
	var foreign_hire := host.net_command(1, {"kind": "hire_all", "nid": host._id_of(camp0)})
	check(not foreign_hire.ok, "guest cannot hire into host camp")
	var own_hire := host.net_command(1, {"kind": "hire_all", "nid": host._id_of(camp1)})
	check(own_hire.ok and int(own_hire.count) == 3, "guest hires all three own workers")
	check(host.workers_of(camp1).size() == 3, "three workers belong to guest camp")

	var foreign_order := []
	for v in host.villagers:
		if v.owner == 0:
			foreign_order.append(v.id)
	var order_res := host.net_command(1, {"kind": "order", "ids": foreign_order, "x": 1, "y": 1})
	check(not order_res.ok, "guest cannot order host villagers")

	var built := {}
	for r in range(20):
		var site := ToxBuildings.find_site(host.world, host.buildings, "house", "a", 90,
			Vector2i(int(camp1.x) + 3, int(camp1.y) + 3), 22 + r, true, host.villagers)
		if not site.is_empty():
			var res := host.net_command(1, {"kind": "build", "type": "house", "rot": 90, "x": int(site.x), "y": int(site.y)})
			if res.ok:
				built = res
				break
	check(not built.is_empty(), "guest builds a house for their own village")

	print("== snapshot round trip")
	for i in range(400): # 20 seconds: workers deliver, houses stand
		host.update(0.05)
	var state := host.net_state()
	var encoded := ToxNet.encode_state(state)
	var decoded := ToxNet.decode_state(encoded)
	check(not decoded.is_empty(), "snapshot decodes")
	print("  snapshot bytes ", encoded.size(), " raw ", var_to_bytes(state).size(), " buildings ", state.buildings.size(), " villagers ", state.villagers.size())
	check(encoded.size() < 120000, "snapshot fits a game packet after gzip")

	var client := ToxSim.new()
	client.start_net("тихая-долина-701", 64, players3())
	var before_events := client.events.size()
	client.apply_net_state(decoded, -1, true)
	check(client.buildings.size() == host.buildings.size(), "client building count matches")
	check(client.villagers.size() == host.villagers.size(), "client villager count matches")
	check(client.time == host.time, "client time matches")
	check(int(client.town(1).logs) == int(host.town(1).logs), "client sees guest logs")
	check(client.workers_of(camp_of(client, 1)).size() == 3, "client sees guest workers")
	check(client.events.size() >= before_events, "client receives events")
	var removed_host := 0
	var removed_client := 0
	for o in host.world.objects:
		if o.get("removed", false):
			removed_host += 1
	for o in client.world.objects:
		if o.get("removed", false):
			removed_client += 1
	check(removed_host == removed_client, "removed nature objects match (%d)" % removed_host)
	check(client.world_hash() == host.world_hash(), "terrain and objects still identical")

	var host_pos := {}
	for v in host.villagers:
		host_pos[v.id] = Vector2(v.x, v.y)
	var moved := false
	for i in range(40):
		host.update(0.05)
	state = host.net_state()
	state["seq"] = 3
	client.apply_net_state(state, -1, true)
	for v in client.villagers:
		if host_pos.has(v.id):
			var old: Vector2 = host_pos[v.id]
			if Vector2(v.net_x - old.x, v.net_y - old.y).length() > 0.05:
				moved = true
	check(moved, "client receives moved villagers")
	var x_before: float = client.villagers[0].x
	client.update_remote(0.1)
	check(absf(float(client.villagers[0].x) - x_before) > 0.001 or float(client.villagers[0].net_x) < 0.0,
		"remote client eases toward snapshot position")

	print("== match end")
	var ghost := ToxSim.new()
	ghost.start_net("тихая-долина-701", 64, players3())
	ghost.abandon_town(1)
	check(not bool(ghost.town(1).alive), "disconnected guest village is abandoned")
	ghost._check_end()
	check(not ghost.over, "abandoned village does not block a three-player match")

	var victim := ToxSim.new()
	victim.start_net("тихая-долина-701", 64, players3())
	victim.set_player_owner(1)
	var th2: Dictionary = victim.town(1).townhall
	ToxBuildings.damage(th2, 9999.0)
	victim._on_building_destroyed(th2)
	check(not bool(victim.town(1).alive), "lost town marked dead")
	var dead_camp: Variant = camp_of(victim, 1)
	var dead_cmd := victim.net_command(1, {"kind": "hire_all", "nid": victim._id_of(dead_camp)})
	check(not dead_cmd.ok and str(dead_cmd.reason) == "деревня пала", "eliminated player cannot give commands")
	victim._check_end()
	check(not victim.over, "match continues while two villages stand")
	var th0: Dictionary = victim.town(0).townhall
	ToxBuildings.damage(th0, 9999.0)
	victim._on_building_destroyed(th0)
	victim._check_end()
	check(victim.over, "match ends when one village remains")
	check(victim.winner == 2, "last village wins the match")

	print("")
	print("ALL NETWORK LOGIC TESTS PASSED" if fails == 0 else "%d NETWORK LOGIC TESTS FAILED" % fails)
	quit(1 if fails > 0 else 0)
