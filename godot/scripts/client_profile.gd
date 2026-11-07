class_name ToxClientProfile
extends RefCounted

## Окно игры = клиент. Номер клиента нужен, чтобы окна не мешали друг другу:
##   • сессия последней партии (`user://net-session*.cfg`) — иначе F5 одного
##     клиента возвращал бы в комнату и на место другого;
##   • состояние и лог локального Node-сервера — у каждого окна свой каталог,
##     иначе два сервера читают/закрывают комнаты друг друга.
##
## Номер берётся из `--client=N` (или `TOX_CLIENT`). Без флага выдаётся первый
## свободный. Занятость — каталог-замок `user://instances/client-N`:
## `make_dir` атомарен и падает, если каталог уже есть, а внутри лежит
## `alive` с временем последнего удара сердца. Живой клиент обновляет его
## дважды в секунду; замок без свежего удара считается брошенным (падение) и
## забирается. Поэтому два запуска подряд дают клиентов 1 и 2, а перезапуск
## возвращает свою сессию. TCP-порт здесь не годится: чужой процесс (например,
## Windows-сборка под Wine) может держать тот же номер порта и сдвигать
## нумерацию macOS-окон. `OS.is_process_running` тоже не годится: Godot
## отвечает только про своих детей, а второе окно — не ребёнок первого.

const DIR := "user://instances"
const MAX_CLIENTS := 32
## Период удара сердца и возраст, после которого замок считается брошенным.
const HEARTBEAT := 0.5
const STALE := 2.5

static var _id := -1
static var _test_id := 0
static var _last_beat := 0.0
## Номера, которые занял этот процесс (включая второго клиента в приёмке).
static var _owned := {}


## Номер этого окна. Первый вызов закрепляет его за процессом.
static func id() -> int:
	if _id > 0:
		return _id
	_test_id = _arg_test_profile()
	if _test_id > 0:
		# Приёмки идут фиксированным профилем 1: иначе замок предыдущего
		# headless-теста (он умирает без _exit_tree) сдвинул бы следующий.
		_id = _test_id
		return _id
	var forced := _arg_id()
	if forced > 0 and _acquire(forced):
		_id = forced
	else:
		_id = _first_free()
	_last_beat = 0.0
	tick()
	return _id


## Файл сессии. Клиент 1 остаётся на старом имени: уже сохранённые партии и
## приёмки продолжают работать без миграции.
static func session_path(profile := -1) -> String:
	var n := profile if profile > 0 else id()
	return "user://net-session.cfg" if n == 1 else "user://net-session-%d.cfg" % n


## Каталог состояния локального Node-сервера. У клиента 1 — прежний
## `user://state` (старые комнаты и возврат в партию продолжают работать), у
## остальных — свой: два сервера на одном `state/rooms` читают и закрывают
## комнаты друг друга.
static func state_root(profile := -1) -> String:
	var n := profile if profile > 0 else id()
	return "user://state" if n == 1 else "user://state/client-%d" % n


static func log_name(profile := -1) -> String:
	var n := profile if profile > 0 else id()
	return "server.log" if n == 1 else "server-%d.log" % n


static func title(profile := -1) -> String:
	var n := profile if profile > 0 else id()
	return "4tox" if n == 1 else "4tox — клиент %d" % n


## Занять номер. Возвращает true, если замок этого номера достался нам.
## Второй клиент в этом же процессе (приёмка) тоже может занять номер.
static func claim(profile: int) -> bool:
	if profile <= 0 or profile > MAX_CLIENTS:
		return false
	if _owned.has(profile):
		return true
	return _acquire(profile)


static func release(profile: int) -> void:
	if not _owned.has(profile):
		return
	_owned.erase(profile)
	_remove_lock(profile)


## Убрать замок этого процесса при штатном выходе. При падении замок
## останется, но без свежего удара сердца его заберёт следующее окно.
static func release_current() -> void:
	var n := _id
	_id = -1
	_last_beat = 0.0
	if _test_id > 0:
		return
	if n > 0:
		release(n)


## Обновить удар сердца. Зовётся из `main._process`; внутри — не чаще
## HEARTBEAT, поэтому дешёво.
static func tick() -> void:
	if _id <= 0 or _test_id > 0:
		return
	var now := Time.get_unix_time_from_system()
	if now - _last_beat < HEARTBEAT:
		return
	_last_beat = now
	_write_beat(_id)


## Номера живых клиентов (включая этот процесс).
static func live_ids() -> Array[int]:
	var out: Array[int] = []
	for n in range(1, MAX_CLIENTS + 1):
		if _owned.has(n) or _fresh(n):
			out.append(n)
	return out


static func _first_free() -> int:
	for n in range(1, MAX_CLIENTS + 1):
		if _acquire(n):
			return n
	return 1


## Атомарно занять каталог; брошенный (без свежего удара) — снять и занять.
static func _acquire(profile: int) -> bool:
	if _owned.has(profile):
		return true
	_ensure_dir()
	var path := _lock_dir(profile)
	if _make(path):
		_owned[profile] = true
		_write_beat(profile)
		return true
	if _fresh(profile):
		return false
	_remove_lock(profile)
	if _make(path):
		_owned[profile] = true
		_write_beat(profile)
		return true
	return false


static func _make(path: String) -> bool:
	return DirAccess.make_dir_absolute(ProjectSettings.globalize_path(path)) == OK


## Живой ли замок: свежий `alive`. Только что созданный каталог без файла
## тоже считается живым (сосед ещё не успел записать первый удар).
static func _fresh(profile: int) -> bool:
	var now := Time.get_unix_time_from_system()
	var beat := _beat_path(profile)
	var f := FileAccess.open(beat, FileAccess.READ)
	if f != null:
		var text := f.get_as_text().strip_edges()
		f.close()
		if text.is_valid_float():
			return now - float(text) <= STALE
	var mtime := FileAccess.get_modified_time(ProjectSettings.globalize_path(_lock_dir(profile)))
	return mtime > 0 and now - float(mtime) <= STALE


static func _write_beat(profile: int) -> void:
	var f := FileAccess.open(_beat_path(profile), FileAccess.WRITE)
	if f == null:
		return
	f.store_string(str(Time.get_unix_time_from_system()))
	f.close()


static func _remove_lock(profile: int) -> void:
	var beat := _beat_path(profile)
	if FileAccess.file_exists(beat):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(beat))
	var dir := _lock_dir(profile)
	if DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir)):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(dir))


static func _lock_dir(profile: int) -> String:
	return "%s/client-%d" % [DIR, profile]


static func _beat_path(profile: int) -> String:
	return _lock_dir(profile).path_join("alive")


static func _ensure_dir() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(DIR))


static func _arg_test_profile() -> int:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--test-profile="):
			return clampi(int(a.substr(15)), 1, MAX_CLIENTS)
	return 0


static func _arg_id() -> int:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--client="):
			return clampi(int(a.substr(9)), 1, MAX_CLIENTS)
	for a in OS.get_cmdline_args():
		if a.begins_with("--client="):
			return clampi(int(a.substr(9)), 1, MAX_CLIENTS)
	var env := OS.get_environment("TOX_CLIENT").strip_edges()
	return clampi(int(env), 1, MAX_CLIENTS) if env.is_valid_int() else 0
