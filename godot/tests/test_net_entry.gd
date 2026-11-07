extends SceneTree

## Экран сети: «Создать игру» ходит на origin без `/game/`, а 443 на VPS
## делит листенер с naive-прокси: при включённом VPN он то отвечает
## `407 Proxy Authentication Required`, то рвёт соединение до ответа.
## Снимок экрана 2026-11-04 12:38 показал на этом «локальный сервер не
## ответил: проверьте адрес» — то есть клиент назвал неверным верный адрес.
##
## Приёмка проверяет три вещи, которых не было:
##   1) отказ называется словами: нет связи / 407 от прокси / HTTP 404 /
##      причина сервера — а не одно «проверьте адрес» на всё подряд;
##   2) сетевой сбой ДО отправки повторяется, и повтор не создаёт второе
##      лобби (у сервера один слот `MAX_ACTIVE_ROOMS`);
##   3) если основной вход не ответил, идём запасным (на VPS это 8443,
##      отдельный сайт без forward_proxy) и показываем, каким входим.
##
## Заглушки входов — `tests/fake_entry.js`; прод не трогаем.

const NetLobby = preload("res://scripts/net_lobby.gd")
const Supervisor = preload("res://scripts/server_supervisor.gd")

## Порт 1 на loopback закрыт всегда: это «нет сети до входа».
const DEAD := "http://127.0.0.1:1"

var fails := 0
var checks := 0
var sup = null
var lob = null
var pids: Array = []
## Приёмка не должна висеть, если проверка упала на исчезнувшем методе:
## сторож досрочно завершает прогон с провалом.
var _done := false


func check(ok: bool, text: String) -> void:
	checks += 1
	print(("  ok   " if ok else "  FAIL ") + text)
	if not ok:
		fails += 1


func _init() -> void:
	_run()


func _run() -> void:
	_watchdog(240.0)
	print("== экран сети: вход и причины отказа")
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	if not (await sup.start_server()):
		check(false, "сервер поднялся")
		_finish()
		return

	var layer := CanvasLayer.new()
	root.add_child(layer)
	lob = NetLobby.new()
	layer.add_child(lob)
	await process_frame

	# 1. Адрес — origin. Схему дописываем, `/game/` срезаем.
	check(lob._norm_base("https://374412.fornex.cloud/") == "https://374412.fornex.cloud",
		"хвостовой слэш срезан")
	check(lob._norm_base("https://374412.fornex.cloud/game/") == "https://374412.fornex.cloud",
		"`/game/` срезан до origin")
	check(lob._norm_base("374412.fornex.cloud") == "https://374412.fornex.cloud",
		"адрес без схемы получает https://")
	check(lob._norm_base("127.0.0.1:8787") == "http://127.0.0.1:8787",
		"loopback без схемы — http://")

	# 2. Запасной вход — только https-origin без явного порта.
	check(lob._fallback_for("https://374412.fornex.cloud") == "https://374412.fornex.cloud:8443",
		"https без порта → запасной вход 8443")
	check(lob._fallback_for("https://374412.fornex.cloud:8443") == "",
		"явный порт — второго входа не выдумываем")
	check(lob._fallback_for("http://127.0.0.1:8787") == "",
		"локальному серверу запасной вход не нужен")

	# 3. Основной вход молчит, запасной жив: игра создаётся, вход запомнен.
	lob.open(DEAD, "тихая-долина-701", 64, sup.base)
	lob.set_player_name("Запасной")
	lob.press("Создать игру")
	var joined := await _wait_for(func() -> bool: return lob.joined, 20.0)
	check(joined, "лобби создано через запасной вход")
	var st: Dictionary = lob.state()
	check(str(st.get("base", "")) == sup.base, "база переключена на запасной вход: " + str(st.get("base", "")))
	check(str(st.get("addr", "")) == sup.base, "поле адреса показывает вход, которым играем")
	check(str(st.get("status", "")).find("вход") >= 0,
		"статус называет вход: " + str(st.get("status", "")))

	# 3б. Тот же запасной вход, но комната уже создана (второй заход по
	#     кнопке): подсказка входа не должна теряться при пересоздании.
	lob.open(DEAD, "тихая-долина-701", 64, sup.base)
	lob.press("Создать игру")
	check(await _wait_for(func() -> bool: return lob.joined, 20.0),
		"запасной вход работает и на втором заходе")
	if lob.room != null:
		lob.room.leave()
	lob.close_room()
	await _pause(0.3)

	# 4. Оба входа молчат: причина — сеть, а не выдуманный неверный адрес.
	lob.open(DEAD, "тихая-долина-701", 64)
	lob.press("Создать игру")
	var dead_text := await _wait_status()
	check(dead_text.find("связ") >= 0, "нет связи названо словами: " + dead_text)
	check(dead_text.find("проверьте адрес") < 0, "верный адрес больше не обвиняют")
	check(dead_text.find("локальный сервер") < 0, "фраза «локальный сервер не ответил» ушла")
	check(str(lob.room.get("last_error")) != "", "причина отказа сохранена для экрана")

	# 5. 407 от прокси на 443: так отвечает naive-прокси, а не игра.
	var p407 := await _stub("proxy407", 1)
	lob.open(p407, "тихая-долина-701", 64)
	lob.press("Создать игру")
	var text407 := await _wait_status()
	check(text407.find("407") >= 0, "код 407 показан: " + text407)
	check(text407.find("прокси") >= 0 or text407.find("VPN") >= 0, "407 объяснён как прокси/VPN")
	check(text407.find("проверьте адрес") < 0, "407 не выдаётся за неверный адрес")

	# 5б. 407 — ответ прокси, а не игры: при живом запасном входе идём туда.
	lob.open(p407, "тихая-долина-701", 64, sup.base)
	lob.press("Создать игру")
	check(await _wait_for(func() -> bool: return lob.joined, 20.0),
		"на 407 от прокси клиент уходит запасным входом")
	check(bool(lob.state().get("used_fallback", false)), "407: вход помечен как запасной")
	if lob.room != null:
		lob.room.leave()
	lob.close_room()
	await _pause(0.3)

	# 6. Сервер отказал по-своему: его слова, а не «нет ответа».
	var pcap := await _stub("capacity", 2)
	lob.open(pcap, "тихая-долина-701", 64)
	lob.press("Создать игру")
	var textcap := await _wait_status()
	check(textcap.find("слишком много лобби") >= 0,
		"причина сервера дошла до экрана: " + textcap)
	check(textcap.find("связ") < 0, "отказ сервера не выдан за обрыв связи")

	# 7. На адресе нет игры (404 HTML): так выглядит `/game/` в поле адреса.
	var p404 := await _stub("html404", 3)
	lob.open(p404, "тихая-долина-701", 64)
	lob.press("Создать игру")
	var text404 := await _wait_status()
	check(text404.find("404") >= 0, "404 показан: " + text404)
	check(text404.find("origin") >= 0, "404 объяснён: нужен origin без /game/")

	# 8. Первое соединение оборвалось — повтор, и ровно одно лобби.
	var phold := _port(4)
	check(not (await _can_connect(phold)), "до заглушки порт закрыт: первый заход — отказ")
	_spawn("hold", phold, "300")
	lob.open("http://127.0.0.1:%d" % phold, "тихая-долина-701", 64)
	lob.press("Создать игру")
	var retried := await _wait_for(func() -> bool: return lob.joined, 20.0)
	check(retried, "лобби создано после обрыва первого соединения")
	var stats: Dictionary = await _json_get("http://127.0.0.1:%d/api/_stats" % phold)
	check(int(stats.get("posts", -1)) == 1,
		"повтор не создал второе лобби: POST /api/lobby %s" % str(stats.get("posts", "?")))
	lob.close_room()
	await _pause(0.3)

	# 9. Наблюдатель на молчащем входе: причина на экране, без падения на
	#    несуществующем `last_error`.
	lob.open(DEAD, "тихая-долина-701", 64)
	lob.set_code("QATST")
	lob.press("Смотреть")
	var textspec := await _wait_status()
	check(textspec.find("не удалось") >= 0, "наблюдатель: причина на экране: " + textspec)
	check(textspec.find("входим наблюдателем") < 0, "наблюдатель не завис на «входим»")

	_finish()


# ---------------------------------------------------------------- заглушки

func _port(n: int) -> int:
	return 8950 + (OS.get_process_id() % 30) + n * 3


func _stub(mode: String, n: int) -> String:
	var port := _port(n)
	_spawn(mode, port, "")
	var url := "http://127.0.0.1:%d" % port
	# Ждём, пока заглушка начнёт слушать: 407/404/capacity отвечают сразу.
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < 5000:
		var probe: Dictionary = await _json_get("%s/api/_stats" % url)
		if probe.get("ok", false):
			break
		await _pause(0.05)
	return url


func _spawn(mode: String, port: int, delay: String) -> int:
	var args := [ProjectSettings.globalize_path("res://tests/fake_entry.js"), str(port), mode]
	if delay != "":
		args.append(delay)
	var pid := OS.create_process("node", args)
	pids.append(pid)
	return pid


func _can_connect(port: int) -> bool:
	var http := HTTPRequest.new()
	http.timeout = 2.0
	root.add_child(http)
	var err := http.request("http://127.0.0.1:%d/api/_stats" % port)
	var ok := false
	if err == OK:
		var res: Array = await http.request_completed
		ok = int(res[0]) == HTTPRequest.RESULT_SUCCESS
	http.queue_free()
	return ok


func _json_get(url: String) -> Dictionary:
	var http := HTTPRequest.new()
	http.timeout = 3.0
	root.add_child(http)
	var err := http.request(url)
	if err != OK:
		http.queue_free()
		return {"ok": false}
	var res: Array = await http.request_completed
	http.queue_free()
	if int(res[0]) != HTTPRequest.RESULT_SUCCESS or int(res[1]) != 200:
		return {"ok": false}
	var data: Variant = JSON.parse_string((res[3] as PackedByteArray).get_string_from_utf8())
	return data if data is Dictionary else {"ok": false}


func _wait_status() -> String:
	var before: String = str(lob.state().get("status", ""))
	await _wait_for(func() -> bool:
		return str(lob.state().get("status", "")) != before \
			and str(lob.state().get("status", "")).find("…") < 0, 20.0)
	return str(lob.state().get("status", ""))


func _pause(s: float) -> void:
	await create_timer(s).timeout


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _watchdog(limit_s: float) -> void:
	await create_timer(limit_s).timeout
	if _done:
		return
	print("== время вышло (%d с): приёмка не дошла до конца" % int(limit_s))
	for pid in pids:
		if int(pid) > 0:
			OS.kill(int(pid))
	quit(1)


func _finish() -> void:
	_done = true
	for pid in pids:
		if int(pid) > 0:
			OS.kill(int(pid))
	if lob != null:
		lob.close_room()
		lob.queue_free()
	if sup != null:
		sup.stop()
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL NET ENTRY TESTS PASSED")
		quit(0)
	else:
		print("NET ENTRY TESTS FAILED")
		quit(1)
