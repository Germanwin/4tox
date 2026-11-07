extends SceneTree

## Окна игры независимы: у каждого свой номер, своя сессия последней партии и
## свой каталог локального сервера. Без этого второе окно перетирает
## `user://net-session.cfg` первого, а два локальных сервера читают один
## `state/rooms` и закрывают комнаты друг друга.

const LiveRoom = preload("res://scripts/live_room.gd")
const ClientProfile = preload("res://scripts/client_profile.gd")

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
	print("== профиль клиента")
	check(ClientProfile.session_path(1) == "user://net-session.cfg",
		"клиент 1 — старое имя сессии")
	check(ClientProfile.session_path(2) == "user://net-session-2.cfg",
		"клиент 2 — своя сессия: " + ClientProfile.session_path(2))
	check(ClientProfile.state_root(1) == "user://state",
		"клиент 1 — старое состояние")
	check(ClientProfile.state_root(2) == "user://state/client-2",
		"клиент 2 — своё состояние: " + ClientProfile.state_root(2))
	check(ClientProfile.log_name(1) == "server.log",
		"клиент 1 — старый лог")
	check(ClientProfile.log_name(2) == "server-2.log",
		"клиент 2 — свой лог: " + ClientProfile.log_name(2))
	check(ClientProfile.title(1) == "4tox", "клиент 1 — обычный заголовок")
	check(ClientProfile.title(2) == "4tox — клиент 2",
		"клиент 2 — заголовок с номером: " + ClientProfile.title(2))

	# Номер занят каталогом-замком: второй клиент в этом же процессе тоже может
	# занять его, а после release замка нет и номер не считается живым.
	ClientProfile.release(2)
	check(not ClientProfile.live_ids().has(2), "номер 2 свободен")
	check(ClientProfile.claim(2), "номер 2 занят этим процессом")
	check(ClientProfile.live_ids().has(2), "номер 2 виден живым")
	ClientProfile.release(2)
	check(not ClientProfile.live_ids().has(2), "номер 2 снова свободен")

	# Две сессии на диске не перетирают друг друга.
	LiveRoom.clear_session(1)
	LiveRoom.clear_session(2)
	var one = LiveRoom.new()
	one.session_profile = 1
	one.base = "https://one.example"
	one.code = "AAA11"
	one.token = "token-one"
	one.player_id = 1
	one.is_host = true
	one._save_session()
	var two = LiveRoom.new()
	two.session_profile = 2
	two.base = "https://two.example"
	two.code = "BBB22"
	two.token = "token-two"
	two.player_id = 2
	two.is_host = false
	two._save_session()
	check(LiveRoom.session_exists(1) and LiveRoom.session_exists(2),
		"обе сессии лежат на диске")
	var i1 := LiveRoom.session_info(1)
	var i2 := LiveRoom.session_info(2)
	check(str(i1.get("token", "")) == "token-one", "сессия 1 не перетёрта")
	check(str(i2.get("token", "")) == "token-two", "сессия 2 своя")
	check(str(i1.get("code", "")) == "AAA11", "код 1 свой")
	check(str(i2.get("code", "")) == "BBB22", "код 2 свой")
	one._clear_session()
	check(not LiveRoom.session_exists(1), "выход клиента 1 стёр только свою сессию")
	check(LiveRoom.session_exists(2), "сессия клиента 2 осталась")
	two._clear_session()

	one.free()
	two.free()
	_finish()


func _finish() -> void:
	print("== проверок %d, провалов %d" % [checks, fails])
	if fails == 0:
		print("ALL CLIENT PROFILE TESTS PASSED")
		quit(0)
	else:
		print("CLIENT PROFILE TESTS FAILED")
		quit(1)
