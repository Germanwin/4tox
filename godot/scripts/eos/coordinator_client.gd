class_name ToxEosCoordinator
extends Node

## Координатор передаёт только управление и резервные данные, не игровой трафик.
## Полномочия остаются в памяти и никогда не входят в URL или сообщения UI.
signal changed(state: Dictionary)
signal unavailable(reason: String)
signal lease_expired

const HEARTBEAT_SEC := 2.0
const REQUEST_TIMEOUT := 5.0
var base := ""
var code := ""
var token := ""
var generation := 0
var version := ""
var state: Dictionary = {}
var allow_loopback := false
var _lease_deadline := 0
var _heartbeat_time := 0.0
var _heartbeat_busy := false
var _running := false
var _expired := false
var _serial := 0

func configure(url: String, test_loopback := false) -> bool:
	base = url.strip_edges().trim_suffix("/")
	allow_loopback = test_loopback
	return base.begins_with("https://") or (allow_loopback and (base.begins_with("http://127.0.0.1:") or base.begins_with("http://localhost:")))

func create_room(nickname: String, capacity: int, version: String, address: String) -> Dictionary:
	var result := await _post("create", {"name": nickname, "max": capacity, "version": version, "address": address})
	if result.get("ok", false):
		self.version = version
		code = str(result.get("code", ""))
		token = str(result.get("token", ""))
		_apply(result)
		start_heartbeats()
	return result

func join_room(invite: String, nickname: String, version: String) -> Dictionary:
	var result := await _post("join", {"code": invite.strip_edges().to_upper(), "name": nickname, "version": version})
	if result.get("ok", false):
		self.version = version
		code = invite.strip_edges().to_upper()
		token = str(result.get("token", ""))
		_apply(result)
		start_heartbeats()
	return result

func start_heartbeats() -> void:
	_running = true
	_heartbeat_time = 0.0
	set_process(true)

func _process(dt: float) -> void:
	if not _running:
		return
	if _lease_deadline > 0 and Time.get_ticks_msec() >= _lease_deadline and not _expired:
		_expired = true
		lease_expired.emit()
	_heartbeat_time -= dt
	if _heartbeat_time <= 0.0 and not _heartbeat_busy:
		_heartbeat_time = HEARTBEAT_SEC
		_heartbeat()

func _heartbeat() -> void:
	_heartbeat_busy = true
	var serial := _serial
	var started := Time.get_ticks_msec()
	var result := await _post("heartbeat", {"code": code, "token": token, "generation": 0 if _expired else generation, "version": version})
	_heartbeat_busy = false
	if serial != _serial or not _running:
		return
	if result.get("ok", false):
		_apply(result, started)
	else:
		unavailable.emit(str(result.get("reason", "network")))

func request(op: String, values: Dictionary) -> Dictionary:
	if code == "" or token == "":
		return {"ok": false, "reason": "not_joined"}
	var body := values.duplicate(true)
	body["code"] = code
	body["token"] = token
	body["generation"] = generation
	body["version"] = version
	var started := Time.get_ticks_msec()
	var result := await _post(op, body)
	if result.get("ok", false) and result.has("generation"):
		_apply(result, started)
	return result

func _apply(result: Dictionary, request_started := -1) -> void:
	var incoming := int(result.get("generation", generation))
	if incoming < generation:
		return
	if _expired and incoming == generation and str(result.get("state", "")) == "active":
		# A former host cannot renew after its conservative deadline. A guest
		# may resume the same generation only on a fresh, still-valid reply.
		if bool(state.get("host", false)) or request_started < 0 or request_started + int(result.get("leaseMs", 0)) <= Time.get_ticks_msec():
			return
	if incoming > generation:
		_expired = false
	generation = int(result.get("generation", generation))
	state = result.duplicate(true)
	state.erase("token")
	if str(result.get("state", "")) == "active":
		# Lease begins no later than response receipt. Use request start so RTT
		# can only shorten, never extend, the coordinator's grant.
		var reference: int = request_started if request_started >= 0 else Time.get_ticks_msec() - int(REQUEST_TIMEOUT * 1000)
		_lease_deadline = reference + int(result.get("leaseMs", 0))
		_expired = false
	else:
		_lease_deadline = 0
	changed.emit(state)


func abandon_lease() -> void:
	if _expired:
		return
	_expired = true
	_lease_deadline = 0
	lease_expired.emit()


func remaining_lease_ms() -> int:
	return maxi(0, _lease_deadline - Time.get_ticks_msec() - 250)

func leave() -> void:
	if code != "" and token != "":
		await request("leave", {})
	stop()

func stop() -> void:
	_serial += 1
	_running = false
	set_process(false)
	code = ""
	token = ""
	generation = 0
	version = ""
	state = {}
	_lease_deadline = 0

func _post(op: String, body: Dictionary) -> Dictionary:
	if not (base.begins_with("https://") or (allow_loopback and (base.begins_with("http://127.0.0.1:") or base.begins_with("http://localhost:")))):
		return {"ok": false, "reason": "https_required"}
	var http := HTTPRequest.new()
	http.use_threads = true
	http.timeout = REQUEST_TIMEOUT
	add_child(http)
	var error := http.request(base + "/" + op, PackedStringArray(["Content-Type: application/json", "Cache-Control: no-store"]), HTTPClient.METHOD_POST, JSON.stringify(body))
	if error != OK:
		http.queue_free()
		return {"ok": false, "reason": "network"}
	var result: Array = await http.request_completed
	http.queue_free()
	if int(result[0]) != HTTPRequest.RESULT_SUCCESS:
		push_warning("Coordinator request %s failed: network result %d" % [op, int(result[0])])
		return {"ok": false, "reason": "network"}
	var parsed: Variant = JSON.parse_string((result[3] as PackedByteArray).get_string_from_utf8())
	if not (parsed is Dictionary):
		return {"ok": false, "reason": "bad_response"}
	return parsed
