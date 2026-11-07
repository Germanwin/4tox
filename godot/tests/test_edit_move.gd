extends SceneTree

## Регрессия: «Двигать» ведёт постройку за курсором, а не телепортирует её
## первым же кликом. Команда уходит только по «Применить»; «Отменить» —
## локальный отказ, сервер не трогаем.

const Hud = preload("res://scripts/hybrid_hud.gd")

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


class FakeRoom extends Node:
	var calls: Array = []
	func send_command(type: String, payload: Dictionary) -> Dictionary:
		calls.append({"type": type, "payload": payload})
		return {"ok": true, "state": "applied", "reason": ""}
	func check_place(_kind: String, _payload: Dictionary) -> Dictionary:
		return {"ok": true, "reason": ""}


class FakeDemo extends Node:
	var b := {"id": "b0", "type": "house", "variant": "a", "rot": 90, "x": 10, "y": 10}
	var started := ""
	var started_grab := Vector2i.ZERO
	var placed := Vector2i(-1, -1)
	var cancelled := false
	var committed := Vector2i(-1, -1)
	func building_by_id(id: String) -> Dictionary:
		return b if str(b["id"]) == id else {}
	func begin_move(id: String, grab: Vector2i) -> void:
		started = id
		started_grab = grab
	func place_move(cell: Vector2i) -> void:
		placed = cell
	func move_target() -> Vector2i:
		return placed
	func cancel_move() -> void:
		cancelled = true
		placed = Vector2i(-1, -1)
	func commit_move() -> Dictionary:
		committed = placed
		var out := {"ok": true, "x": placed.x, "y": placed.y}
		placed = Vector2i(-1, -1)
		return out
	func army_selection() -> Array:
		return []
	func focus_selected() -> void:
		pass
	func toggle_follow() -> void:
		pass
	func set_follow(_v: bool) -> void:
		pass
	func move_valid() -> bool:
		return true
	func move_placed() -> bool:
		return placed.x >= 0
	func move_reason() -> String:
		return ""
	func set_place_hint(_type: String, _rot: int) -> void:
		pass
	func set_order_marker(_cell: Vector2i) -> void:
		pass


func _init() -> void:
	_run()


func _run() -> void:
	print("== перенос постройки")
	root.size = Vector2i(1440, 900)
	var hud = Hud.new()
	root.add_child(hud)
	await process_frame
	var room := FakeRoom.new()
	var demo := FakeDemo.new()
	root.add_child(room)
	root.add_child(demo)
	hud.room = room
	hud.demo = demo
	hud.select("b0")
	await process_frame
	check(hud.panel == "edit", "правка открыта")
	check(hud.press("Двигать"), "нажато «Двигать»")
	await process_frame
	check(demo.started == "b0", "демо начало ведение")
	check(room.calls.is_empty(), "до клика команда не уходит")
	await hud.map_click(Vector2i(13, 12))
	check(demo.placed == Vector2i(13, 12), "клик поставил призрак в 13,12")
	check(room.calls.is_empty(), "перенос ещё не отправлен серверу")
	check(hud.press("Применить"), "нажато «Применить»")
	await process_frame
	await process_frame
	check(room.calls.size() == 1, "ушла одна команда переноса")
	if room.calls.size() == 1:
		var c: Dictionary = room.calls[0]
		check(str(c["type"]) == "edit" and str(c["payload"].get("action", "")) == "move",
			"команда edit/move")
		check(int(c["payload"].get("x", -1)) == 13 and int(c["payload"].get("y", -1)) == 12,
			"место 13,12")
	hud.select("b0")
	await process_frame
	hud.press("Двигать")
	await hud.map_click(Vector2i(15, 14))
	hud.press("Отменить правку")
	await process_frame
	check(demo.cancelled, "«Отменить» отменила ведение")
	check(room.calls.size() == 1, "отмена не отправила команду")
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
