extends SceneTree

## Раскладка HUD как в браузере: ресурсы слева сверху, действия справа сверху,
## подсказки слева снизу, обзор справа снизу, стройка — справа.

const Hud = preload("res://scripts/hybrid_hud.gd")

var fails := 0
var checks := 0

func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	print("== раскладка HUD")
	root.size = Vector2i(1440, 900)
	var hud = Hud.new()
	root.add_child(hud)
	await process_frame
	await process_frame
	var vp := Vector2(1440, 900)
	check(hud._top.get_global_rect().position.x < 40 and hud._top.get_global_rect().position.y < 40,
		"ресурсы сверху слева")
	check(hud._village_btn.get_global_rect().position.x > hud._top.get_global_rect().end.x - 2,
		"«Деревня» сразу справа от ресурсов")
	var army: Button = hud.buttons.get("Войска")
	var build: Button = hud.buttons.get("Стройка")
	var menu: Button = hud.buttons.get("Меню")
	check(army != null and build != null and menu != null, "три кнопки действий")
	if army != null and build != null and menu != null:
		var ar := army.get_global_rect()
		var br := build.get_global_rect()
		var mr := menu.get_global_rect()
		check(ar.position.y < 40 and br.position.y < 40 and mr.position.y < 40,
			"кнопки действий сверху")
		check(ar.end.x <= br.position.x + 1 and br.end.x <= mr.position.x + 1,
			"порядок: Войска · Стройка · Меню")
		check(mr.end.x > vp.x - 40, "правый угол занят меню")
	check(not hud.buttons.has("Правка"), "отдельной кнопки «Правка» сверху нет")
	check(hud._hints.get_global_rect().position.y > vp.y - 220,
		"подсказки снизу слева")
	check(hud._mm_panel.get_global_rect().position.x > vp.x - 260
		and hud._mm_panel.get_global_rect().position.y > vp.y - 300,
		"обзор снизу справа")
	check(hud.buttons.has("Зум −") and hud.buttons.has("Зум +"), "кнопки зума у обзора")
	hud.open_panel("build")
	await process_frame
	check(hud._panel.visible, "панель стройки видна")
	check(hud._panel.get_global_rect().position.x > vp.x * 0.6,
		"стройка справа, а не по центру")
	hud.open_panel("village")
	await process_frame
	check(hud._village.visible, "панель деревни открывается")
	print("итог: %d проверок, %d FAIL" % [checks, fails])
	quit(1 if fails > 0 else 0)
