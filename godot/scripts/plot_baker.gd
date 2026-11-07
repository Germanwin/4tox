class_name ToxPlotBaker
extends RefCounted

## Фоновое запекание газонов. Один газон — 0,25–2 с GDScript-пикселей; делать
## это в кадре нельзя (замирает всё окно), поэтому работа уходит в отдельный
## поток, а слой мира забирает готовые картинки в своём _draw. Текстуры
## создаются только на главном потоке.

const Plots = preload("res://scripts/plots.gd")

var _thread: Thread = null
var _mutex := Mutex.new()
var _sem := Semaphore.new()
var _jobs: Array = []
var _results: Array = []
var _stop := false
var _running := false


func start() -> void:
	if _running:
		return
	Plots.warm()
	_running = true
	_thread = Thread.new()
	_thread.start(_loop)


func stop() -> void:
	if not _running:
		return
	_mutex.lock()
	_stop = true
	_mutex.unlock()
	_sem.post()
	if _thread != null:
		_thread.wait_to_finish()
		_thread = null
	_running = false


func enqueue(key: String, b: Dictionary, f: Dictionary) -> void:
	_mutex.lock()
	for j in _jobs:
		if str(j.get("key", "")) == key:
			_mutex.unlock()
			return
	_jobs.append({"key": key, "b": b.duplicate(true), "f": f.duplicate(true)})
	_mutex.unlock()
	_sem.post()


func busy() -> bool:
	_mutex.lock()
	var n := _jobs.size()
	_mutex.unlock()
	return n > 0


## Готовые картинки: [{key, image, ox, oy}]. Забирать на главном потоке.
func poll() -> Array:
	_mutex.lock()
	var out := _results.duplicate()
	_results.clear()
	_mutex.unlock()
	return out


func _loop() -> void:
	while true:
		_sem.wait()
		_mutex.lock()
		if _stop:
			_mutex.unlock()
			return
		if _jobs.is_empty():
			_mutex.unlock()
			continue
		var job: Dictionary = _jobs.pop_front()
		_mutex.unlock()
		var d: Dictionary = Plots.bake_image(job["b"], job["f"])
		_mutex.lock()
		_results.append({"key": job["key"], "bake": d})
		_mutex.unlock()
