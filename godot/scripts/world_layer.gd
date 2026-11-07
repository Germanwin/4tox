class_name ToxWorldLayer
extends Node2D

## One pass over nature, buildings and villagers in the browser's depth order.
## Nature is batched into a single ArrayMesh; buildings and villagers keep
## individual draws (and their rims) so the depth between them stays exact.

const Outline = preload("res://scripts/outline.gd")
const Plots = preload("res://scripts/plots.gd")
const PlotBaker = preload("res://scripts/plot_baker.gd")

const LOD_SHADER := """
shader_type canvas_item;
uniform float lod = 0.0;
void fragment() {
	COLOR = textureLod(TEXTURE, UV, lod);
}
"""

var objects: Array = []
var buildings: Array = []
var villagers: Array = []
var nature = null
var bdata = null
var vdata = null
var cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var css := Vector2(1440, 900)
var town_colors: Array = ["#4a90d9"]
var lod := 0.0
var show_plots := true
## Тряска деревьев по treeHits: id → время удара (мс по часам клиента).
## Трясущееся дерево исключается из общего меша и рисуется отдельно со
## сдвигом — иначе пришлось бы пересобирать меш тысячи объектов каждый кадр.
var shake: Dictionary = {}
var shake_now_ms := 0
const SHAKE_MS := 440
const SHAKE_HZ := 7.0
const SHAKE_DECAY := 9.0
const SHAKE_FLOOR := 0.02
var _shake_sig := ""

var _edge_b: Dictionary = {}
var _edge_v: Dictionary = {}
## Зум, при котором собраны меши каймы жителей, и когда это было. Кайма —
## 1.1 ЭКРАННОГО пикселя, поэтому её запас в мировых клетках (2.2/z, 4.4/z)
## меняется с зумом, и меш приходится пересобирать. Пересборка стоит O(жителей),
## поэтому на непрерывном зуме она идёт не чаще раза в RIM_REBUILD_MS —
## толщина за эти 100 мс уплывает на доли пикселя, зато кадр не дорожает.
const RIM_REBUILD_MS := 100
var _rim_z := 0.0
var _rim_ms := 0
var _box := Rect2()
var draw_ms := 0.0
var drawn := 0
var picks := 0
var mesh_builds := 0
var _nature_mesh: ArrayMesh = null
var _mesh_dirty := true
var _mesh_key := ""
var _plots: Array = []
var _plots_key := ""
var _plot_cache: Dictionary = {}
var _plot_pending: Dictionary = {}
var _plot_prebaked := false
var _baker = null
# Батчинг жителей: ромб каймы и ромб спрайта — в один меш на кусок между
# постройками, чтобы 600 жителей не стоили 1200 draw-вызовов. Кайма лежит в
# отдельном атласе (кадры 112x132), спрайты — в атласах жителя/воина.
const RIM_W := 2048
const RIM_H := 4096
var _rim_img: Image = null
var _rim_tex: ImageTexture = null
var _rim_rects: Dictionary = {}
var _rim_x := 0
var _rim_y := 0
var _rim_row := 0
var _rim_full := false
var _rim_dirty := false
var _vchunks: Array = []
var _vdraw: Array = []
var _v_sig := ""

var _op := PackedFloat32Array()
var _ok := PackedFloat32Array()
var _on := 0

## Природа живёт в мировых координатах и режется на полосы по глубине
## (x+y). Внутри полосы — две половины: дальняя и ближняя. Постройки и жители
## вставляются между ними, поэтому порядок как в `Renderer.eachSprite`, а
## панорама и зум больше не пересобирают меш.
const NATURE_SPAN := 1.0
var _buckets: Array = []
var _nats: Array = []
var _bucket_objects: Array = []
var _bucket_of := PackedInt32Array()
var _id_index: Dictionary = {}
var _nature_min := 0.0
var _nature_max := 0.0
## Покачивание деревьев включается на зуме ≥26 (как в браузере/старом меше).
## Флаг входит в ключ пересборки: при переходе порога полосы собираются заново.
var _sway_on := true


func _ready() -> void:
	_baker = PlotBaker.new()
	_baker.start()
	var mat := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = LOD_SHADER
	mat.shader = sh
	mat.set_shader_parameter("lod", lod)
	material = mat


func _exit_tree() -> void:
	if _baker != null:
		_baker.stop()
		_baker = null


func _draw() -> void:
	shake_now_ms = Time.get_ticks_msec()
	_collect_baked_plots()
	var t0 := Time.get_ticks_usec()
	var z := float(cam["zoom"])
	_box = _view_box(z)
	drawn = 0
	picks = 0
	if _op.is_empty():
		_prepare_objects()
	_ensure_nature()
	_expire_shakes()
	_refresh_shake_buckets()
	if show_plots:
		_draw_plots(z)
	_draw_scene(z)
	draw_ms = float(Time.get_ticks_usec() - t0) / 1000.0


func set_lod(value: float) -> void:
	lod = value
	if material is ShaderMaterial:
		(material as ShaderMaterial).set_shader_parameter("lod", lod)


func _view_box(z: float) -> Rect2:
	var hw := css.x * 0.5
	var hh := css.y * 0.5
	var pts := [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]
	var x0 := INF
	var x1 := -INF
	var y0 := INF
	var y1 := -INF
	for p in pts:
		var wx: float = float(cam["x"]) + (p[1] * 2.0 + p[0]) / z
		var wy: float = float(cam["y"]) + (p[1] * 2.0 - p[0]) / z
		x0 = minf(x0, wx)
		x1 = maxf(x1, wx)
		y0 = minf(y0, wy)
		y1 = maxf(y1, wy)
	return Rect2(x0 - 3.0, y0 - 3.0, x1 - x0 + 6.0, y1 - y0 + 6.0)


func reset_objects() -> void:
	_op = PackedFloat32Array()
	_ok = PackedFloat32Array()
	_on = 0
	_mesh_dirty = true
	_buckets.clear()
	_nats.clear()
	_bucket_objects.clear()
	_bucket_of = PackedInt32Array()
	_id_index.clear()
	_v_sig = ""
	_vdraw.clear()
	_vchunks.clear()


func _prepare_objects() -> void:
	if not _op.is_empty() or objects.is_empty():
		return
	_on = objects.size()
	_op.resize(_on * 11)
	_ok.resize(_on)
	_id_index.clear()
	_nature_min = INF
	_nature_max = -INF
	for i in range(_on):
		var o: Dictionary = objects[i]
		var spr: Dictionary = o.get("_spr", {})
		if spr.is_empty():
			spr = nature.pick(o) if nature != null else {}
			o["_spr"] = spr
		var b := i * 11
		var ox := float(o["x"])
		var oy := float(o["y"])
		_op[b] = ox
		_op[b + 1] = oy
		_op[b + 2] = float(spr.get("x", 0.0))
		_op[b + 3] = float(spr.get("y", 0.0))
		_op[b + 4] = float(spr.get("w", 0.0))
		_op[b + 5] = float(spr.get("h", 0.0))
		_op[b + 6] = float(spr.get("ax", 0.0))
		_op[b + 7] = float(spr.get("ay", 0.0))
		_op[b + 8] = float(o.get("scale", 1.0))
		_op[b + 9] = float(o.get("phase", 0.0))
		_op[b + 10] = 1.0 if str(o.get("kind", "")) == "tree" else 0.0
		_ok[i] = ox + oy
		_nature_min = minf(_nature_min, _ok[i])
		_nature_max = maxf(_nature_max, _ok[i])
		var oid := str(o.get("id", ""))
		if oid != "":
			_id_index[oid] = i
	if _nature_min == INF:
		_nature_min = 0.0
		_nature_max = 0.0


func _ensure_nature() -> void:
	if _op.is_empty() or nature == null:
		return
	var sway := float(cam.get("zoom", 40.0)) >= 26.0
	if sway != _sway_on:
		_sway_on = sway
		for bi in range(_buckets.size()):
			_buckets[bi]["dirty"] = true
	if _buckets.is_empty():
		_build_nature_buckets()
	for bi in range(_buckets.size()):
		if bool(_buckets[bi]["dirty"]):
			_build_nature_bucket(bi)


## Разложить объекты на полосы глубины и заготовить поток `_nats` для слияния
## с постройками и жителями. Полосы строятся от полного списка, поэтому
## удаление дерева просто пересобирает затронутую полосу.
func _build_nature_buckets() -> void:
	var span := NATURE_SPAN
	var count := maxi(1, int(ceil((_nature_max - _nature_min) / span)) + 1)
	count = mini(count, 512)
	_buckets.clear()
	_bucket_objects.clear()
	_buckets.resize(count)
	_bucket_objects.resize(count)
	_bucket_of.resize(_on)
	for bi in range(count):
		var start := _nature_min + float(bi) * span
		_buckets[bi] = {
			"start": start, "mid": start + span * 0.5, "end": start + span,
			"back": null, "front": null, "dirty": true,
			"shake_back": false, "shake_front": false,
		}
		_bucket_objects[bi] = []
	for i in range(_on):
		var bi := clampi(int(floor((_ok[i] - _nature_min) / span)), 0, count - 1)
		_bucket_of[i] = bi
		_bucket_objects[bi].append(i)
	# Внутри полосы — ровно тот же порядок, что у браузера: (x+y), при
	# равенстве — id. Иначе две соседние кроны меняются местами и кайма
	# расходится с эталоном на пиксель.
	for bi in range(count):
		_bucket_objects[bi].sort_custom(func(a: int, b: int) -> bool:
			if not is_equal_approx(_ok[a], _ok[b]):
				return _ok[a] < _ok[b]
			return int(objects[a].get("id", 0)) < int(objects[b].get("id", 0)))
	_nats.clear()
	for bi in range(count):
		_nats.append({"n": 1, "kind": "nature", "bi": bi, "half": "back",
			"depth": float(_buckets[bi]["start"])})
		_nats.append({"n": 1, "kind": "nature", "bi": bi, "half": "front",
			"depth": float(_buckets[bi]["mid"])})
	_v_sig = ""


func _build_nature_bucket(bi: int) -> void:
	mesh_builds += 1
	var bucket: Dictionary = _buckets[bi]
	var back := {"verts": PackedVector3Array(), "uvs": PackedVector2Array(),
		"idx": PackedInt32Array()}
	var front := {"verts": PackedVector3Array(), "uvs": PackedVector2Array(),
		"idx": PackedInt32Array()}
	bucket["shake_back"] = false
	bucket["shake_front"] = false
	for i in _bucket_objects[bi]:
		if i >= objects.size():
			continue
		var o: Dictionary = objects[i]
		if bool(o.get("removed", false)):
			continue
		var b: int = int(i) * 11
		var oid := str(o.get("id", ""))
		var age := _shake_age(oid) if oid != "" else -1
		var shake := shake_value(age) if age >= 0 else 0.0
		var dst: Dictionary = front if _ok[i] >= float(bucket["mid"]) else back
		if age >= 0:
			if dst == back:
				bucket["shake_back"] = true
			else:
				bucket["shake_front"] = true
		_append_nature_quad(dst, b, shake)
	bucket["back"] = _mesh_of(back)
	bucket["front"] = _mesh_of(front)
	bucket["quads"] = int((back["idx"] as PackedInt32Array).size() / 6) \
		+ int((front["idx"] as PackedInt32Array).size() / 6)
	bucket["dirty"] = false


## Один спрайт природы в мировых координатах: (x−y, x+y), как у жителей.
## Мировой меш переживает панораму и зум — пересборка больше не в кадре.
func _append_nature_quad(dst: Dictionary, b: int, shake: float) -> void:
	var w := _op[b + 4]
	var h := _op[b + 5]
	if w <= 0.0 or h <= 0.0:
		return
	var sc := (1.0 / float(nature.ppu)) * float(nature.mul) * _op[b + 8]
	var ww := w * 2.0 * sc
	var wh := h * 4.0 * sc
	var wx := _op[b] - _op[b + 1]
	var wy := _op[b] + _op[b + 1]
	var qx := wx - ww * _op[b + 6]
	var qy := wy - wh * _op[b + 7]
	# Покачивание: в экранных пикселях это sin(phase)·z·0.018, в мировых —
	# sin(phase)·0.036 (draw_set_transform умножает x на z/2).
	if _sway_on and _op[b + 10] > 0.5:
		qx += sin(_op[b + 9]) * 0.036
	if shake != 0.0:
		qx += shake * 0.1
	var tw := float(nature.atlas.get_width())
	var th := float(nature.atlas.get_height())
	var u0 := _op[b + 2] / tw
	var v0 := _op[b + 3] / th
	var u1 := (_op[b + 2] + w) / tw
	var v1 := (_op[b + 3] + h) / th
	var verts: PackedVector3Array = dst["verts"]
	var uvs: PackedVector2Array = dst["uvs"]
	var idx: PackedInt32Array = dst["idx"]
	var n := verts.size()
	verts.append(Vector3(qx, qy, 0))
	verts.append(Vector3(qx + ww, qy, 0))
	verts.append(Vector3(qx + ww, qy + wh, 0))
	verts.append(Vector3(qx, qy + wh, 0))
	uvs.append(Vector2(u0, v0))
	uvs.append(Vector2(u1, v0))
	uvs.append(Vector2(u1, v1))
	uvs.append(Vector2(u0, v1))
	idx.append(n)
	idx.append(n + 1)
	idx.append(n + 2)
	idx.append(n)
	idx.append(n + 2)
	idx.append(n + 3)


func _mesh_of(dst: Dictionary) -> ArrayMesh:
	var verts: PackedVector3Array = dst["verts"]
	if verts.is_empty():
		return null
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_TEX_UV] = dst["uvs"]
	arrays[Mesh.ARRAY_INDEX] = dst["idx"]
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


## Перед кадром: полосы с трясущимися деревьями пересобираются, остальные
## остаются нетронутыми. Тряска — единственная причина пересборки в кадре.
func _refresh_shake_buckets() -> void:
	if _buckets.is_empty():
		return
	for id in shake.keys():
		if _shake_age(str(id)) < 0:
			continue
		var idx: Variant = _id_index.get(str(id), -1)
		if idx is int and idx >= 0 and idx < _bucket_of.size():
			_buckets[_bucket_of[idx]]["dirty"] = true
	for bi in range(_buckets.size()):
		if bool(_buckets[bi]["dirty"]):
			_build_nature_bucket(bi)


static func shake_value(age_ms: int) -> float:
	if age_ms < 0 or age_ms > SHAKE_MS:
		return 0.0
	var age := float(age_ms) / 1000.0
	var amp := exp(-age * SHAKE_DECAY)
	if amp < SHAKE_FLOOR:
		return 0.0
	return sin(age * SHAKE_HZ * TAU) * amp


## Возраст удара в мс, если дерево трясётся; -1 — стоит.
func _shake_age(id: String) -> int:
	if not shake.has(id):
		return -1
	var age := shake_now_ms - int(shake[id])
	if age < 0 or age > SHAKE_MS:
		return -1
	return age


func set_shake(ids: Dictionary, now_ms: int) -> void:
	shake_now_ms = now_ms
	for id in ids:
		shake[str(id)] = int(ids[id])
		var idx: int = int(_id_index.get(str(id), -1))
		if idx >= 0 and idx < _bucket_of.size():
			_buckets[_bucket_of[idx]]["dirty"] = true
	var sig := ""
	for id in shake:
		if _shake_age(str(id)) >= 0:
			sig += str(id) + ","
	if sig != _shake_sig:
		_shake_sig = sig
		_mesh_dirty = true
	queue_redraw()


func shaking_ids() -> Array:
	var out: Array = []
	for id in shake:
		if _shake_age(str(id)) >= 0:
			out.append(str(id))
	return out


func _expire_shakes() -> void:
	var changed := false
	for id in shake.keys():
		if shake_now_ms - int(shake[id]) > SHAKE_MS:
			var idx: int = int(_id_index.get(str(id), -1))
			if idx >= 0 and idx < _bucket_of.size():
				_buckets[_bucket_of[idx]]["dirty"] = true
			shake.erase(id)
			changed = true
	if changed:
		_shake_sig = ""
		for id in shake:
			_shake_sig += str(id) + ","
		_mesh_dirty = true


func _draw_shaking_trees(z: float) -> void:
	if shake.is_empty() or nature == null or _op.is_empty():
		return
	var tw := float(nature.atlas.get_width())
	var th := float(nature.atlas.get_height())
	var base := z / float(nature.ppu) * float(nature.mul)
	var half := css * 0.5
	for i in range(mini(_on, objects.size())):
		var id := str(objects[i].get("id", ""))
		var age := _shake_age(id)
		if age < 0:
			continue
		var b := i * 11
		var sc := base * _op[b + 8]
		var dw := _op[b + 4] * sc
		var dh := _op[b + 5] * sc
		if dw < 2.5:
			continue
		var ox := _op[b]
		var oy := _op[b + 1]
		var px := (ox - oy - float(cam["x"]) + float(cam["y"])) * z * 0.5
		var py := (ox + oy - float(cam["x"]) - float(cam["y"])) * z * 0.25
		if z >= 26.0:
			px += sin(_op[b + 9]) * z * 0.018
		px += shake_value(age) * z * 0.05
		var qx := half.x + px - dw * _op[b + 6]
		var qy := half.y + py - dh * _op[b + 7]
		var uv := Rect2(_op[b + 2], _op[b + 3], _op[b + 4], _op[b + 5])
		draw_texture_rect_region(nature.atlas, Rect2(qx, qy, dw, dh), uv, Color.WHITE)


## Забрать готовые газоны из фонового потока. Текстуры создаются здесь, на
## главном: из потока это делать нельзя.
func _collect_baked_plots() -> void:
	if _baker == null:
		return
	var done: Array = _baker.poll()
	if done.is_empty():
		return
	for r in done:
		var key := str(r.get("key", ""))
		_plot_pending.erase(key)
		var bake: Dictionary = r.get("bake", {})
		if bake.is_empty():
			continue
		_plot_cache[key] = {
			"tex": ImageTexture.create_from_image(bake["image"]),
			"ox": bake["ox"], "oy": bake["oy"],
		}
	# Появился новый газон — пересобрать список видимых.
	_plots_key = ""


func _draw_plots(z: float) -> void:
	if bdata == null or buildings.is_empty():
		return
	var key := ""
	for b in buildings:
		key += "%s;" % Plots.key_for(b)
	if key != _plots_key:
		_plots_key = key
		# Уехавшие/снесённые постройки не должны копить текстуры газонов
		# (каждая — около мегабайта).
		var valid: Dictionary = {}
		for b in buildings:
			valid[Plots.key_for(b)] = true
		for k in _plot_cache.keys():
			if not valid.has(k):
				_plot_cache.erase(k)
		if not _plot_prebaked:
			# Стартовые газоны — сразу: они под загрузочным экраном, и первый
			# кадр мира не должен быть без травы. Дальше — только фоном.
			_plot_prebaked = true
			_plots = Plots.build_for(buildings, bdata, _plot_cache)
		else:
			_plots = []
			for b in buildings:
				var k := Plots.key_for(b)
				if _plot_cache.has(k):
					_plots.append(_plot_cache[k])
				elif _baker != null and not _plot_pending.has(k):
					var f: Dictionary = bdata.frame_for(str(b.get("type", "townhall")),
						str(b.get("variant", "a")), int(b.get("rot", 0)))
					if not f.is_empty():
						_plot_pending[k] = true
						_baker.enqueue(k, b, f)
	Plots.draw_layers(self, _plots, cam, z, css)
	# Новый или переехавший дом стоит в кадре сразу, а настоящий газон ещё
	# печётся фоном. Пока его нет — мягкий зелёный ромб, чтобы под домом не
	# было голой травы; когда газон готов, ромб исчезает.
	for b in buildings:
		if bool(b.get("rubble", false)):
			continue
		if _plot_cache.has(Plots.key_for(b)):
			continue
		_draw_plot_placeholder(b, z)


func _draw_plot_placeholder(b: Dictionary, z: float) -> void:
	if bdata == null:
		return
	var type := str(b.get("type", "townhall"))
	var f: Dictionary = bdata.frame_for(type, str(b.get("variant", "a")),
		int(b.get("rot", 0)))
	if f.is_empty():
		return
	var fp: Array = f.get("fp", [1, 1])
	var x0 := float(b["x"]) - 0.18
	var y0 := float(b["y"]) - 0.18
	var x1 := float(b["x"]) + float(fp[0]) + 0.18
	var y1 := float(b["y"]) + float(fp[1]) + 0.18
	var pts := PackedVector2Array()
	for p in [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]:
		pts.append(Vector2(
			css.x * 0.5 + (float(p[0]) - float(p[1]) - float(cam["x"]) + float(cam["y"])) * z * 0.5,
			css.y * 0.5 + (float(p[0]) + float(p[1]) - float(cam["x"]) - float(cam["y"])) * z * 0.25))
	draw_colored_polygon(pts, Color(0.42, 0.68, 0.28, 0.22))
	var line := pts.duplicate()
	line.append(pts[0])
	draw_polyline(line, Color(0.55, 0.82, 0.40, 0.25), 1.0)


func _draw_scene(z: float) -> void:
	if _op.is_empty() and buildings.is_empty() and villagers.is_empty():
		return
	if vdata == null or _rim_full:
		_draw_plain(z)
		return
	var sig := _villager_sig(z)
	if sig != _v_sig:
		_v_sig = sig
		_build_villager_chunks(z)
	var tr := Vector2(css.x * 0.5 + (float(cam["y"]) - float(cam["x"])) * z * 0.5,
		css.y * 0.5 - (float(cam["x"]) + float(cam["y"])) * z * 0.25)
	var sc := Vector2(z * 0.5, z * 0.25)
	for e in _vdraw:
		if e.has("b"):
			# Постройка живёт в экранных координатах: перед ней transform снять.
			draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
			_draw_building(e["b"], z)
		elif e.has("bi"):
			draw_set_transform(tr, 0.0, sc)
			_draw_nature_entry(e)
		else:
			draw_set_transform(tr, 0.0, sc)
			draw_mesh(_vchunks[int(e["m"])], _vtex(int(e["t"])))
			drawn += int(e.get("n", 0))
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)


func _draw_nature_entry(e: Dictionary) -> void:
	var bi := int(e.get("bi", -1))
	if bi < 0 or bi >= _buckets.size():
		return
	var bucket: Dictionary = _buckets[bi]
	var mesh: ArrayMesh = bucket["back"] if str(e.get("half", "")) == "back" \
		else bucket["front"]
	if mesh != null and nature != null:
		draw_mesh(mesh, nature.atlas)
		drawn += int(bucket.get("quads", 0))


## Запасной путь без атласа каймы: тот же поток глубины, но жители рисуются
## поштучно. Природа по-прежнему идёт полосами, поэтому порядок не ломается.
func _draw_plain(z: float) -> void:
	var blds := _sorted_buildings()
	var vils := _sorted_villagers()
	var j := 0
	var k := 0
	var m := 0
	var tr := Vector2(css.x * 0.5 + (float(cam["y"]) - float(cam["x"])) * z * 0.5,
		css.y * 0.5 - (float(cam["x"]) + float(cam["y"])) * z * 0.25)
	var sc := Vector2(z * 0.5, z * 0.25)
	while j < blds.size() or k < vils.size() or m < _nats.size():
		var b: Variant = blds[j] if j < blds.size() else null
		var v: Variant = vils[k] if k < vils.size() else null
		var n: Variant = _nats[m] if m < _nats.size() else null
		var kb: float = _building_key(b) if b != null else INF
		var kv: float = float(v["x"]) + float(v["y"]) if v != null else INF
		var kn: float = float(n["depth"]) if n != null else INF
		if n != null and kn <= kb and kn <= kv:
			draw_set_transform(tr, 0.0, sc)
			_draw_nature_entry(n)
			draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
			m += 1
		elif b != null and kb <= kv:
			draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
			_draw_building(b, z)
			j += 1
		elif v != null:
			draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
			_draw_villager(v, z)
			k += 1
		else:
			break
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)


## План кадра для приёмки и диагностики: один поток «природа — постройка —
## житель» по возрастанию глубины, как в браузере. Не рисует ничего.
func draw_plan() -> Array:
	if _op.is_empty():
		_prepare_objects()
	_ensure_nature()
	var out: Array = []
	if vdata == null or _rim_full:
		var blds := _sorted_buildings()
		var vils := _sorted_villagers()
		var j := 0
		var k := 0
		var m := 0
		while j < blds.size() or k < vils.size() or m < _nats.size():
			var b: Variant = blds[j] if j < blds.size() else null
			var v: Variant = vils[k] if k < vils.size() else null
			var n: Variant = _nats[m] if m < _nats.size() else null
			var kb: float = _building_key(b) if b != null else INF
			var kv: float = float(v["x"]) + float(v["y"]) if v != null else INF
			var kn: float = float(n["depth"]) if n != null else INF
			if n != null and kn <= kb and kn <= kv:
				out.append(_plan_nature(n))
				m += 1
			elif b != null and kb <= kv:
				out.append({"kind": "building", "depth": kb})
				j += 1
			elif v != null:
				out.append({"kind": "villager", "depth": kv})
				k += 1
			else:
				break
		return out
	_build_villager_chunks(float(cam.get("zoom", 40.0)))
	for e in _vdraw:
		if e.has("bi"):
			out.append(_plan_nature(e))
		elif e.has("b"):
			out.append({"kind": "building", "depth": float(e.get("depth", 0.0))})
		else:
			out.append({"kind": "villager", "depth": float(e.get("depth", 0.0))})
	return out


func _plan_nature(e: Dictionary) -> Dictionary:
	var bi := int(e.get("bi", -1))
	var shake_here := false
	if bi >= 0 and bi < _buckets.size():
		shake_here = bool(_buckets[bi].get("shake_" + str(e.get("half", "back")), false))
	return {"kind": "nature", "depth": float(e.get("depth", 0.0)),
		"bi": bi, "half": str(e.get("half", "")), "shake": shake_here}


## Дешёвая подпись состава жителей: пересобирать меш на каждую панораму
## незачем, а смена позы, поворота или скрытия её меняет.
func _villager_sig(z: float) -> String:
	var h := 2166136261
	for v in villagers:
		h = (h ^ (int(float(v["x"]) * 100.0) * 73856093
			^ int(float(v["y"]) * 100.0) * 19349663
			^ int(v.get("rot", 0)) * 83492791
			^ int(float(v.get("phase", 0.0)) * 1000.0) * 2654435761
			^ (1 if bool(v.get("warrior", false)) else 0)
			^ (2 if bool(v.get("hidden", false)) else 0)
			^ int(v.get("owner", 0)) * 7777)) & 0x7FFFFFFF
		h = (h * 16777619) & 0x7FFFFFFF
	# Геометрия спрайтов в мировых координатах от зума не зависит, а вот
	# кайма — плоский силуэт на 1.1 ЭКРАННОГО пикселя шире спрайта: в мировых
	# клетках этот запас равен 4.4/z по y и 2.2/z по x, то есть меняется с
	# зумом. Поэтому зум в подписи есть — но пересобираются только вершины
	# меша (картинки каймы давно в кэше по кадру и цвету), а не пиксели.
	var now_ms := Time.get_ticks_msec()
	if absf(z - _rim_z) > 0.0005 and now_ms - _rim_ms >= RIM_REBUILD_MS:
		_rim_z = z
		_rim_ms = now_ms
	var zq := roundi(_rim_z * 100.0)
	var tiny := 1 if z < 10.0 else 0
	# Постройки входят в подпись целиком: перенос/поворот не меняет их число,
	# а старый план кадра иначе продолжал бы рисовать дом на прошлом месте.
	var bh := 2166136261
	for b in buildings:
		bh = (bh ^ (str(b.get("id", "")).hash()
			^ int(float(b.get("x", 0.0)) * 100.0) * 73856093
			^ int(float(b.get("y", 0.0)) * 100.0) * 19349663
			^ int(b.get("rot", 0)) * 83492791
			^ str(b.get("type", "")).hash()
			^ int(b.get("owner", 0)) * 7777
			^ (1 if bool(b.get("rubble", false)) else 0)
			^ (2 if bool(b.get("pending", false)) else 0)
			^ (4 if str(b.get("pendingEdit", "")) != "" else 0))) & 0x7FFFFFFF
		bh = (bh * 16777619) & 0x7FFFFFFF
	return "%d|%d|%d|%d|%d|%d" % [h, zq, tiny,
		buildings.size(), villagers.size(), bh]


func _vtex(id: int) -> Texture2D:
	if id == 2:
		return _rim_tex
	return vdata.set_for(id == 1)["tex"]


## Один проход по слиянию построек и жителей по глубине. Жители копятся в
## «кусок» между постройками: внутри куска — кайма одним мешом, затем спрайты
## (по атласу), куски рисуются в исходном порядке.
func _build_villager_chunks(z: float) -> void:
	_vchunks.clear()
	_vdraw.clear()
	var blds := _sorted_buildings()
	var vils := _sorted_villagers()
	var run: Array = []
	var j := 0
	var k := 0
	var m := 0
	while j < blds.size() or k < vils.size() or m < _nats.size():
		var b: Variant = blds[j] if j < blds.size() else null
		var v: Variant = vils[k] if k < vils.size() else null
		var n: Variant = _nats[m] if m < _nats.size() else null
		var kb: float = _building_key(b) if b != null else INF
		var kv: float = float(v["x"]) + float(v["y"]) if v != null else INF
		var kn: float = float(n["depth"]) if n != null else INF
		# Природа — полоса глубины. Она разрывает накопленный кусок жителей,
		# поэтому дерево перед жителем честно рисуется после него.
		if n != null and kn <= kb and kn <= kv:
			_flush_run(run, z)
			run = []
			_vdraw.append(n)
			m += 1
			continue
		if b != null and kb <= kv:
			_flush_run(run, z)
			run = []
			_vdraw.append({"b": b, "depth": kb})
			j += 1
			continue
		if v == null:
			continue
		var item := _villager_item(v, z)
		k += 1
		if not item.is_empty():
			item["depth"] = kv
			run.append(item)
	_flush_run(run, z)
	if _rim_dirty and _rim_img != null:
		_rim_dirty = false
		_rim_tex = ImageTexture.create_from_image(_rim_img)


func _flush_run(run: Array, _z: float) -> void:
	if run.is_empty():
		return
	var depth := INF
	for it in run:
		depth = minf(depth, float(it.get("depth", INF)))
	# 1. Кайма: один меш из общего атласа каймы.
	var rim := _mesh_from(run, 0, run.size(), true)
	if rim != null:
		_vdraw.append({"m": _vchunks.size(), "t": 2, "depth": depth})
		_vchunks.append(rim)
	# 2. Спрайты: подряд идущие жители одного атласа — один меш.
	var start := 0
	while start < run.size():
		var t := int(run[start]["tex"])
		var end := start + 1
		while end < run.size() and int(run[end]["tex"]) == t:
			end += 1
		var mesh := _mesh_from(run, start, end, false)
		if mesh != null:
			_vdraw.append({"m": _vchunks.size(), "t": t, "n": end - start,
				"depth": depth})
			_vchunks.append(mesh)
		start = end


func _mesh_from(items: Array, from: int, to: int, rim: bool) -> ArrayMesh:
	var verts := PackedVector3Array()
	var uvs := PackedVector2Array()
	var idx := PackedInt32Array()
	for ii in range(from, to):
		var it: Dictionary = items[ii]
		var d: Rect2 = it["rim_dst"] if rim else it["dst"]
		var uv: Rect2 = it["rim"] if rim else it["uv"]
		var n := verts.size()
		verts.append(Vector3(d.position.x, d.position.y, 0))
		verts.append(Vector3(d.end.x, d.position.y, 0))
		verts.append(Vector3(d.end.x, d.end.y, 0))
		verts.append(Vector3(d.position.x, d.end.y, 0))
		uvs.append(uv.position)
		uvs.append(Vector2(uv.end.x, uv.position.y))
		uvs.append(uv.end)
		uvs.append(Vector2(uv.position.x, uv.end.y))
		idx.append(n)
		idx.append(n + 1)
		idx.append(n + 2)
		idx.append(n)
		idx.append(n + 2)
		idx.append(n + 3)
	if verts.is_empty():
		return null
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = idx
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


## Кадр, точка опоры и UV каймы для одного жителя. Пусто — не рисуется.
func _villager_item(v: Dictionary, z: float) -> Dictionary:
	if bool(v.get("hidden", false)):
		return {}
	var x := float(v["x"])
	var y := float(v["y"])
	# Меш в мировых координатах переживает панораму, поэтому отсечение по
	# кадру здесь нельзя: уехавший житель не попал бы в меш, а подпись
	# состава не изменилась бы. Отбрасываем только скрытых.
	var warrior := bool(v.get("warrior", false))
	var sc: float = vdata.scale_at(warrior, z)
	var sk := "%d|%s|%d|%d" % [1 if warrior else 0, str(v.get("anim", "idle")),
		roundi(float(v.get("phase", 0.0)) * 1000.0), int(v.get("rot", 0))]
	var spr: Dictionary
	if str(v.get("_sk", "")) == sk:
		spr = v["_spr_v"]
	else:
		spr = vdata.frame_for(warrior, str(v.get("anim", "idle")),
			float(v.get("phase", 0.0)), int(v.get("rot", 0)))
		v["_sk"] = sk
		v["_spr_v"] = spr
	if spr.is_empty():
		return {}
	var dw: float = float(spr["w"]) * sc
	if dw < 3.0:
		return {}
	# Меш живёт в мировых координатах (x−y, x+y), а не в экранных: тогда
	# панорама его не пересобирает, экранную проекцию делает draw_set_transform.
	var ww := float(spr["w"]) * 2.0 * sc / z
	var wh := float(spr["h"]) * 4.0 * sc / z
	var dst := Rect2(x - y - ww * float(spr["ax"]), x + y - wh * float(spr["ay"]), ww, wh)
	var set: Dictionary = vdata.set_for(warrior)
	var tex_id := 1 if warrior else 0
	var col := _team_color(int(v.get("owner", 0)), 0.9)
	var clip := roundi(float(spr["ay"]) * float(spr["h"])) + 1
	var rr := _rim_rect(set, spr, col, clip)
	if rr.size.x <= 0:
		return {}
	drawn += 1
	# Кайма — тот же силуэт, но шире спрайта на 1.1 экранного пикселя с
	# каждой стороны. Меш живёт в мировых клетках, поэтому пиксели экрана
	# переводятся в них делением на масштаб проекции (z/2 по x, z/4 по y).
	var gx := 2.0 * 1.1 / z
	var gy := 4.0 * 1.1 / z
	var w := float(set["tex"].get_width())
	var h := float(set["tex"].get_height())
	return {
		"dst": dst, "tex": tex_id,
		"rim_dst": Rect2(dst.position - Vector2(gx, gy),
			dst.size + Vector2(gx * 2.0, gy * 2.0)),
		"uv": Rect2(float(spr["x"]) / w, float(spr["y"]) / h,
			float(spr["w"]) / w, float(spr["h"]) / h),
		"rim": Rect2(rr.position.x / float(RIM_W), rr.position.y / float(RIM_H),
			rr.size.x / float(RIM_W), rr.size.y / float(RIM_H)),
	}


## Место каймы в атласе. Кайма — плоский силуэт кадра в цвете команды: один
## раз на (кадр, обрезку, цвет), без толщины, поэтому зум её не пересобирает.
## Переполнение атласа включает поштучный запасной путь.
func _rim_rect(set: Dictionary, f: Dictionary, color: Color, clip: int) -> Rect2:
	var key := "%d|%d|%d|%d" % [int(f["x"]), int(f["y"]), clip, color.to_rgba32()]
	if _rim_rects.has(key):
		return _rim_rects[key]
	if _rim_img == null:
		_rim_img = Image.create_empty(RIM_W, RIM_H, false, Image.FORMAT_RGBA8)
		_rim_img.fill(Color(0, 0, 0, 0))
	var img: Image = Outline.silhouette_image(set["img"], f, color, color.a, clip)
	if img == null:
		return Rect2()
	var w := img.get_width()
	var h := img.get_height()
	if _rim_x + w + 2 > RIM_W:
		_rim_x = 0
		_rim_y += _rim_row + 2
		_rim_row = 0
	if _rim_y + h + 2 > RIM_H:
		_rim_full = true
		return Rect2()
	_rim_img.blit_rect(img, Rect2i(0, 0, w, h), Vector2i(_rim_x, _rim_y))
	var r := Rect2i(_rim_x, _rim_y, w, h)
	_rim_x += w + 2
	_rim_row = maxi(_rim_row, h)
	_rim_rects[key] = r
	_rim_dirty = true
	return r


## Кадр постройки на экране: текстура, UV, прямоугольник и рамка кадра.
## Один расчёт на отрисовку и на призрак переноса — иначе призрак стоял бы не
## там, где встанет дом.
func building_screen(b: Dictionary, z: float) -> Dictionary:
	if bdata == null:
		return {}
	var type := str(b.get("type", "townhall"))
	var rubble := bool(b.get("rubble", false))
	var s: Dictionary = bdata.set_for("ruins" if rubble else type)
	if s.is_empty():
		return {}
	# У руин вариант — это тип снесённой постройки (townhall/house/...).
	var f: Dictionary = bdata.frame_for("ruins" if rubble else type,
		type if rubble else str(b.get("variant", "a")), int(b.get("rot", 0)))
	if f.is_empty():
		return {}
	var ca := cos(float(s["az"]))
	# ppu/mul кадра важнее общих: у руин они разные по типам.
	var ppu := float(f.get("ppu", s["ppu"]))
	var mul := float(f.get("mul", s["mul"]))
	var scx := mul * z / (2.0 * ca * ppu)
	var scy := mul * z / (4.0 * sin(float(s["el"])) * ca * ppu)
	var fp: Array = f["fp"]
	var cx := float(b["x"]) + float(fp[0]) * 0.5
	var cy := float(b["y"]) + float(fp[1]) * 0.5
	var shx := 0.0
	var shy := 0.0
	var g: Variant = f["ground"]
	if g != null and (g as Array).size() == 4:
		shx = (float(g[0]) + float(g[1])) * 0.5 * mul
		shy = (float(g[2]) + float(g[3])) * 0.5 * mul
	var wx := cx - shx
	var wy := cy - shy
	var px := (wx - wy - float(cam["x"]) + float(cam["y"])) * z * 0.5
	var py := (wx + wy - float(cam["x"]) - float(cam["y"])) * z * 0.25
	var dw := float(f["w"]) * scx
	var dh := float(f["h"]) * scy
	var dst := Rect2(css.x * 0.5 + px - dw * float(f["ax"]),
		css.y * 0.5 + py - dh * float(f["ay"]), dw, dh)
	return {"tex": s["tex"], "dst": dst,
		"region": Rect2(float(f["x"]), float(f["y"]), float(f["w"]), float(f["h"])),
		"f": f, "s": s, "scx": scx}


func _draw_building(b: Dictionary, z: float) -> void:
	if bdata == null:
		return
	if float(b["x"]) < _box.position.x - 4.0 or float(b["x"]) > _box.end.x \
			or float(b["y"]) < _box.position.y - 4.0 or float(b["y"]) > _box.end.y:
		return
	var info := building_screen(b, z)
	if info.is_empty():
		return
	var s: Dictionary = info["s"]
	var f: Dictionary = info["f"]
	drawn += 1
	var pending := bool(b.get("pending", false)) or str(b.get("pendingEdit", "")) != ""
	var tint := Color(1, 1, 1, 0.92) if pending else Color.WHITE
	var color := _team_color(int(b.get("owner", 0)), 1.0)
	var sil := _edge(_edge_b, s, f, color, 1.0, 0)
	if sil != null:
		# Кайма — плоский силуэт ПОД спрайтом, на 1.4 экранных пикселя шире
		# него с каждой стороны. Толщина задана в пикселях экрана, поэтому от
		# зума не зависит и при зуме не пересобирается (см. outline.gd).
		var grow := 1.4
		draw_texture_rect(sil, Rect2(info["dst"].position - Vector2(grow, grow),
			info["dst"].size + Vector2(grow * 2.0, grow * 2.0)), false,
			Color(1, 1, 1, 0.72 if pending else 1.0))
	draw_texture_rect_region(info["tex"], info["dst"], info["region"], tint)
	if pending:
		_draw_pending_mark(b, f, info["dst"])


## Ожидание сервера: пульсирующая рамка пятна и точка над постройкой. Это
## «поверх» — игрок видит, что клиент уже поставил дом, а сервер ещё думает.
func _draw_pending_mark(b: Dictionary, f: Dictionary, dst: Rect2) -> void:
	var z := float(cam["zoom"])
	var fp: Array = f.get("fp", [1, 1])
	var x0 := float(b["x"])
	var y0 := float(b["y"])
	var x1 := x0 + float(fp[0])
	var y1 := y0 + float(fp[1])
	var pts := PackedVector2Array()
	for p in [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]:
		pts.append(Vector2(
			css.x * 0.5 + (float(p[0]) - float(p[1]) - float(cam["x"]) + float(cam["y"])) * z * 0.5,
			css.y * 0.5 + (float(p[0]) + float(p[1]) - float(cam["x"]) - float(cam["y"])) * z * 0.25))
	var pulse := 0.5 + 0.5 * sin(float(Time.get_ticks_msec()) * 0.007)
	var deleting := str(b.get("pendingEdit", "")) == "delete"
	var col := Color(0.95, 0.42, 0.32, 0.45 + 0.35 * pulse) if deleting \
		else Color(0.56, 0.98, 0.62, 0.45 + 0.35 * pulse)
	pts.append(pts[0])
	draw_polyline(pts, col, 2.0)
	var top := Vector2(dst.position.x + dst.size.x * 0.5,
		dst.position.y + dst.size.y * 0.18)
	draw_circle(top, 3.0 + 2.0 * pulse, col)
	draw_arc(top, 7.0 + 3.0 * pulse, 0.0, TAU, 20, Color(col.r, col.g, col.b, 0.35 * pulse), 1.5)


func _draw_villager(v: Dictionary, z: float) -> void:
	if vdata == null or bool(v.get("hidden", false)):
		return
	if float(v["x"]) < _box.position.x or float(v["x"]) > _box.end.x \
			or float(v["y"]) < _box.position.y or float(v["y"]) > _box.end.y:
		return
	var warrior := bool(v.get("warrior", false))
	var sc: float = vdata.scale_at(warrior, z)
	var spr: Dictionary = vdata.frame_for(warrior, str(v.get("anim", "idle")),
		float(v.get("phase", 0.0)), int(v.get("rot", 0)))
	if spr.is_empty():
		return
	var dw: float = float(spr["w"]) * sc
	var dh: float = float(spr["h"]) * sc
	if dw < 3.0:
		return
	drawn += 1
	var px := (float(v["x"]) - float(v["y"]) - float(cam["x"]) + float(cam["y"])) * z * 0.5
	var py := (float(v["x"]) + float(v["y"]) - float(cam["x"]) - float(cam["y"])) * z * 0.25
	var dst := Rect2(css.x * 0.5 + px - dw * float(spr["ax"]),
		css.y * 0.5 + py - dh * float(spr["ay"]), dw, dh)
	var set: Dictionary = vdata.set_for(false)
	var clip := roundi(float(spr["ay"]) * float(spr["h"])) + 1
	var color := _team_color(int(v.get("owner", 0)), 0.9)
	var sil := _edge(_edge_v, set, spr, color, 0.9, clip)
	if sil != null:
		# Запасной путь рисует в экранных пикселях: кайма шире спрайта ровно
		# на 1.1 px с каждой стороны.
		var gx := 1.1
		var gy := 1.1
		draw_texture_rect(sil, Rect2(dst.position - Vector2(gx, gy),
			dst.size + Vector2(gx * 2.0, gy * 2.0)), false, Color.WHITE)
	draw_texture_rect_region(set["tex"], dst,
		Rect2(float(spr["x"]), float(spr["y"]), float(spr["w"]), float(spr["h"])), Color.WHITE)


func _sorted_buildings() -> Array:
	var out: Array = buildings.duplicate()
	out.sort_custom(func(a, b): return _building_key(a) < _building_key(b))
	return out


func _sorted_villagers() -> Array:
	var out: Array = villagers.duplicate()
	out.sort_custom(func(a, b): return float(a["x"]) + float(a["y"]) < float(b["x"]) + float(b["y"]))
	return out


func _building_key(b: Dictionary) -> float:
	var type := str(b.get("type", "townhall"))
	var rubble := bool(b.get("rubble", false))
	var s: Dictionary = bdata.set_for("ruins" if rubble else type)
	if s.is_empty():
		return float(b["x"]) + float(b["y"])
	var f: Dictionary = bdata.frame_for("ruins" if rubble else type,
		type if rubble else str(b.get("variant", "a")), int(b.get("rot", 0)))
	if f.is_empty():
		return float(b["x"]) + float(b["y"])
	var fp: Array = f["fp"]
	return float(b["x"]) + float(fp[0]) * 0.5 + float(b["y"]) + float(fp[1]) * 0.5


var _team_cols: Dictionary = {}


func _team_color(owner: int, alpha: float) -> Color:
	var ck := "%d|%d" % [owner, roundi(alpha * 100.0)]
	if _team_cols.has(ck):
		return _team_cols[ck]
	var c := _team_color_raw(owner, alpha)
	_team_cols[ck] = c
	return c


func _team_color_raw(owner: int, alpha: float) -> Color:
	var hex := "#4a90d9"
	if owner >= 0 and owner < town_colors.size():
		hex = str(town_colors[owner])
	hex = hex.replace("#", "")
	if hex.length() != 6:
		hex = "4a90d9"
	var c := Color8(
		("0x" + hex.substr(0, 2)).hex_to_int(),
		("0x" + hex.substr(2, 2)).hex_to_int(),
		("0x" + hex.substr(4, 2)).hex_to_int())
	c.a = alpha
	return c


## Плоский силуэт кадра в цвете команды. Ключ БЕЗ толщины: толщина теперь
## задаётся при рисовании (силуэт шире спрайта на пиксели экрана), поэтому
## зум этот кэш не трогает вовсе.
func _edge(cache: Dictionary, set: Dictionary, f: Dictionary, color: Color,
		alpha: float, clip: int) -> Texture2D:
	var key := "%d|%d|%d|%d" % [int(f["x"]), int(f["y"]), clip, color.to_rgba32()]
	if cache.has(key):
		return cache[key]
	var tex = Outline.silhouette(set["img"], f, color, alpha, clip)
	cache[key] = tex
	return tex
