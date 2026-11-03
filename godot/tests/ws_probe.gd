extends SceneTree

## Probe: can a Godot client talk to the existing 4tox room server?
## Usage: Godot --headless -s res://tests/ws_probe.gd -- "ws://127.0.0.1:8811/api/ws?code=...&token=..."

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		print("need ws url")
		quit(1)
		return
	var url: String = args[0]
	var ws := WebSocketPeer.new()
	var err := ws.connect_to_url(url)
	print("connect_to_url err=", err)
	if err != OK:
		quit(1)
		return
	var started := Time.get_ticks_msec()
	var frames := 0
	while Time.get_ticks_msec() - started < 10000:
		ws.poll()
		var state := ws.get_ready_state()
		if state == WebSocketPeer.STATE_OPEN:
			while ws.get_available_packet_count() > 0:
				var pkt := ws.get_packet()
				frames += 1
				var magic := ""
				if pkt.size() >= 6:
					magic = "%02x%02x%02x%02x" % [pkt[0], pkt[1], pkt[2], pkt[3]]
				print("frame ", frames, " bytes=", pkt.size(),
					" magic=", magic, " ver=", pkt[4] if pkt.size() > 4 else -1,
					" type=", pkt[5] if pkt.size() > 5 else -1)
				if frames >= 3:
					quit(0)
					return
		elif state == WebSocketPeer.STATE_CLOSED:
			print("closed code=", ws.get_close_code(), " reason=", ws.get_close_reason())
			quit(1)
			return
		OS.delay_msec(16)
	print("timeout, frames=", frames)
	quit(1)
