extends "res://scripts/eos/p2p_link.gd"

func _credentials(_tree: SceneTree) -> Dictionary:
	var path := OS.get_environment("FOURTOX_EOS_TEST_CONFIG")
	if path == "" or not FileAccess.file_exists(path):
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	return parsed if parsed is Dictionary else {}
