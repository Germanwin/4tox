extends RefCounted

## Возвращает решение о входе; только DuplicateNotAllowed означает, что
## Device ID уже существует. Ошибка сети не является таким доказательством.
static func can_login(created: bool, result: String) -> bool:
	return created or result.find("DuplicateNotAllowed") >= 0
