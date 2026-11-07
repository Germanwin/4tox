extends Node

const HybridDemo = preload("res://scripts/hybrid_demo.gd")
const Supervisor = preload("res://scripts/server_supervisor.gd")
const NetLobby = preload("res://scripts/net_lobby.gd")
const EosLobby = preload("res://scripts/eos/lobby.gd")
const LiveRoom = preload("res://scripts/live_room.gd")
const ClientProfile = preload("res://scripts/client_profile.gd")

enum State { MENU, LOBBY, PLAY, PAUSE, OVER, GALLERY, DEMO }

var sim: ToxSim
var view: ToxWorldView
var hud: ToxHUD
var menu: ToxMenu
var lobby: ToxLobby
var net: ToxNet
var gallery: ToxModelGallery
var demo: Node2D
var net_lobby = null
var eos_lobby = null
var server = null
var ui_layer: CanvasLayer
var loading_layer: CanvasLayer
var loading_rect: ColorRect
var loading_label: Label

var state: int = State.MENU
var has_game := false
var running := false
var starting := false
var last_ms := 0
var accum := 0.0

var net_game := false
var net_is_host := false
var net_owner := 0
var net_status_t := 0.0
var local_lost := false

var edit_snapshot: Dictionary = {}
var pending_order: Array = []
var preview_size := 64
var _gallery_return := State.MENU
var _smoke_mode := false
var _eos_room_probe := false
## Игрок сам нажал «Играть»: авто-возврат в сохранённую сетевую партию уже не
## должен открываться вторым миром.
var _manual_start := false

func _ready() -> void:
	ToxAtlasDB.ensure_loaded()
	# Каждое окно — отдельный клиент: свой номер в заголовке (чтобы не путать
	# окна при тесте VPS/EOS) и лёгкий сдвиг, чтобы окна не легли друг на
	# друга ровно.
	var client_id := ClientProfile.id()
	if client_id > 1:
		get_window().title = ClientProfile.title(client_id)
		var shift := mini(client_id - 1, 6) * 42
		get_window().position += Vector2i(shift, shift)
	get_tree().root.size_changed.connect(_on_resized)
	view = ToxWorldView.new()
	view.name = "WorldView"
	add_child(view)
	demo = HybridDemo.new()
	demo.name = "HybridDemo"
	demo.visible = false
	demo.closed.connect(_on_demo_closed)
	add_child(demo)
	server = Supervisor.new()
	server.name = "ServerSupervisor"
	server.profile = client_id
	add_child(server)
	server.status.connect(_on_server_status)
	server.failed.connect(_on_server_failed)
	ui_layer = CanvasLayer.new()
	ui_layer.layer = 10
	add_child(ui_layer)
	hud = ToxHUD.new()
	hud.visible = false
	ui_layer.add_child(hud)
	gallery = ToxModelGallery.new()
	gallery.visible = false
	gallery.closed.connect(_on_gallery_closed)
	ui_layer.add_child(gallery)
	menu = ToxMenu.new()
	ui_layer.add_child(menu)
	net = ToxNet.new()
	net.name = "Net"
	add_child(net)
	lobby = ToxLobby.new()
	lobby.visible = false
	ui_layer.add_child(lobby)
	ui_layer.move_child(gallery, -1)
	net_lobby = NetLobby.new()
	net_lobby.name = "NetLobby"
	net_lobby.visible = false
	ui_layer.add_child(net_lobby)
	net_lobby.match_ready.connect(_on_net_match_ready)
	net_lobby.back.connect(_on_net_lobby_back)
	eos_lobby = EosLobby.new()
	eos_lobby.name = "EosLobby"
	eos_lobby.visible = false
	ui_layer.add_child(eos_lobby)
	eos_lobby.match_ready.connect(_on_eos_match_ready)
	eos_lobby.back.connect(_on_eos_back)
	_connect_menu()
	_connect_hud()
	_connect_net()
	_connect_lobby()
	_build_loading()
	_connect_view()
	for a in OS.get_cmdline_user_args():
		if a == "--smoke":
			_smoke_mode = true
		if a == "--eos-probe":
			call_deferred("_auto_eos_probe")
		if a == "--eos-room-probe":
			_eos_room_probe = true
			call_deferred("_auto_eos_room_probe")
	menu.show_main(false)
	call_deferred("_make_preview", 64)
	if _smoke_mode:
		call_deferred("_auto_smoke")
	elif not _eos_room_probe:
		call_deferred("_auto_resume")
	call_deferred("_auto_shot")

func _exit_tree() -> void:
	# Штатный выход снимает замок сразу: следующее окно снова станет клиентом 1
	# и вернётся в свою сессию, не дожидаясь, пока удар сердца протухнет.
	ClientProfile.release_current()


func _build_loading() -> void:
	loading_layer = CanvasLayer.new()
	loading_layer.layer = 20
	add_child(loading_layer)
	loading_rect = ColorRect.new()
	loading_rect.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	loading_rect.color = Color(0.02, 0.08, 0.14, 0.9)
	loading_rect.visible = false
	loading_rect.mouse_filter = Control.MOUSE_FILTER_STOP
	loading_layer.add_child(loading_rect)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	loading_rect.add_child(center)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	center.add_child(box)
	var t := ToxUI.label("Готовим остров…", 36, ToxUI.CREAM, 10)
	t.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(t)
	loading_label = ToxUI.label("генерация карты, деревни и жителей", 14, Color(0.9, 0.92, 0.85, 0.8))
	loading_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(loading_label)

func _connect_menu() -> void:
	menu.play_pressed.connect(_on_play)
	menu.continue_pressed.connect(_on_continue)
	menu.models_pressed.connect(_on_models)
	menu.hybrid_pressed.connect(_on_hybrid)
	menu.live_pressed.connect(_on_live)
	menu.new_island_pressed.connect(_on_new_island)
	menu.main_menu_pressed.connect(_on_main_menu)
	menu.size_changed.connect(_on_menu_size)

func _connect_hud() -> void:
	hud.menu_requested.connect(_show_pause)
	hud.continue_requested.connect(_on_continue)
	hud.new_island_requested.connect(_on_new_island)
	hud.main_menu_requested.connect(_on_main_menu)
	hud.build_requested.connect(_begin_place)
	hud.edit_requested.connect(_begin_edit)
	hud.edit_action.connect(_on_edit_action)
	hud.hire_requested.connect(_on_hire)
	hud.fire_requested.connect(_on_fire)
	hud.hire_all_requested.connect(_on_hire_all)
	hud.fire_all_requested.connect(_on_fire_all)
	hud.train_requested.connect(_on_train)
	hud.train_all_requested.connect(_on_train_all)
	hud.order_requested.connect(_begin_order)
	hud.stop_requested.connect(_on_stop)
	hud.focus_requested.connect(_on_focus)
	hud.minimap_cell.connect(_on_minimap)

func _connect_lobby() -> void:
	lobby.host_requested.connect(_on_lobby_host)
	lobby.join_requested.connect(_on_lobby_join)
	lobby.leave_requested.connect(_on_lobby_leave)
	lobby.ready_requested.connect(func(value: bool) -> void: net.set_ready(value))
	lobby.start_requested.connect(_on_lobby_start)
	lobby.back_requested.connect(_on_lobby_back)

func _connect_net() -> void:
	net.lobby_changed.connect(_on_net_lobby)
	net.status_changed.connect(func(text: String, error: bool) -> void: lobby.set_status(text, error))
	net.game_started.connect(_on_net_game_started)
	net.snapshot_applied.connect(_on_net_snapshot)
	net.command_result.connect(_on_net_command_result)
	net.peer_left.connect(_on_net_peer_left)
	net.host_left.connect(_on_net_host_left)
	net.net_error.connect(_on_net_error)

func _connect_view() -> void:
	view.building_clicked.connect(_on_building_clicked)
	view.villager_clicked.connect(_on_villager_clicked)
	view.ground_clicked.connect(_on_ground_clicked)
	view.building_double_clicked.connect(func(b: Dictionary) -> void: _begin_edit(b, false))
	view.building_held.connect(func(b: Dictionary) -> void: _begin_edit(b, true))
	view.place_clicked.connect(_commit_place)
	view.edit_clicked.connect(_commit_edit)
	view.order_clicked.connect(_commit_order)
	view.cancel_requested.connect(_on_cancel)
	view.rotate_requested.connect(_on_rotate)

func _make_preview(size: int) -> void:
	if starting:
		return
	starting = true
	preview_size = size
	var p := ToxSim.new()
	p.start("тихая-долина-701", size, "solo")
	sim = p
	view.setup(sim)
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0
	sim.event_log.connect(_on_sim_event)
	sim.game_over.connect(_on_game_over)
	running = true
	starting = false
	if state == State.MENU:
		menu.show_main(has_game)

func _on_menu_size(size: int, seed_text: String) -> void:
	if state != State.MENU or has_game:
		return
	# Debounce regeneration; the menu is allowed to keep showing the old island
	# while the new one is built.
	if size == preview_size:
		return
	preview_size = size
	await get_tree().create_timer(0.35).timeout
	if state != State.MENU or has_game or size != preview_size:
		return
	_make_preview(size)

## Главный путь: «Играть» — гибридный клиент (мир на Node-сервере), а не
## ToxSim прототипа. Прототип остался только заставкой меню и отладочными
## кнопками; см. docs/GODOT-PORT-PROMPT.md §4.1.
func _on_play(size: int, seed_text: String, mode: String) -> void:
	if mode == "net":
		_open_net_lobby(size, seed_text)
		return
	if mode == "eos":
		_open_eos_lobby(size, seed_text)
		return
	_start_hybrid(size, seed_text, mode == "bot")

## Гибридная партия: приложение само поднимает Node-сервер и начинает
## одиночную игру (`solo:true`) или игру против деревни (`bot:true`).
func _start_hybrid(size: int, seed_text: String, bot: bool) -> void:
	if starting:
		return
	_manual_start = true
	if net_lobby != null:
		net_lobby.abort_resume()
	starting = true
	_enter_demo_shell()
	var ok: bool = await server.start_server()
	if not ok:
		demo.show_error(server.last_error)
		starting = false
		return
	demo.open_live(server.base, {
		"seed": seed_text, "size": size, "bot": bot,
		"mode": "bot" if bot else "solo"})
	starting = false


func _enter_demo_shell() -> void:
	state = State.DEMO
	running = false
	menu.visible = false
	hud.visible = false
	gallery.visible = false
	lobby.visible = false
	view.visible = false
	view.input_enabled = false
	demo.visible = true


func _on_server_status(text: String) -> void:
	if demo != null and demo.visible:
		demo.set_status(text)


func _on_server_failed(text: String) -> void:
	if demo != null and demo.visible:
		demo.show_error(text)


func _close_hybrid_to_menu() -> void:
	demo.visible = false
	demo.close()
	if net_lobby != null and net_lobby.room != null:
		net_lobby.close_room()
	if eos_lobby != null:
		eos_lobby.close_room()
	if server != null:
		server.stop()
	state = State.MENU
	has_game = false
	view.visible = true
	view.input_enabled = false
	menu.show_main(false)
	_make_preview(preview_size)


## Экран сети: HTTP-лобби того же сервера (код/токен, без ENet). Локальный
## сервер поднимается сам, если игрок не ввёл адрес VPS в поле.
## Возврат в партию после перезапуска: сессия живёт в user://, комната — на
## сервере. Локальный сервер после выхода приложения гаснет, поэтому resume
## имеет смысл для VPS/второго игрока/падения клиента; если комнаты нет,
## сессия честно стирается и остаётся меню.
## Проверка СОБРАННОГО приложения: поднять встроенный сервер, начать
## одиночную партию, дождаться мира и кадра, выйти с кодом 0. Запускается
## флагом `-- --smoke`; так package.sh проверяет .app, а не только проект.
## Диагностика собранного приложения: поднять настоящий EOS и сказать, где
## именно отказ. Запуск: 4tox --headless -- --eos-probe
func _auto_eos_probe() -> void:
	print("EOSPROBE: старт")
	var script = load("res://scripts/eos/p2p_link.gd")
	if script == null or not script.can_instantiate():
		print("EOSPROBE: p2p_link не загрузился")
		get_tree().quit(1)
		return
	var link = script.new()
	link.failed.connect(func(t: String) -> void: print("EOSPROBE: failed ", t))
	link.set_coordinator_url(EosLobby.DEFAULT_COORDINATOR)
	print("EOSPROBE: available=", link.available())
	var ok: bool = await link.start_host()
	print("EOSPROBE: start=", ok, " err=", link.error_text())
	link.shutdown()
	await get_tree().create_timer(0.5).timeout
	get_tree().quit(0 if ok else 1)


## Проверка именно экспортированного приложения: настоящий EOS, Node и
## координатор, без вывода кода, полномочий или идентификаторов игрока.
func _auto_eos_room_probe() -> void:
	var temp := OS.get_environment("TMPDIR")
	if temp == "":
		temp = ProjectSettings.globalize_path("user://state")
	var dir := temp.path_join("4tox-app-eos-probe-" + Crypto.new().generate_random_bytes(12).hex_encode())
	eos_lobby.session_override = dir.path_join("session.cfg")
	eos_lobby.open(64, "app-eos-probe")
	eos_lobby._transport.select(0)
	eos_lobby._name.text = "Probe"
	await eos_lobby.host_game()
	var ok: bool = eos_lobby.joined and eos_lobby.is_host
	if ok:
		var deadline := Time.get_ticks_msec() + 15000
		ok = false
		while Time.get_ticks_msec() < deadline:
			var state: Dictionary = await eos_lobby.coordinator.request("heartbeat", {})
			if state.get("backupAvailable", false):
				ok = true
				break
			await get_tree().create_timer(0.5).timeout
	print("EOSROOMPROBE: ", "PASS" if ok else "FAIL")
	if not ok:
		print("EOSROOMPROBE: ", eos_lobby._status_label.text)
	await eos_lobby.close_room()
	if DirAccess.dir_exists_absolute(dir):
		DirAccess.remove_absolute(dir)
	get_tree().quit(0 if ok else 1)


func _auto_smoke() -> void:
	print("SMOKE: старт приложения")
	await _start_hybrid(64, "тихая-долина-701", false)
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < 45000:
		await get_tree().process_frame
		if demo != null and demo.visible and demo._layer != null \
				and demo.hud() != null and not demo.hud().snap.is_empty():
			var snap: Dictionary = demo.hud().snap
			print("SMOKE OK · построек ", (demo._layer.buildings as Array).size(),
				" · жителей ", (demo._layer.villagers as Array).size(),
				" · кадр ", int(snap.get("revision", 0)),
				" · сервер ", server.base if server != null else "?")
			if server != null:
				server.stop()
			get_tree().quit(0)
			return
	print("SMOKE FAIL · сервер ", server.last_error if server != null else "?")
	if server != null:
		server.stop()
	get_tree().quit(1)


func _auto_resume() -> void:
	if _manual_start or net_lobby == null or not LiveRoom.session_exists():
		return
	var info := LiveRoom.session_info()
	var saved_base := str(info.get("base", ""))
	if saved_base == "":
		return
	net_lobby.open(saved_base, "", 0)
	await net_lobby.resume_game()


func _open_net_lobby(size: int, seed_text: String) -> void:
	if starting:
		return
	starting = true
	state = State.LOBBY
	menu.visible = false
	hud.visible = false
	gallery.visible = false
	lobby.visible = false
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0
	if server != null and not server.is_running():
		await server.start_server()
	net_lobby.open(server.base if server != null and server.base != "" else "http://127.0.0.1:8787",
		seed_text, size)
	starting = false


func _on_net_lobby_back() -> void:
	state = State.MENU
	net_lobby.visible = false
	view.visible = true
	has_game = false
	menu.show_main(false)
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0


func _on_net_match_ready(room) -> void:
	_enter_demo_shell()
	net_lobby.visible = false
	demo.open_room(room, {"mode": "multi"})


## Отдельный режим EOS: свой экран, свой LiveRoom, тот же мир на Node.
func _open_eos_lobby(size: int, seed_text: String) -> void:
	if starting:
		return
	starting = true
	state = State.LOBBY
	menu.visible = false
	hud.visible = false
	gallery.visible = false
	lobby.visible = false
	if net_lobby != null:
		net_lobby.visible = false
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0
	eos_lobby.open(size, seed_text)
	starting = false


func _on_eos_match_ready(room) -> void:
	_enter_demo_shell()
	eos_lobby.visible = false
	demo.open_room(room, {"mode": "multi"})


func _on_eos_back() -> void:
	state = State.MENU
	eos_lobby.visible = false
	view.visible = true
	has_game = false
	menu.show_main(false)
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0


func _open_lobby(size: int, seed_text: String) -> void:
	if starting:
		return
	if net_game:
		_leave_net()
	if sim != null and view.mode == ToxWorldView.Mode.EDIT:
		_cancel_edit()
	else:
		view.reset_mode()
	pending_order.clear()
	state = State.LOBBY
	menu.visible = false
	hud.visible = false
	gallery.visible = false
	view.input_enabled = false
	lobby.open(size, seed_text)
	lobby.show_menu_page()
	lobby.set_status("", false)

# ---------------------------------------------------------------- network

func _on_lobby_host(config: Dictionary) -> void:
	if net.host_game(str(config.name), int(config.port), str(config.seed), int(config.size)):
		lobby.show_wait_page()
		lobby.set_address("Друзья подключаются: %s" % ToxLobby.lan_addresses(int(config.port)))
		_on_net_lobby(net.lobby)

func _on_lobby_join(config: Dictionary) -> void:
	if net.join_game(str(config.name), str(config.address), int(config.port)):
		lobby.show_wait_page()
		lobby.set_status("подключаемся к %s…" % str(config.address), false)

func _on_lobby_leave() -> void:
	_close_lobby_to_menu()

func _on_lobby_back() -> void:
	_close_lobby_to_menu()

func _close_lobby_to_menu() -> void:
	var was_net := net_game
	net.leave()
	lobby.visible = false
	state = State.MENU
	if was_net:
		net_game = false
		net_is_host = false
		net_owner = 0
		local_lost = false
		has_game = false
		if view.mode != ToxWorldView.Mode.NORMAL:
			view.reset_mode()
		edit_snapshot.clear()
		pending_order.clear()
		sim = null
		hud.set_net_mode(false)
		hud.hide_end()
		hud.visible = false
		running = true
		_make_preview(preview_size)
		return
	has_game = has_game and sim != null and not sim.over
	menu.show_main(has_game)
	menu.visible = true
	hud.visible = false
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0
	running = true

func _on_lobby_start() -> void:
	if not net.can_start():
		lobby.set_status(net.start_block_reason(), true)
		return
	_start_host_game()

func _start_host_game() -> void:
	if starting:
		return
	starting = true
	net.starting = true
	loading_rect.visible = true
	loading_label.text = "создаём общий мир…"
	await get_tree().process_frame
	if not net.can_start():
		starting = false
		net.starting = false
		loading_rect.visible = false
		lobby.set_status(net.start_block_reason(), true)
		return
	var payload := net.start_payload()
	var p := ToxSim.new()
	p.start_net(str(payload.seed), int(payload.size), payload.players)
	p.player_owner = 0
	net.begin_host_game(p)
	_enter_net_game(p, 0, true)
	starting = false
	loading_rect.visible = false

func _on_net_lobby(data: Dictionary) -> void:
	if data.is_empty() or (net_game and net.started):
		return
	lobby.visible = true
	lobby.show_wait_page()
	lobby.render(data, net.is_host, net.local_owner, net.local_name)
	if net.is_host:
		lobby.set_address("Друзья подключаются: %s" % ToxLobby.lan_addresses(int(data.get("port", 7777))))
	elif not net.server_address.is_empty():
		lobby.set_address("Подключено к %s" % net.server_address)

func _on_net_game_started(payload: Dictionary, _is_host: bool) -> void:
	_on_client_start(payload)

func _on_client_start(payload: Dictionary) -> void:
	if starting:
		return
	starting = true
	loading_rect.visible = true
	loading_label.text = "принимаем остров…"
	await get_tree().process_frame
	if not net.active or not net.connected:
		starting = false
		loading_rect.visible = false
		state = State.LOBBY
		lobby.visible = true
		lobby.show_menu_page()
		lobby.set_status("связь с хозяином потеряна", true)
		return
	var p := ToxSim.new()
	p.start_net(str(payload.get("seed", "тихая-долина-701")), int(payload.get("size", 64)), payload.get("players", []))
	var expected := str(payload.get("world_hash", ""))
	if not expected.is_empty() and expected != p.world_hash():
		starting = false
		loading_rect.visible = false
		net.leave()
		lobby.visible = true
		lobby.show_menu_page()
		lobby.set_status("Остров не совпал с хозяином. Нужна та же версия игры.", true)
		state = State.LOBBY
		return
	var owner := net.local_owner
	if owner < 0:
		owner = 1
	_enter_net_game(p, owner, false)
	net.attach_sim(p, owner)
	starting = false
	loading_rect.visible = false

func _enter_net_game(p: ToxSim, owner: int, as_host: bool) -> void:
	sim = p
	sim.set_player_owner(owner)
	net_game = true
	net_is_host = as_host
	net_owner = owner
	local_lost = false
	has_game = true
	pending_order.clear()
	edit_snapshot.clear()
	view.reset_mode()
	view.setup(sim)
	view.input_enabled = true
	hud.bind(sim, view)
	hud.set_net_mode(true)
	hud.show_loading(false)
	hud.hide_end()
	hud.hide_all_panels()
	hud.set_net_status(net.hud_text())
	menu.visible = false
	lobby.visible = false
	hud.visible = true
	state = State.PLAY
	running = true
	accum = 0.0
	last_ms = Time.get_ticks_msec()
	net_status_t = 0.0
	sim.event_log.connect(_on_sim_event)
	sim.game_over.connect(_on_game_over)
	sim.town_fell.connect(_on_town_fell)
	sim.delivery.connect(func(amount: int, camp: Dictionary) -> void:
		view.add_float("+%d" % amount, ToxBuildings.center(camp), Color("#eaffb8")))
	hud.show_toast("Матч начался · деревня %d" % (owner + 1), 4.0)

func _on_net_snapshot(_state: Dictionary) -> void:
	if not net_game or sim == null:
		return
	hud.set_net_status(net.hud_text())
	if local_lost or sim.over:
		return
	var t := sim.town(sim.player_owner)
	if t.is_empty():
		return
	var th: Variant = t.get("townhall", null)
	if th == null or th.get("rubble", false):
		_on_local_defeat()

func _on_net_command_result(result: Dictionary) -> void:
	if not net_game:
		return
	if not bool(result.get("ok", false)):
		var reason := str(result.get("reason", ""))
		if not reason.is_empty():
			hud.show_toast(reason, 3.0)

func _on_net_peer_left(display_name: String, _owner: int) -> void:
	if net_game:
		hud.show_toast("%s покинул игру" % display_name, 3.0)

func _on_net_host_left() -> void:
	if not net_game:
		lobby.set_status("связь с хозяином потеряна", true)
		lobby.show_menu_page()
		return
	if state == State.OVER:
		hud.show_toast("Хозяин закрыл игру", 3.0)
		return
	if view.mode != ToxWorldView.Mode.NORMAL:
		view.reset_mode()
	edit_snapshot.clear()
	pending_order.clear()
	net.local_edit_nid = -1
	running = false
	view.input_enabled = false
	if state == State.PAUSE or state == State.GALLERY:
		menu.visible = false
		gallery.visible = false
		hud.visible = true
		state = State.PLAY
	hud.set_net_status("Сеть · нет связи", true)
	hud.show_end(false, "Связь с хозяином потеряна.\nМир остался на последнем кадре. Вернись в меню, чтобы выйти.")
	hud.set_net_mode(true)

func _on_net_error(text: String) -> void:
	if net_game:
		hud.show_toast(text, 4.0)
	if state == State.LOBBY:
		lobby.show_menu_page()
		lobby.set_status(text, true)

func _on_town_fell(owner: int) -> void:
	if not net_game:
		return
	if owner == sim.player_owner:
		_on_local_defeat()
	elif not sim.over:
		hud.show_toast("Деревня %d пала" % (owner + 1), 3.5)

func _on_local_defeat() -> void:
	if local_lost:
		return
	_show_hud_from_overlays()
	if state == State.PAUSE or state == State.GALLERY:
		state = State.PLAY
	local_lost = true
	if net_game:
		net.local_edit_nid = -1
	if view.mode != ToxWorldView.Mode.NORMAL:
		view.reset_mode()
	edit_snapshot.clear()
	pending_order.clear()
	view.input_enabled = false
	hud.hide_all_panels()
	if not sim.over:
		hud.show_end(false, "Твоя ратуша пала. Матч продолжается, деревня выбыла.\nВ главное меню — чтобы выйти.")

func _leave_net() -> void:
	net.leave()
	net_game = false
	net_is_host = false
	net_owner = 0
	local_lost = false
	has_game = false
	sim = null
	running = false
	if hud != null:
		hud.set_net_mode(false)
		hud.set_net_status("")

func _on_continue() -> void:
	if not has_game or sim == null or sim.over:
		return
	if net_game and (local_lost or not net.active or not net.connected):
		return
	menu.visible = false
	hud.visible = true
	view.input_enabled = true
	state = State.PLAY
	hud.hide_end()
	hud.hide_all_panels()

func _on_models() -> void:
	_gallery_return = state
	state = State.GALLERY
	menu.visible = false
	hud.visible = false
	view.input_enabled = false
	gallery.visible = true

func _on_hybrid() -> void:
	if state != State.MENU:
		return
	state = State.DEMO
	menu.visible = false
	hud.visible = false
	view.visible = false
	demo.open()


func _on_live() -> void:
	if state != State.MENU:
		return
	_enter_demo_shell()
	var ok: bool = await server.start_server()
	if not ok:
		demo.show_error(server.last_error)
		return
	demo.open_live(server.base)


func _on_demo_closed() -> void:
	_close_hybrid_to_menu()


func _on_gallery_closed() -> void:
	gallery.visible = false
	state = _gallery_return
	if state == State.PAUSE:
		menu.show_pause(_pause_stats(), net_game)
	else:
		menu.show_main(has_game)
	menu.visible = true
	view.input_enabled = false

func _on_new_island() -> void:
	if demo != null and demo.visible:
		demo.new_island()
		return
	if sim == null:
		return
	if net_game:
		hud.show_toast("В сети новый остров создаёт хозяин: выйдите в меню и создайте новую игру.", 4.0)
		return
	_begin_game(sim.world.island_size, ToxRNG.random_seed(), "solo" if sim.mode == "solo" else "bot")

func _on_main_menu() -> void:
	if demo != null and demo.visible:
		_close_hybrid_to_menu()
		return
	if net_game:
		_close_lobby_to_menu()
		return
	state = State.MENU
	if view.mode == ToxWorldView.Mode.EDIT:
		_cancel_edit()
	else:
		view.reset_mode()
	pending_order.clear()
	has_game = has_game and sim != null and not sim.over
	menu.show_main(has_game)
	hud.visible = false
	view.input_enabled = false
	view.fit_island()
	view._arrival_t = -1.0

func _show_pause() -> void:
	if sim == null or not has_game:
		return
	if view.mode == ToxWorldView.Mode.EDIT:
		_cancel_edit()
	else:
		view.reset_mode()
	pending_order.clear()
	state = State.PAUSE
	menu.show_pause(_pause_stats(), net_game)
	menu.visible = true
	hud.visible = false
	view.input_enabled = false

func _pause_stats() -> Dictionary:
	var t := sim.town(sim.player_owner)
	var warriors := 0
	for v in sim.villagers:
		if v.owner == sim.player_owner and v.warrior and not v.dead:
			warriors += 1
	return {
		"seed": sim.world.seed_text,
		"size": "%d × %d" % [sim.world.island_size, sim.world.island_size],
		"logs": sim.player_logs(),
		"felled": sim.player_felled(),
		"delivered": sim.player_deliveries(),
		"time": ToxUI.fmt_time(sim.time),
		"warriors": warriors
	}

func _begin_game(size: int, seed_text: String, mode: String) -> void:
	if starting:
		return
	starting = true
	if net.active:
		net.leave()
	net_game = false
	net_is_host = false
	net_owner = 0
	local_lost = false
	loading_rect.visible = true
	loading_label.text = "остров %d × %d · %s" % [size, size, seed_text]
	await get_tree().process_frame
	var p := ToxSim.new()
	p.start(seed_text, size, mode)
	sim = p
	has_game = true
	view.setup(sim)
	view.input_enabled = true
	hud.bind(sim, view)
	hud.set_net_mode(false)
	hud.set_net_status("")
	hud.show_loading(false)
	hud.hide_end()
	hud.hide_all_panels()
	menu.visible = false
	hud.visible = true
	state = State.PLAY
	running = true
	accum = 0.0
	last_ms = Time.get_ticks_msec()
	sim.event_log.connect(_on_sim_event)
	sim.game_over.connect(_on_game_over)
	sim.delivery.connect(func(amount: int, camp: Dictionary) -> void:
		view.add_float("+%d" % amount, ToxBuildings.center(camp), Color("#eaffb8")))
	loading_rect.visible = false
	starting = false
	hud.show_toast("Деревня основана. Найми жителей в лагере лесоруба.", 4.5)

func _on_sim_event(text: String) -> void:
	if text.contains("воин") or text.contains("разруш") or text.contains("построена") or text.contains("родился") or text.contains("идут"):
		hud.show_toast(text, 3.0)
	if hud.hire_panel.visible:
		hud._refresh_hire()
	if hud.squad_panel.visible:
		hud.update_squad_counts()
	if hud.village_panel.visible:
		hud._refresh_village()
	if view != null:
		view.queue_redraw()

func _show_hud_from_overlays() -> void:
	if state == State.PAUSE or state == State.GALLERY:
		menu.visible = false
		gallery.visible = false
		hud.visible = true

func _on_game_over(win: bool) -> void:
	_show_hud_from_overlays()
	if view.mode != ToxWorldView.Mode.NORMAL:
		view.reset_mode()
	edit_snapshot.clear()
	pending_order.clear()
	running = false
	state = State.OVER
	var text := ""
	if net_game:
		if win:
			text = "Матч окончен. Твоя деревня победила.\nБрёвен: %d · срублено: %d · время: %s" % [sim.player_logs(), sim.player_felled(), ToxUI.fmt_time(sim.time)]
		elif sim.winner >= 0:
			text = "Матч окончен. Победила деревня %d.\nБрёвен: %d · срублено: %d · время: %s" % [sim.winner + 1, sim.player_logs(), sim.player_felled(), ToxUI.fmt_time(sim.time)]
		else:
			text = "Матч окончен. Ничья: обе ратуши пали.\nВремя: %s" % ToxUI.fmt_time(sim.time)
	else:
		if win:
			text = "Вражеская ратуша пала. Остров твой.\nБрёвен: %d · срублено: %d · время: %s" % [sim.player_logs(), sim.player_felled(), ToxUI.fmt_time(sim.time)]
		else:
			text = "Ратуша пала. Деревня не выстояла.\nБрёвен: %d · срублено: %d · время: %s" % [sim.player_logs(), sim.player_felled(), ToxUI.fmt_time(sim.time)]
	if net_game:
		net.local_edit_nid = -1
	hud.set_net_mode(net_game)
	hud.show_end(win, text)

func _process(_dt: float) -> void:
	ClientProfile.tick()
	var now := Time.get_ticks_msec()
	if last_ms == 0:
		last_ms = now
	var dt := clampf(float(now - last_ms) / 1000.0, 0.0, 0.5)
	last_ms = now
	if sim != null and running and state != State.DEMO:
		if net_game and not net_is_host:
			sim.update_remote(dt)
		else:
			accum += dt
			var steps := 0
			while accum >= 0.05 and steps < 24:
				sim.update(0.05)
				accum -= 0.05
				steps += 1
			if steps >= 24:
				accum = 0.0
		if view != null:
			view.queue_redraw()
	if net_game and net != null:
		net_status_t -= dt
		if net_status_t <= 0.0:
			net_status_t = 0.5
			hud.set_net_status(net.hud_text())

func _on_building_clicked(b: Dictionary) -> void:
	if state != State.PLAY:
		return
	hud.select_building(b)
	view.selected_building = b
	view.selected_villager = null

func _on_villager_clicked(v: ToxVillager) -> void:
	if state != State.PLAY:
		return
	hud.select_villager(v)
	view.selected_villager = v
	view.selected_building = null

func _on_ground_clicked(_cell: Vector2i) -> void:
	if state != State.PLAY:
		return
	hud.selected_building = null
	hud.selected_villager = null
	hud.build_plaque.visible = false
	hud.hire_panel.visible = false
	view.selected_building = null
	view.selected_villager = null

func _begin_place(type: String) -> void:
	if sim == null or state != State.PLAY or local_lost:
		return
	var price := sim.build_price(type)
	if sim.player_logs() < price:
		hud.show_toast("Нужно %d брёвен, а у деревни %d" % [price, sim.player_logs()])
		return
	var variant := "x" if type == "warcamp" else "a"
	view.set_place(type, variant, 90)
	hud.build_menu.visible = false
	hud.show_toast("Поставь %s · R повернуть · ПКМ отменить" % ToxBuildings.NAMES.get(type, "постройку"), 3.0)

func _commit_place(cell: Vector2i) -> void:
	if view.mode != ToxWorldView.Mode.PLACE:
		return
	if net_game and not net_is_host:
		net.send_command({
			"kind": "build", "type": view.ghost_type, "rot": view.ghost_rot,
			"x": cell.x, "y": cell.y
		})
		view.reset_mode()
		hud.build_menu.visible = false
		hud.refresh_build_menu()
		return
	var res := sim.build(view.ghost_type, view.ghost_rot, cell, sim.player_owner)
	if res.ok:
		hud.show_toast("%s построена" % ToxBuildings.NAMES.get(view.ghost_type, "Постройка"))
		view.reset_mode()
		hud.build_menu.visible = false
		hud.refresh_build_menu()
	else:
		hud.show_toast(str(res.reason))
		view._update_mode_ghost()

func _begin_edit(b: Dictionary, moving: bool) -> void:
	if sim == null or state != State.PLAY or local_lost or b.get("rubble", false):
		return
	if int(b.get("owner", 0)) != sim.player_owner:
		hud.show_toast("Это чужая постройка", 2.5)
		return
	edit_snapshot = {"b": b, "x": b.x, "y": b.y, "rot": b.rot}
	if net_game:
		net.local_edit_nid = sim._id_of(b)
	view.set_edit(b, moving)
	view.selected_building = b
	hud.select_building(b)
	var check := sim.edit_check(b)
	hud.show_edit(b, check.ok, str(check.reason))

func _on_edit_action(action: String) -> void:
	if view.edit_building == null:
		return
	var b: Dictionary = view.edit_building
	match action:
		"move":
			view.begin_move()
			hud.show_toast("Двигай мышью, ЛКМ поставить", 2.5)
		"rotate":
			view.rotate_ghost()
			var check := sim.edit_check(b)
			hud.show_edit(b, check.ok, str(check.reason))
			hud.refresh_selected()
		"remove":
			if net_game and not net_is_host:
				net.send_command({"kind": "edit_remove", "nid": sim._id_of(b)})
				_close_edit()
				hud.selected_building = null
				hud.build_plaque.visible = false
				view.selected_building = null
				return
			var res := sim.edit_remove(b)
			if res.ok:
				_close_edit()
				hud.selected_building = null
				hud.build_plaque.visible = false
				view.selected_building = null
				hud.show_toast("Постройка снесена")
			else:
				hud.show_toast(str(res.reason))
		"apply":
			_commit_edit(Vector2i(int(b.x), int(b.y)))
		"cancel":
			_cancel_edit()

func _commit_edit(_cell: Vector2i) -> void:
	if view.edit_building == null:
		return
	var b: Dictionary = view.edit_building
	if net_game and not net_is_host:
		net.send_command({
			"kind": "edit_apply", "nid": sim._id_of(b),
			"x": int(b.x), "y": int(b.y), "rot": int(b.rot)
		})
		_close_edit()
		return
	var res := sim.edit_apply(b)
	if res.ok:
		_close_edit()
	else:
		hud.show_toast(str(res.reason))
		view._update_mode_ghost()

func _cancel_edit() -> void:
	if not edit_snapshot.is_empty():
		var b: Dictionary = edit_snapshot.b
		b.x = edit_snapshot.x
		b.y = edit_snapshot.y
		b.rot = edit_snapshot.rot
		sim.world.build_rev += 1
		sim._refresh_nav()
	_close_edit()

func _close_edit() -> void:
	edit_snapshot.clear()
	if net_game:
		net.local_edit_nid = -1
	view.reset_mode()
	hud.hide_edit()
	view.queue_redraw()

func _on_cancel() -> void:
	if view.mode == ToxWorldView.Mode.PLACE:
		view.reset_mode()
		hud.build_menu.visible = false
	elif view.mode == ToxWorldView.Mode.EDIT:
		_cancel_edit()
	elif view.mode == ToxWorldView.Mode.ORDER:
		view.reset_mode()
		pending_order.clear()

func _on_rotate() -> void:
	if view.mode == ToxWorldView.Mode.PLACE or view.mode == ToxWorldView.Mode.EDIT:
		view.rotate_ghost()
		if view.edit_building != null:
			var check := sim.edit_check(view.edit_building)
			hud.show_edit(view.edit_building, check.ok, str(check.reason))
			hud.refresh_selected()

func _begin_order(ids: Array) -> void:
	if ids.is_empty():
		return
	pending_order = ids
	view.set_order(ids)
	hud.show_toast("Клик по карте — приказ воинам", 3.0)

func _commit_order(cell: Vector2i) -> void:
	if view.mode != ToxWorldView.Mode.ORDER or pending_order.is_empty():
		return
	if net_game and not net_is_host:
		net.send_command({"kind": "order", "ids": pending_order.duplicate(), "x": cell.x, "y": cell.y})
	else:
		sim.order_army(pending_order, cell)
	view.set_order_target(cell)
	view.reset_mode()
	hud.show_toast("Приказ отдан: %d воинов" % pending_order.size())
	pending_order.clear()

func _on_stop() -> void:
	if sim == null:
		return
	var ids := []
	for v in sim.warriors_of(sim.player_owner):
		ids.append(v.id)
	if net_game and not net_is_host:
		net.send_command({"kind": "stop", "ids": ids})
	else:
		sim.stop_army(ids)
	hud.show_toast("Воины остановлены")

func _on_hire(v: ToxVillager, camp: Dictionary) -> void:
	if net_game and not net_is_host:
		net.send_command({"kind": "hire", "vid": v.id, "nid": sim._id_of(camp)})
		return
	var res := sim.hire(v, camp)
	if not res.ok:
		hud.show_toast(str(res.reason))
	hud._refresh_hire()

func _on_fire(v: ToxVillager) -> void:
	if net_game and not net_is_host:
		net.send_command({"kind": "fire", "vid": v.id})
		return
	sim.fire(v)
	hud._refresh_hire()

func _on_hire_all(camp: Dictionary) -> void:
	if net_game and not net_is_host:
		net.send_command({"kind": "hire_all", "nid": sim._id_of(camp)})
		return
	sim.hire_all(camp)
	hud._refresh_hire()

func _on_fire_all(camp: Dictionary) -> void:
	if net_game and not net_is_host:
		net.send_command({"kind": "fire_all", "nid": sim._id_of(camp)})
		return
	sim.fire_all(camp)
	hud._refresh_hire()

func _on_train(v: ToxVillager, barracks: Dictionary) -> void:
	if net_game and not net_is_host:
		net.send_command({"kind": "train", "vid": v.id, "nid": sim._id_of(barracks)})
		return
	var res := sim.train(v, barracks)
	if not res.ok:
		hud.show_toast(str(res.reason))
	hud._refresh_hire()

func _on_train_all(barracks: Dictionary) -> void:
	if net_game and not net_is_host:
		net.send_command({"kind": "train_all", "nid": sim._id_of(barracks)})
		return
	sim.train_all(barracks)
	hud._refresh_hire()

func _on_focus(v: ToxVillager) -> void:
	if v.dead:
		return
	hud.select_villager(v)
	view.selected_villager = v
	view.selected_building = null
	view.center_on(Vector2(v.x, v.y))
	if view.zoom_px < 50.0:
		view.zoom_px = 70.0
		view._sync_camera()

func _on_minimap(cell: Vector2i) -> void:
	view.center_on(Vector2(cell.x + 0.5, cell.y + 0.5))

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		var code: int = int((event as InputEventKey).physical_keycode)
		if state == State.PLAY and net_game and (local_lost or not net.active or not net.connected):
			return
		if state == State.PLAY:
			if code == KEY_O:
				hud.squad_toggle()
				get_viewport().set_input_as_handled()
			elif code == KEY_T:
				hud.village_toggle()
				get_viewport().set_input_as_handled()
			elif code == KEY_B:
				hud.build_toggle()
				get_viewport().set_input_as_handled()
			elif code == KEY_ESCAPE:
				if view.mode == ToxWorldView.Mode.NORMAL:
					_show_pause()
				else:
					_on_cancel()
				get_viewport().set_input_as_handled()
			elif code == KEY_R:
				_on_rotate()
				get_viewport().set_input_as_handled()
			elif code == KEY_H:
				if hud.focus_villager != null:
					_on_focus(hud.focus_villager)
			elif code == KEY_C:
				var list := sim.villagers.filter(func(v: ToxVillager) -> bool: return v.owner == sim.player_owner and not v.dead)
				if not list.is_empty():
					var idx := 0
					if hud.focus_villager != null:
						idx = (list.find(hud.focus_villager) + 1) % list.size()
					_on_focus(list[idx])
		elif state == State.PAUSE:
			if code == KEY_ESCAPE:
				_on_continue()
				get_viewport().set_input_as_handled()

func _auto_shot() -> void:
	var shot := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="):
			shot = a.substr(7)
	if shot.is_empty():
		return
	if shot == "live":
		await _on_live()
		await get_tree().create_timer(6.0).timeout
		await RenderingServer.frame_post_draw
		var limg := get_viewport().get_texture().get_image()
		limg.save_png("res://shots/live.png")
		get_tree().quit()
		return
	if shot == "hybrid":
		_on_hybrid()
		await get_tree().create_timer(1.2).timeout
		await RenderingServer.frame_post_draw
		var img := get_viewport().get_texture().get_image()
		img.save_png("res://shots/hybrid.png")
		get_tree().quit()
		return
	if shot == "game" or shot == "village" or shot == "build" or shot == "buildfull" or shot == "place" or shot == "hire" or shot == "work" or shot == "army" or shot == "edit" or shot == "pause" or shot == "end" or shot == "bot" or shot == "combat" or shot == "villager" or shot == "game256":
		_on_play(256 if shot == "game256" else 64, "тихая-долина-701" if shot != "game256" else "великий-берег-707", "bot" if shot == "bot" else "solo")
		await get_tree().create_timer(3.2 if shot != "game256" else 7.0).timeout
		if shot == "village":
			var th: Dictionary = sim.town(0).townhall
			view.zoom_px = 86.0
			view.center_on(ToxBuildings.center(th))
		elif shot == "build":
			hud.build_toggle()
		elif shot == "buildfull":
			sim.town(0).logs = 200
			hud.build_toggle()
		elif shot == "place":
			sim.town(0).logs = 200
			_begin_place("house")
			var cand := ToxBuildings.find_site(sim.world, sim.buildings, "house", "a", 90, Vector2i(sim.town(0).townhall.x + 2, sim.town(0).townhall.y + 2), 20, true, sim.villagers)
			if not cand.is_empty():
				view.force_hover = Vector2i(cand.x + 1, cand.y + 1)
				view.hover_cell = view.force_hover
				view._update_mode_ghost()
				view.zoom_px = 70.0
				view.center_on(Vector2(cand.x + 1, cand.y + 1))
		elif shot == "hire":
			for b in sim.buildings:
				if ToxBuildings.type_of(b) == "lumbercamp":
					hud.select_building(b)
					var camp: Dictionary = b
					sim.hire_all(camp)
					hud._refresh_hire()
					break
		elif shot == "work":
			for b in sim.buildings:
				if ToxBuildings.type_of(b) == "lumbercamp":
					sim.hire_all(b)
					view.zoom_px = 80.0
					view.center_on(ToxBuildings.center(b))
					break
			await get_tree().create_timer(14.0).timeout
		elif shot == "army":
			sim.town(0).logs = 300
			var near := Vector2i(int(sim.town(0).townhall.x) + 1, int(sim.town(0).townhall.y) + 2)
			var br_site := ToxBuildings.find_site(sim.world, sim.buildings, "barracks", "a", 90, near, 28, true, sim.villagers)
			if not br_site.is_empty():
				sim.build("barracks", 90, Vector2i(br_site.x, br_site.y))
			var wc_site := ToxBuildings.find_site(sim.world, sim.buildings, "warcamp", "x", 90, near, 30, true, sim.villagers)
			if not wc_site.is_empty():
				sim.build("warcamp", 90, Vector2i(wc_site.x, wc_site.y))
			for b in sim.buildings:
				if ToxBuildings.type_of(b) == "barracks":
					sim.train_all(b)
					break
			await get_tree().create_timer(32.0).timeout
			for b in sim.buildings:
				if ToxBuildings.type_of(b) == "warcamp":
					view.zoom_px = 82.0
					view.center_on(ToxBuildings.center(b))
					break
			hud.squad_toggle()
		elif shot == "edit":
			for b in sim.buildings:
				if ToxBuildings.type_of(b) == "lumbercamp":
					_begin_edit(b, false)
					view.zoom_px = 80.0
					view.center_on(ToxBuildings.center(b))
					break
		elif shot == "pause":
			_show_pause()
		elif shot == "end":
			_on_game_over(false)
		elif shot == "villager":
			var v: ToxVillager = sim.villagers[0]
			hud.select_villager(v)
			view.selected_villager = v
			view.zoom_px = 92.0
			view.center_on(Vector2(v.x, v.y))
		elif shot == "combat":
			var th: Dictionary = sim.town(0).townhall
			for i in range(4):
				var pv := sim._spawn_at(0, -1, Vector2i(int(th.x) + 3 + i, int(th.y) + 2), false)
				pv.warrior = true
				pv.hp = 25
				pv.max_hp = 25
				var ev := sim._spawn_at(1, -1, Vector2i(int(th.x) + 3 + i, int(th.y) + 4), false)
				ev.warrior = true
				ev.hp = 25
				ev.max_hp = 25
			await get_tree().create_timer(3.0).timeout
			view.zoom_px = 82.0
			view.center_on(Vector2(th.x + 3, th.y + 3))
		await get_tree().create_timer(1.2).timeout
	elif shot == "netgame":
		var players := [
			{"owner": 0, "name": "Хозяин"},
			{"owner": 1, "name": "Гость"},
			{"owner": 2, "name": "Третий"}
		]
		var p := ToxSim.new()
		p.start_net("тихая-долина-701", 96, players)
		net.active = true
		net.started = true
		net.is_host = true
		net.local_owner = 0
		net.local_name = "Хозяин"
		net.players = {
			1: {"peer": 1, "name": "Хозяин", "owner": 0, "color": ToxSim.TEAM_COLORS[0], "ready": true},
			2: {"peer": 2, "name": "Гость", "owner": 1, "color": ToxSim.TEAM_COLORS[1], "ready": true},
			3: {"peer": 3, "name": "Третий", "owner": 2, "color": ToxSim.TEAM_COLORS[2], "ready": true}
		}
		_enter_net_game(p, 0, true)
		var nth: Dictionary = p.town(0).townhall
		view.zoom_px = 82.0
		view.center_on(ToxBuildings.center(nth))
		await get_tree().create_timer(2.0).timeout
	elif shot == "net":
		_open_lobby(96, "зелёная-пойма-202")
		lobby.show_wait_page()
		lobby.render({
			"size": 96, "seed": "зелёная-пойма-202", "port": 7777,
			"players": [
				{"owner": 0, "name": "Хозяин", "color": ToxSim.TEAM_COLORS[0], "ready": true},
				{"owner": 1, "name": "Гость", "color": ToxSim.TEAM_COLORS[1], "ready": true},
				{"owner": 2, "name": "Третий", "color": ToxSim.TEAM_COLORS[2], "ready": false}
			]
		}, true, 0, "Хозяин")
		lobby.set_address("Друзья подключаются: 192.168.1.5:7777")
		await get_tree().create_timer(1.2).timeout
	elif shot == "gallery":
		_on_models()
		await get_tree().create_timer(2.0).timeout
	else:
		await get_tree().create_timer(2.5).timeout
	var img := get_viewport().get_texture().get_image()
	img.save_png("res://shots/%s.png" % shot)
	get_tree().quit()

func _on_resized() -> void:
	if view != null and state != State.PLAY:
		view.fit_island()
