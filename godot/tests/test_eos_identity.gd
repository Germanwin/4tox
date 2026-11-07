extends SceneTree
const DeviceLogin = preload("res://scripts/eos/device_login.gd")
func _init() -> void:
	assert(DeviceLogin.can_login(true, "Success"))
	assert(DeviceLogin.can_login(false, "DuplicateNotAllowed"))
	assert(not DeviceLogin.can_login(false, "NetworkFailure"))
	assert(not DeviceLogin.can_login(false, ""))
	print("PASS Device ID existing/created/error decisions (mock results)")
	quit(0)
