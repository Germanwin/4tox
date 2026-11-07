extends SceneTree

## Красный тест оптимистичной постройки: дом стоит в мире СРАЗУ после клика,
## а команда серверу ещё в пути. Раньше `map_click` ждал `/api/command-state`
## до 8 секунд, и только потом дом появлялся в кадре.

const Hud = preload("res://scripts/hybrid_hud.gd")

var fails := 0
var checks := 0


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


class SlowRoom:
	extends Node
	var calls: Array = []
	var reply := {"ok": true, "state": "applied", "reason": ""}

	func send_command(type: String, payload: Dictionary) -> Dictionary:
		calls.append({"type": type, "payload": payload})
		await get_tree().create_timer(0.5).timeout
		return reply


class StubDemo:
	extends Node
	signal closed
	var pending: Array = []
	var place_hint := ""
	var _fx = null
	var _layer = null

	func add_pending_build(spec: Dictionary, owner: int) -> Dictionary:
		var b := spec.duplicate(true)
		b["id"] = "pend:%d" % pending.size()
		b["owner"] = owner
		b["pending"] = true
		pending.append(b)
		return b

	func set_place_hint(type: String, _rot: int) -> void:
		place_hint = type

	func rotate_place(_rot: int) -> void:
		pass

	func set_order_marker(_cell: Vector2i) -> void:
		pass

	func minimap_to(_cell: Vector2i) -> void:
		pass


func _init() -> void:
	_run()


func _run() -> void:
	print("== постройка без ожидания сервера")
	var layer := CanvasLayer.new()
	root.add_child(layer)
	var hud = Hud.new()
	layer.add_child(hud)
	await process_frame
	var room := SlowRoom.new()
	root.add_child(room)
	var demo := StubDemo.new()
	root.add_child(demo)
	hud.room = room
	hud.demo = demo
	hud.set_player_owner(0)
	hud.on_snapshot({
		"revision": 1, "towns": [{"owner": 0, "logs": 120, "color": "#4a90d9",
			"alive": true}], "buildings": [], "villagers": [], "over": false})
	hud.begin_place("house", "Дом")
	hud.map_click(Vector2i(40, 40))
	await process_frame
	await process_frame
	check(demo.pending.size() == 1, "дом появился в мире до ответа сервера")
	if demo.pending.size() == 1:
		var b: Dictionary = demo.pending[0]
		check(int(b.get("x", -1)) == 40 and int(b.get("y", -1)) == 40,
			"ожидающий дом стоит в клетке клика")
		check(bool(b.get("pending", false)), "дом помечен как ожидающий")
	check(room.calls.size() == 1, "команда серверу всё-таки ушла")
	await create_timer(0.8).timeout
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
