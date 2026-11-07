extends SceneTree
const Loop = preload("res://scripts/eos/loop_link.gd")
const Tunnel = preload("res://scripts/eos/tunnel.gd")
func _init() -> void:
	_run()
func _run() -> void:
	await process_frame
	var h = Loop.new()
	h.listen_port = 0
	assert(h.start_host())
	var g = Loop.new()
	assert(g.start_client(h.room_id()))
	var ht = Tunnel.new()
	var leaked := [false]
	h.packet.connect(func(_peer: int, data: PackedByteArray) -> void:
		if data.get_string_from_utf8().contains("correct-ticket"): leaked[0] = true)
	ht.require_auth = true
	ht.set_authorized_hashes(["correct-ticket".sha256_text()])
	root.add_child(ht)
	assert(ht.start_host(h, 9))
	var gt = Tunnel.new()
	gt.require_auth = true
	gt.auth_token = "wrong-ticket"
	root.add_child(gt)
	var received := [false]
	gt.meta.connect(func(_d: Dictionary) -> void: received[0] = true)
	assert(gt.start_guest(g) > 0)
	ht.publish_meta({"code": "private"})
	await create_timer(1.2).timeout
	assert(not received[0])
	gt.auth_token = "correct-ticket"
	await create_timer(1.2).timeout
	assert(received[0])
	assert(not leaked[0])
	assert(ht._authenticated.size() == 1)
	var peer: int = ht._authenticated.keys()[0]
	var key: int = ht._key(peer, 99)
	var buffered := PackedByteArray()
	buffered.resize(Tunnel.OUT_MAX)
	ht._streams[key] = {"tcp": StreamPeerTCP.new(), "out": buffered, "peer": peer, "stream": 99}
	ht._write(key, PackedByteArray([1]))
	assert(not h.peers().has(peer))
	ht.set_authorized_hashes([])
	assert(ht._authenticated.is_empty())
	gt.stop()
	ht.stop()
	g.stop()
	h.stop()
	print("PASS tunnel rejects unknown ticket, admits and revokes member")
	quit(0)
