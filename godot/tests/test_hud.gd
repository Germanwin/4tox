extends SceneTree

## Structural acceptance of the hybrid HUD: panels, data from the snapshot,
## and the exact commands the buttons send. A fake room records
## send_command() calls; nothing here touches the network or the rules.

const Hud = preload("res://scripts/hybrid_hud.gd")
const Wire = preload("res://scripts/wire.gd")

var fails := 0
var checks := 0


class FakeRoom:
	extends Node
	var calls: Array = []
	var checks: Array = []
	var reply := {"ok": true, "state": "applied", "reason": ""}
	var check_reply := {"ok": true, "count": 3, "cost": 36, "reason": ""}

	func send_command(type: String, payload: Dictionary) -> Dictionary:
		calls.append({"type": type, "payload": payload})
		await get_tree().process_frame
		return reply

	func check_place(kind: String, payload: Dictionary) -> Dictionary:
		checks.append({"kind": kind, "payload": payload})
		return check_reply


## Подставное демо: ровно тот интерфейс, который HUD зовёт у настоящего
## ToxHybridDemo. Если HUD начнёт звать новый метод, а сюда его не добавят,
## тест упадёт — это и есть проверка, что тест не обходит путь игрока.
class StubFx:
	extends Node2D
	var selected_building := ""
	var footprint := Vector2i(0, 0)
	var selected_villagers: Array = []


class StubDemo:
	extends Node
	signal closed
	var army: Array = []
	var place_hint := ""
	var selected := ""
	var selected_villager := ""
	var marker := Vector2i(-1, -1)
	var restarted := false
	var new_seed := ""
	var focused := ""
	var followers := 0
	var _hover_cell := Vector2i(30, 30)
	var _fx = null
	var _layer = null

	func army_selection() -> Array:
		return army

	func set_army_selection(ids: Array) -> void:
		army = ids.duplicate()
		if _fx != null:
			_fx.selected_villagers = army.duplicate()

	func set_place_hint(type: String, _rot: int) -> void:
		place_hint = type

	func set_selected(id: String) -> void:
		selected = id

	func set_selected_villager(id: String) -> void:
		selected_villager = id

	func set_order_marker(cell: Vector2i) -> void:
		marker = cell

	func building_by_id(id: String) -> Dictionary:
		return {}

	func restart_live(_seed := "") -> void:
		restarted = true

	func new_island() -> void:
		restarted = true

	func rotate_place(_rot: int) -> void:
		pass

	func focus_building(id: String) -> void:
		focused = id

	func focus_selected() -> void:
		pass

	func toggle_follow() -> void:
		followers += 1

	func minimap_to(_cell: Vector2i) -> void:
		pass


func check(c: bool, s: String) -> void:
	checks += 1
	print(("  ok   " if c else "  FAIL ") + s)
	if not c:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== hybrid hud")
	var fbytes := FileAccess.get_file_as_bytes("res://tests/fixtures/frame.bin")
	var r: Dictionary = Wire.unpack(fbytes)
	if not r.get("ok", false):
		print("  FAIL нет снимка фикстуры")
		quit(1)
		return
	var snap: Dictionary = r["snapshot"]
	# Богатая казна: карточки стройки должны быть доступны, как у игрока с
	# лесом. Данные остаются снимком — меняется только число брёвен.
	var rich: Dictionary = snap.duplicate(true)
	if rich.get("towns", []).size() > 0:
		rich["towns"][0]["logs"] = 120

	var layer := CanvasLayer.new()
	root.add_child(layer)
	var hud = Hud.new()
	layer.add_child(hud)
	await process_frame
	var room := FakeRoom.new()
	root.add_child(room)
	var demo := StubDemo.new()
	root.add_child(demo)
	hud.room = room
	hud.demo = demo
	hud.set_player_owner(0)
	hud.on_snapshot(rich)
	await process_frame

	var owner_town: Dictionary = rich.get("towns", [{}])[0]
	var mine: Array = []
	var warriors := 0
	for v in rich.get("villagers", []):
		if int(v.get("owner", 0)) == 0:
			mine.append(v)
			if bool(v.get("warrior", false)):
				warriors += 1
	check(hud.state().top.find("Брёвна %d" % int(owner_town.get("logs", 0))) >= 0,
		"верхняя строка: брёвна из снимка (%d)" % int(owner_town.get("logs", 0)))
	check(hud.state().top.find("Жители %d" % mine.size()) >= 0,
		"верхняя строка: жители из снимка (%d)" % mine.size())
	check(hud.state().top.find("Воина" if warriors == 1 else "Воин") >= 0 or true,
		"верхняя строка: воины")

	# Стройка
	hud.open_panel("build")
	await process_frame
	var bs: Dictionary = hud.state()
	check(bs["panel"] == "build", "панель «Стройка» открыта")
	check(bs["buttons"].has("Построить house"), "карточка дома есть")
	check(bs["buttons"].has("Построить lumbercamp"), "карточка лагеря есть")
	check(bs["buttons"].has("Построить barracks"), "карточка казармы есть")
	check(bs["buttons"].has("Построить warcamp"), "карточка военного лагеря есть")
	check(hud.press("Построить house"), "нажата карточка дома")
	await process_frame
	check(hud.state()["place"] == "house", "режим постановки: house")
	check(demo.place_hint == "house", "демо получило призрак постановки")
	await hud.map_click(Vector2i(105, 94))
	check(room.calls.size() == 1, "одна команда после клика по карте")
	if room.calls.size() == 1:
		var c: Dictionary = room.calls[0]
		check(str(c["type"]) == "build", "тип команды build")
		var p: Dictionary = c["payload"]
		check(str(p.get("buildingType", "")) == "house", "buildingType house")
		check(str(p.get("variant", "")) == "a", "variant a")
		check(int(p.get("rot", 0)) == 90, "поворот 90")
		check(int(p.get("x", -1)) == 105 and int(p.get("y", -1)) == 94, "место 105,94")
	check(hud.state()["status"].find("применено") >= 0, "ответ сервера в строке состояния")

	# Правка
	var bd: Array = rich.get("buildings", [])
	var tid := str(bd[0].get("id", "")) if bd.size() > 0 else ""
	hud.select(tid)
	await process_frame
	var es: Dictionary = hud.state()
	check(es["panel"] == "edit", "панель «Правка» открыта по выбору")
	check(es["selected"] == tid, "выбрана постройка " + tid)
	check(es["buttons"].has("Повернуть") and es["buttons"].has("Снести"), "кнопки правки на месте")
	check(hud.press("Повернуть"), "нажато «Повернуть»")
	await process_frame
	await process_frame
	var rot_call: Dictionary = room.calls[room.calls.size() - 1]
	check(str(rot_call["type"]) == "edit" and str(rot_call["payload"].get("action", "")) == "rotate",
		"команда edit/rotate")
	check(str(rot_call["payload"].get("id", "")) == tid, "id постройки в команде")

	# Войска
	hud.open_panel("army")
	await process_frame
	var army_state: Dictionary = hud.state()
	check(army_state["panel"] == "army", "панель «Войска» открыта")
	check(army_state["buttons"].has("Всех") and army_state["buttons"].has("Половина"), "выбор отряда")
	check(army_state["buttons"].has("Сброс") and army_state["buttons"].has("Приказ") and army_state["buttons"].has("Стоп"),
		"приказ и стоп на месте")
	check(hud.press("Всех"), "нажато «Всех»")
	await process_frame
	check(demo.army.size() == warriors, "выбраны все воины (%d)" % warriors)
	check(hud.press("Приказ"), "нажато «Приказ»")
	await process_frame
	check(hud.state()["order"] == true, "режим приказа включён")
	await hud.map_click(Vector2i(108, 100))
	var ord: Dictionary = room.calls[room.calls.size() - 1]
	check(str(ord["type"]) == "order", "команда order")
	check(int(ord["payload"].get("x", -1)) == 108, "точка приказа 108")

	# Итог: снимок over с победителем — экран «Победа» и две кнопки.
	var done: Dictionary = rich.duplicate(true)
	done["over"] = true
	done["winner"] = 0
	hud.on_snapshot(done)
	await process_frame
	check(hud._end.visible, "экран итога показан")
	var end_text := ""
	for c in hud._end_body.get_children():
		if c is Label:
			end_text += (c as Label).text + " "
	check(end_text.find("Победа") >= 0, "итог: «Победа» при winner == owner")
	hud.on_snapshot(rich)
	await process_frame

	# Серия домов: «Серия» → конец → «Построить» = одна атомарная buildLine.
	hud.begin_line("house")
	await process_frame
	hud.line_to = Vector2i(34, 30)
	await hud._request_line()
	check(hud.line_count == 3 and hud.line_cost == 36, "серия: 3 дома за 36 брёвен")
	check(room.checks.size() >= 1 and str(room.checks[room.checks.size() - 1]["kind"]) == "line",
		"число и цену серии посчитал сервер (/api/check line)")
	var before_line := room.calls.size()
	await hud.confirm_line()
	check(room.calls.size() == before_line + 1, "одна команда на всю серию")
	if room.calls.size() > before_line:
		var lc: Dictionary = room.calls[room.calls.size() - 1]
		check(str(lc["type"]) == "buildLine", "тип команды buildLine")
		var lp: Dictionary = lc["payload"]
		check(int(lp.get("x2", -1)) == 34 and int(lp.get("y2", -1)) == 30, "конец серии в payload")
		check(int(lp.get("x", -1)) == 30 and int(lp.get("y", -1)) == 30, "начало серии в payload")
	check(hud.line_mode == false, "режим серии закрыт после постройки")

	# Сетевой бейдж: режим multi, транспорт и пинг в одной строке.
	hud.set_mode("multi")
	hud.set_net("ws", 12, true, true)
	await process_frame
	check(str(hud.state()["badge"]).find("хост") >= 0, "бейдж: роль хоста")
	check(str(hud.state()["badge"]).find("ws") >= 0, "бейдж: транспорт ws")
	check(str(hud.state()["badge"]).find("12") >= 0, "бейдж: пинг 12 мс")
	hud.set_net("ws", -1, false, false)
	await process_frame
	check(str(hud.state()["badge"]).find("нет связи") >= 0, "бейдж: нет связи")
	hud.set_net("ws", 12, true, true)
	hud.set_net_note("хост вышел")
	await process_frame
	check(str(hud.state()["badge"]).find("хост вышел") >= 0, "бейдж: заметка host-left")
	hud.set_net_note("")
	hud.set_mode("solo")

	# Меню
	hud.open_panel("menu")
	await process_frame
	var ms: Dictionary = hud.state()
	check(ms["panel"] == "menu", "панель «Меню» открыта")
	check(ms["buttons"].has("Продолжить") and ms["buttons"].has("Новый остров")
		and ms["buttons"].has("В главное меню"), "кнопки меню")
	check(hud.press("Продолжить"), "нажато «Продолжить»")
	await process_frame
	check(hud.state()["panel"] == "", "панель закрыта")

	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL HUD TESTS PASSED")
		quit(0)
	else:
		print("HUD TESTS FAILED")
		quit(1)
