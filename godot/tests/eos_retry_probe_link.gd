extends "res://scripts/eos/p2p_link.gd"

static var attempts := 0

func _login_guest(tree: SceneTree) -> bool:
	attempts += 1
	if attempts == 1:
		_fail("simulated connection failure")
		return false
	return await super._login_guest(tree)
