extends SceneTree

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")
const Loop = preload("res://scripts/eos/loop_link.gd")
const Tunnel = preload("res://scripts/eos/tunnel.gd")
var nodes := []
var links := []
var sup

func _init() -> void:
	_run()

func _run() -> void:
	create_timer(90.0).timeout.connect(func() -> void: push_error("four-player test timed out"); _finish(1))
	sup = Supervisor.new()
	var temporary := OS.get_environment("TMPDIR")
	if temporary == "": temporary = ProjectSettings.globalize_path("user://state")
	sup.recovery_state_dir = temporary.path_join("4tox-four-test-" + Crypto.new().generate_random_bytes(12).hex_encode()).path_join("rooms")
	root.add_child(sup)
	await process_frame
	assert(await sup.start_server())
	var host_link = Loop.new()
	host_link.listen_port = 0
	assert(host_link.start_host())
	links.append(host_link)
	var host_tunnel = Tunnel.new()
	root.add_child(host_tunnel)
	nodes.append(host_tunnel)
	assert(host_tunnel.start_host(host_link, sup.port))
	var host = LiveRoom.new()
	host.persist_session = false
	root.add_child(host)
	nodes.append(host)
	assert(await host.create_lobby(sup.base, "Host", "four-player", 64, 4))
	var guests := []
	for i in range(3):
		var link = Loop.new()
		assert(link.start_client(host_link.room_id()))
		links.append(link)
		var tunnel = Tunnel.new()
		root.add_child(tunnel)
		nodes.append(tunnel)
		assert(tunnel.start_guest(link) > 0)
		var room = LiveRoom.new()
		room.persist_session = false
		root.add_child(room)
		nodes.append(room)
		assert(await room.join_lobby(tunnel.local_url(), host.code, "Guest%d" % i))
		guests.append(room)
	await host.set_ready(true)
	for guest in guests: await guest.set_ready(true)
	assert(await host.start_now())
	var t := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t < 30000:
		var all := true
		for guest in guests:
			if guest.frames == 0: all = false
		if all: break
		await process_frame
	for guest in guests: assert(guest.frames > 0)
	print("PASS four players: Node, localhost tunnel, readiness, start and binary frames")
	for guest in guests: await guest.leave()
	await host.leave()
	_finish(0)

func _finish(code: int) -> void:
	for n in nodes:
		if is_instance_valid(n): n.queue_free()
	for l in links: l.stop()
	if sup != null: sup.stop()
	quit(code)
