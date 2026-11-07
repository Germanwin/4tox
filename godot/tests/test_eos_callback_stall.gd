extends SceneTree

signal fake_callback(data)
var emit_on_process := false

class Emitter:
	extends Node
	var owner_tree
	func _process(_delta: float) -> void:
		if owner_tree.emit_on_process:
			owner_tree.emit_on_process = false
			owner_tree.fake_callback.emit({"ok": true})

func _init() -> void:
	_run()

func _run() -> void:
	await create_timer(0.5).timeout
	var node := Emitter.new()
	node.owner_tree = self
	root.add_child(node)
	var script = load("res://scripts/eos/p2p_link.gd")
	var link = script.new()
	var result = await link._once(self, fake_callback, func() -> void: call_deferred("_stall"), 100)
	var ok: bool = result is Dictionary and result.get("ok", false)
	# Обрыв может привести к уничтожению peer в обработчике. Оно должно
	# произойти после возврата из нативного callback, а не внутри него.
	link._peer = EOSGMultiplayerPeer.new()
	var received := []
	link.peer_down.connect(func(id: int) -> void: received.append(id))
	link._on_peer_disconnected(7, link._peer_generation)
	ok = ok and received.is_empty()
	await process_frame
	ok = ok and received == [7]
	link._on_peer_disconnected(8, link._peer_generation)
	link.stop()
	await process_frame
	ok = ok and received == [7]
	print("EOS CALLBACK AFTER STALL: ", "PASS" if ok else "FAIL")
	node.queue_free()
	quit(0 if ok else 1)

func _stall() -> void:
	OS.delay_msec(250)
	emit_on_process = true
