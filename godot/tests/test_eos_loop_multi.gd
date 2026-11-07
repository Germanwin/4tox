extends SceneTree

const Loop = preload("res://scripts/eos/loop_link.gd")

func _init() -> void:
	_run()

func _run() -> void:
	var host = Loop.new()
	host.listen_port = 0
	assert(await host.start_host())
	var guests := []
	var received := {}
	host.packet.connect(func(id: int, data: PackedByteArray) -> void:
		received[id] = data.get_string_from_utf8())
	for i in range(3):
		var guest = Loop.new()
		assert(await guest.start_client(host.room_id()))
		guests.append(guest)
	var t := Time.get_ticks_msec()
	while host.peers().size() < 3 and Time.get_ticks_msec() - t < 5000:
		host.poll()
		for guest in guests: guest.poll()
		await process_frame
	assert(host.peers().size() == 3)
	for i in range(3):
		assert(guests[i].send(1, ("guest%d" % i).to_utf8_buffer()))
	t = Time.get_ticks_msec()
	while received.size() < 3 and Time.get_ticks_msec() - t < 5000:
		host.poll()
		for guest in guests: guest.poll()
		await process_frame
	assert(received.size() == 3)
	assert(received.values().has("guest0") and received.values().has("guest1") and received.values().has("guest2"))
	guests[1].stop()
	t = Time.get_ticks_msec()
	while host.peers().size() != 2 and Time.get_ticks_msec() - t < 5000:
		host.poll()
		await process_frame
	assert(host.peers().size() == 2)
	for guest in guests: guest.stop()
	host.stop()
	print("PASS loop transport: three isolated guests and disconnect")
	quit(0)
