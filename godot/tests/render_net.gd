extends SceneTree

## Кадры сети: экран лобби с двумя игроками и матч, принявший ту же комнату.
## Запуск (нужно окно): Godot --path . -s res://tests/render_net.gd
## Результат: shots/net_lobby.png, shots/net_match.png

const Supervisor = preload("res://scripts/server_supervisor.gd")
const NetLobby = preload("res://scripts/net_lobby.gd")
const LiveRoom = preload("res://scripts/live_room.gd")
const Demo = preload("res://scripts/hybrid_demo.gd")

var sup = null
var lobby = null
var guest = null
var demo = null


func _init() -> void:
	_run()


func _shot(name: String) -> void:
	await process_frame
	await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_texture().get_image()
	var err := img.save_png("res://shots/" + name + ".png")
	print("кадр ", name, ": err=", err)


func _run() -> void:
	root.size = Vector2i(1440, 900)
	sup = Supervisor.new()
	root.add_child(sup)
	await process_frame
	if not (await sup.start_server()):
		print("нет сервера")
		quit(1)
		return
	var layer := CanvasLayer.new()
	root.add_child(layer)
	lobby = NetLobby.new()
	layer.add_child(lobby)
	await process_frame
	lobby.open(sup.base, "вольная-заводь-346", 64)
	lobby.set_player_name("Хозяин")
	lobby.press("Создать игру")
	var made := await _wait_for(func() -> bool: return lobby.joined, 15.0)
	if not made:
		print("лобби не создалось: ", lobby.state().get("status", ""))
		_cleanup()
		quit(1)
		return
	screenshot_code = str(lobby.state()["code"])
	guest = LiveRoom.new()
	root.add_child(guest)
	await guest.join_lobby(sup.base, screenshot_code, "Друг")
	guest.set_ready(true)
	lobby.toggle_ready()
	await _wait_for(func() -> bool:
		return guest.ready_count() >= 2 and not bool(lobby.state()["start_disabled"]), 15.0)
	await create_timer(0.4).timeout
	await _shot("net_lobby")

	lobby.press("Начать игру")
	var started := await _wait_for(func() -> bool:
		return lobby.room != null and lobby.room.world != null, 25.0)
	if not started:
		print("матч не начался")
		_cleanup()
		quit(1)
		return
	layer.visible = false
	demo = Demo.new()
	root.add_child(demo)
	await process_frame
	demo.open_room(lobby.room, {"mode": "multi"})
	var drawn := await _wait_for(func() -> bool:
		return demo._layer != null and not demo.hud().snap.is_empty(), 25.0)
	await create_timer(1.8).timeout
	await _shot("net_match")
	print("кадры сети: ", drawn)
	_cleanup()
	quit(0 if drawn else 1)


var screenshot_code := ""


func _wait_for(pred: Callable, timeout_s: float) -> bool:
	var t0 := Time.get_ticks_msec()
	while (Time.get_ticks_msec() - t0) < int(timeout_s * 1000.0):
		if pred.call():
			return true
		await create_timer(0.05).timeout
	return pred.call()


func _cleanup() -> void:
	if demo != null:
		demo.close()
	if guest != null:
		guest.leave()
	if lobby != null:
		lobby.close_room()
	if sup != null:
		sup.stop()
