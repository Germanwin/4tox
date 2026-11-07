extends SceneTree

## EOS-режим без Epic: проверяется тот слой, который от EOS не зависит.
##
## Хозяин поднимает настоящий Node-сервер, гость приходит к нему через
## туннель поверх транспорта-петли (тот же интерфейс, что у EOS P2P):
## HTTP-лобби, WLD1, WebSocket и 4TX1-кадры, команда гостя, мета-канал.
##
## Запуск: godot --headless --path . -s res://tests/test_eos_tunnel.gd
## Порог: 0 FAIL.

const Supervisor = preload("res://scripts/server_supervisor.gd")
const LiveRoom = preload("res://scripts/live_room.gd")

var fails := 0
var checks := 0
var sup = null
var host_room = null
var guest_room = null
var guest_world = null
var guest_snap: Dictionary = {}
var guest_err := ""
var host_snap: Dictionary = {}
var meta_in: Dictionary = {}


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _on_guest_world(w) -> void:
	guest_world = w


func _on_guest_snap(s) -> void:
	guest_snap = s


func _on_host_snap(s) -> void:
	host_snap = s


func _on_guest_fail(t: String) -> void:
	guest_err = t


func _on_meta(d: Dictionary) -> void:
	meta_in = d


func _init() -> void:
	_run()


func _wait_until(what: Callable, timeout_ms: int) -> bool:
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < timeout_ms:
		if what.call():
			return true
		await process_frame
	return false


func _run() -> void:
	print("== eos tunnel")
	var tunnel_script = load("res://scripts/eos/tunnel.gd")
	var loop_script = load("res://scripts/eos/loop_link.gd")
	check(tunnel_script != null and tunnel_script.can_instantiate(), "туннель существует")
	check(loop_script != null, "транспорт-петля существует")
	if tunnel_script == null or loop_script == null:
		_finish()
		return

	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	create_timer(90.0).timeout.connect(func() -> void:
		print("  FAIL общий таймаут 90 с")
		fails += 1
		_finish())
	var up: bool = await sup.start_server()
	check(up, "хозяин поднял Node-сервер: " + str(sup.base))
	if not up:
		_finish()
		return

	var host_link = loop_script.new()
	host_link.listen_port = 0
	check(host_link.start_host(), "петля хозяина слушает")
	var loop_port := int(host_link.room_id())
	var guest_link = loop_script.new()
	check(guest_link.start_client(str(loop_port)), "гость подключился к петле " + str(loop_port))

	var host_tun = tunnel_script.new()
	host_tun.name = "HostTunnel"
	root.add_child(host_tun)
	check(host_tun.start_host(host_link, int(sup.port)), "туннель хозяина смотрит в сервер")
	var guest_tun = tunnel_script.new()
	guest_tun.name = "GuestTunnel"
	root.add_child(guest_tun)
	guest_tun.meta.connect(_on_meta)
	var gport: int = guest_tun.start_guest(guest_link)
	check(gport > 0, "туннель гостя слушает 127.0.0.1:" + str(gport))
	if gport <= 0:
		_finish()
		return

	host_room = LiveRoom.new()
	host_room.name = "HostRoom"
	host_room.persist_session = false
	root.add_child(host_room)
	host_room.snapshot.connect(_on_host_snap)
	var made: bool = await host_room.create_lobby(sup.base, "Хозяин",
		"тихая-долина-701", 64, 2)
	check(made and host_room.code != "", "лобби хозяина: код " + str(host_room.code))
	if not made:
		_finish()
		return

	host_tun.publish_meta({"code": host_room.code, "seed": "тихая-долина-701", "size": 64})
	var got_meta: bool = await _wait_until(func() -> bool: return not meta_in.is_empty(), 8000)
	check(got_meta and str(meta_in.get("code", "")) == host_room.code,
		"гость получил код комнаты по мета-каналу")

	guest_room = LiveRoom.new()
	guest_room.name = "GuestRoom"
	guest_room.persist_session = false
	root.add_child(guest_room)
	guest_room.world_ready.connect(_on_guest_world)
	guest_room.snapshot.connect(_on_guest_snap)
	guest_room.failed.connect(_on_guest_fail)

	var gbase := "http://127.0.0.1:%d" % gport
	var joined: bool = await guest_room.join_lobby(gbase, host_room.code, "Гость")
	check(joined, "гость вошёл по коду через туннель" +
		("" if guest_err == "" else " (" + guest_err + ")"))
	if not joined:
		_finish()
		return

	await host_room.set_ready(true)
	await guest_room.set_ready(true)
	var started: bool = await host_room.start_now()
	check(started, "хозяин начал партию")

	var got: bool = await _wait_until(
		func() -> bool: return guest_world != null and not guest_snap.is_empty(), 30000)
	check(guest_world != null, "гость получил WLD1" +
		("" if guest_err == "" else " (" + guest_err + ")"))
	check(not guest_snap.is_empty(), "гость получил кадр 4TX1")
	check(got, "кадры идут через туннель")
	if guest_world != null:
		check(guest_world.width > 0 and guest_world.objects.size() > 0,
			"мир %dx%d, объектов %d" % [guest_world.width, guest_world.height,
				guest_world.objects.size()])
	check(int(guest_room.frames) > 0, "кадров у гостя: " + str(guest_room.frames))
	check(not host_snap.is_empty(), "хозяин тоже получает кадры")

	var hall: Dictionary = {}
	var guest_owner := int(guest_room.my_owner)
	for b in guest_snap.get("buildings", []):
		if str(b.get("type", "")) == "townhall" and int(b.get("owner", -1)) == guest_owner:
			hall = b
			break
	check(not hall.is_empty(), "ратуша гостя (деревня %d) видна в снимке" % guest_owner)
	if not hall.is_empty():
		var before := int(hall.get("rot", 0))
		var res: Dictionary = await guest_room.send_command("edit",
			{"action": "rotate", "id": str(hall.get("id", ""))})
		check(res.get("ok", false), "команда гостя пришла: " +
			str(res.get("state", "")) + " " + str(res.get("reason", "")))
		var rotated: bool = await _wait_until(func() -> bool:
			for b in guest_snap.get("buildings", []):
				if str(b.get("id", "")) == str(hall.get("id", "")) \
						and int(b.get("rot", 0)) != before:
					return true
			return false, 8000)
		check(rotated, "поворот виден в снимке гостя")

	await host_room.leave()
	await guest_room.leave()
	_finish()


func _finish() -> void:
	if host_room != null:
		host_room.queue_free()
	if guest_room != null:
		guest_room.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL EOS TUNNEL TESTS PASSED")
		quit(0)
	else:
		print("EOS TUNNEL TESTS FAILED")
		quit(1)
