extends "res://scripts/eos/p2p_link.gd"

func _credentials(tree: SceneTree) -> Dictionary:
	var values: Dictionary = await super._credentials(tree)
	if not values.is_empty():
		values["login_method"] = "openid"
	return values
