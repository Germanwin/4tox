extends SceneTree

## Регрессия: вторая комната не должна продолжать кормить демо снимками.
## Симптом из игры — два мира попеременно (свой остров и возвращённая сетевая
## партия), газоны перепекаются на каждом кадре, fps падает до 1–3.

const HybridDemo = preload("res://scripts/hybrid_demo.gd")

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


class FakeRoom extends Node:
	signal status(text)
	signal world_ready(world)
	signal snapshot(snap)
	signal command_done(result)
	signal failed(text)
	signal connection(state, detail)
	signal latency(ms)
	signal net_event(kind, data)
	var base := "http://127.0.0.1:1"
	var world = null
	var latest_snapshot: Dictionary = {}
	var is_spectator := false
	var left := false
	func leave() -> void:
		left = true
	func is_started() -> bool:
		return false


func _init() -> void:
	_run()


func _run() -> void:
	print("== регрессия комнат")
	root.size = Vector2i(1440, 900)
	var demo = HybridDemo.new()
	root.add_child(demo)
	var old_room := FakeRoom.new()
	var new_room := FakeRoom.new()
	root.add_child(old_room)
	root.add_child(new_room)
	demo.open_room(old_room, {"mode": "multi"})
	await process_frame
	demo.open_room(new_room, {"mode": "multi"})
	await process_frame
	old_room.snapshot.emit({"revision": 99, "buildings": [{"id": "stale"}]})
	await process_frame
	check(demo._last_snap.get("revision", -1) != 99, "снимок старой комнаты не дошёл до мира")
	check(old_room.left, "старая комната закрыта, а не живёт второй")
	check(demo._live == new_room, "текущая комната — новая")
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
