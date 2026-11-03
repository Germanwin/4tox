extends SceneTree

## The app must expose the new renderer from the menu: a button, a demo state,
## and a clean return to the menu. This is the link that was missing — the
## renderer existed only in tests.

var fails := 0
var checks := 0


func check(c: bool, s: String) -> void:
	checks += 1
	print(("  ok   " if c else "  FAIL ") + s)
	if not c:
		fails += 1


func find_button(root: Node, text: String) -> Button:
	for n in root.find_children("*", "Button", true, false):
		if n is Button and n.text == text:
			return n
	return null


func _init() -> void:
	print("== hybrid demo")
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	await create_timer(1.5).timeout

	check(find_button(main.menu, "Новый рендер") != null, "в меню есть кнопка нового рендера")
	check(find_button(main.menu, "Живая комната") != null, "в меню есть кнопка живой комнаты")
	main._on_hybrid()
	await create_timer(0.6).timeout
	check(main.state == main.State.DEMO, "состояние DEMO")
	check(main.demo.visible, "демо видно")
	check(not main.view.visible, "старый вид скрыт")
	check(not main.menu.visible, "меню скрыто")
	check(main.demo._layer != null, "слой мира создан")
	check(main.demo._layer != null and main.demo._layer.villagers.size() == 6,
		"6 жителей из снимка сервера")
	check(main.demo._layer != null and main.demo._layer.buildings.size() == 6,
		"6 построек из снимка сервера")
	check(main.demo._snapshot_seq >= 0, "снимок 4TX1 разобран")
	check(main.demo._world != null and str(main.demo._world.worldgen_hash) == "af3a0bff",
		"демо рисует фикстурный мир af3a0bff")

	# Убранное сервером (removed) не должно рисоваться: иначе под домами
	# остаются камни и кусты, которых в комнате уже нет.
	var Wire = load("res://scripts/wire.gd")
	var WorldData = load("res://scripts/world_data.gd")
	var ref = WorldData.new()
	ref.load_json(FileAccess.get_file_as_string("res://tests/fixtures/world.json"))
	var fres: Dictionary = Wire.unpack(FileAccess.get_file_as_bytes("res://tests/fixtures/frame.bin"))
	var hex := str(fres["snapshot"].get("removed", ""))
	var removed := 0
	for bi in range(hex.length() / 2):
		var b := ("0x" + hex.substr(bi * 2, 2)).hex_to_int()
		for bit in range(8):
			if b & (1 << bit):
				removed += 1
	check(main.demo._layer.objects.size() == ref.objects.size() - removed,
		"объектов %d = %d минус убранные %d" % [main.demo._layer.objects.size(), ref.objects.size(), removed])

	main._on_demo_closed()
	await process_frame
	check(main.state == main.State.MENU, "вернулись в меню")
	check(main.menu.visible and main.view.visible, "меню и старый вид снова видны")
	check(not main.demo.visible, "демо скрыто")
	check(main.demo._ui == null or not main.demo._ui.visible, "HUD-слой скрыт")
	check(main.demo._canvas == null or not main.demo._canvas.visible, "мир-слой скрыт")

	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL DEMO TESTS PASSED")
		quit(0)
	else:
		print("DEMO TESTS FAILED")
		quit(1)
