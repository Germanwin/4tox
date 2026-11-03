class_name ToxWorldLayer
extends Node2D

## One pass over nature, buildings and villagers in the browser's depth order.
## Nature is batched into a single ArrayMesh; buildings and villagers keep
## individual draws (and their rims) so the depth between them stays exact.

const Outline = preload("res://scripts/outline.gd")
const Plots = preload("res://scripts/plots.gd")

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

var _edge_b: Dictionary = {}
var _edge_v: Dictionary = {}
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


func _ready() -> void:
	var mat := ShaderMaterial.new()
	var sh := Shader.new()
	sh.code = LOD_SHADER
	mat.shader = sh
	mat.set_shader_parameter("lod", lod)
	material = mat


func _draw() -> void:
	var t0 := Time.get_ticks_usec()
	var z := float(cam["zoom"])
	_box = _view_box(z)
	drawn = 0
	picks = 0
	if _op.is_empty():
		_prepare_objects()
	var key := "%s|%s|%s|%s|%s" % [cam["x"], cam["y"], z, css.x, css.y]
	if key != _mesh_key:
		_mesh_key = key
		_mesh_dirty = true
	if _mesh_dirty:
		_build_nature_mesh(z)
	if show_plots:
		_draw_plots(z)
	if _nature_mesh != null:
		draw_mesh(_nature_mesh, nature.atlas)
	_draw_buildings_villagers(z)
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


func _prepare_objects() -> void:
	if not _op.is_empty() or objects.is_empty():
		return
	_on = objects.size()
	_op.resize(_on * 11)
	_ok.resize(_on)
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


func _build_nature_mesh(z: float) -> void:
	_mesh_dirty = false
	mesh_builds += 1
	_nature_mesh = null
	if _op.is_empty() or nature == null:
		return
	var verts := PackedVector3Array()
	var uvs := PackedVector2Array()
	var idx := PackedInt32Array()
	var tw := float(nature.atlas.get_width())
	var th := float(nature.atlas.get_height())
	var base := z / float(nature.ppu) * float(nature.mul)
	var half := css * 0.5
	for i in range(_on):
		var b := i * 11
		var ox := _op[b]
		var oy := _op[b + 1]
		if ox < _box.position.x or ox > _box.end.x or oy < _box.position.y or oy > _box.end.y:
			continue
		var sc := base * _op[b + 8]
		var dw := _op[b + 4] * sc
		var dh := _op[b + 5] * sc
		if dw < 2.5:
			continue
		var px := (ox - oy - float(cam["x"]) + float(cam["y"])) * z * 0.5
		var py := (ox + oy - float(cam["x"]) - float(cam["y"])) * z * 0.25
		if z >= 26.0 and _op[b + 10] > 0.5:
			px += sin(_op[b + 9]) * z * 0.018
		var qx := half.x + px - dw * _op[b + 6]
		var qy := half.y + py - dh * _op[b + 7]
		var u0 := _op[b + 2] / tw
		var v0 := _op[b + 3] / th
		var u1 := (_op[b + 2] + _op[b + 4]) / tw
		var v1 := (_op[b + 3] + _op[b + 5]) / th
		var n := verts.size()
		verts.append(Vector3(qx, qy, 0))
		verts.append(Vector3(qx + dw, qy, 0))
		verts.append(Vector3(qx + dw, qy + dh, 0))
		verts.append(Vector3(qx, qy + dh, 0))
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
		drawn += 1
	if verts.is_empty():
		return
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = idx
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	_nature_mesh = mesh


func _draw_plots(z: float) -> void:
	if bdata == null or buildings.is_empty():
		return
	var key := ""
	for b in buildings:
		key += "%s@%s,%s,%s;" % [str(b.get("id", "")), str(b["x"]), str(b["y"]), str(b.get("rot", 0))]
	if key != _plots_key:
		_plots_key = key
		_plots = Plots.build_for(buildings, bdata)
	Plots.draw_layers(self, _plots, cam, z, css)


func _draw_buildings_villagers(z: float) -> void:
	if vdata == null or villagers.is_empty() or _rim_full:
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
		else:
			draw_set_transform(tr, 0.0, sc)
			draw_mesh(_vchunks[int(e["m"])], _vtex(int(e["t"])))
			drawn += int(e.get("n", 0))
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)


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
			^ (2 if bool(v.get("hidden", false)) else 0))) & 0x7FFFFFFF
		h = (h * 16777619) & 0x7FFFFFFF
	return "%d|%s|%s|%s|%d" % [h, str(z), str(css), str(buildings.size()), villagers.size()]


## Старый поштучный путь: он же запасной, если атлас каймы переполнился.
func _draw_plain(z: float) -> void:
	var blds := _sorted_buildings()
	var vils := _sorted_villagers()
	var j := 0
	var k := 0
	while j < blds.size() or k < vils.size():
		var b: Variant = blds[j] if j < blds.size() else null
		var v: Variant = vils[k] if k < vils.size() else null
		var kb: float = _building_key(b) if b != null else INF
		var kv: float = float(v["x"]) + float(v["y"]) if v != null else INF
		if b != null and kb <= kv:
			_draw_building(b, z)
			j += 1
		else:
			_draw_villager(v, z)
			k += 1


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
	while j < blds.size() or k < vils.size():
		var b: Variant = blds[j] if j < blds.size() else null
		var v: Variant = vils[k] if k < vils.size() else null
		var kb: float = _building_key(b) if b != null else INF
		var kv: float = float(v["x"]) + float(v["y"]) if v != null else INF
		if b != null and kb <= kv:
			_flush_run(run, z)
			run = []
			_vdraw.append({"b": b})
			j += 1
			continue
		var item := _villager_item(v, z)
		k += 1
		if not item.is_empty():
			run.append(item)
	_flush_run(run, z)
	if _rim_dirty and _rim_img != null:
		_rim_dirty = false
		_rim_tex = ImageTexture.create_from_image(_rim_img)


func _flush_run(run: Array, _z: float) -> void:
	if run.is_empty():
		return
	# 1. Кайма: один меш из общего атласа каймы.
	var rim := _mesh_from(run, 0, run.size(), true)
	if rim != null:
		_vdraw.append({"m": _vchunks.size(), "t": 2})
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
			_vdraw.append({"m": _vchunks.size(), "t": t, "n": end - start})
			_vchunks.append(mesh)
		start = end


func _mesh_from(items: Array, from: int, to: int, rim: bool) -> ArrayMesh:
	var verts := PackedVector3Array()
	var uvs := PackedVector2Array()
	var idx := PackedInt32Array()
	for ii in range(from, to):
		var it: Dictionary = items[ii]
		var d: Rect2 = it["dst"]
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
	var epx := maxi(1, roundi(1.1 / sc))
	var clip := roundi(float(spr["ay"]) * float(spr["h"])) + 1
	var rr := _rim_rect(set, spr, col, epx, clip)
	if rr.size.x <= 0.0:
		return {}
	drawn += 1
	var w := float(set["tex"].get_width())
	var h := float(set["tex"].get_height())
	return {
		"dst": dst, "tex": tex_id,
		"uv": Rect2(float(spr["x"]) / w, float(spr["y"]) / h,
			float(spr["w"]) / w, float(spr["h"]) / h),
		"rim": Rect2(rr.position.x / float(RIM_W), rr.position.y / float(RIM_H),
			rr.size.x / float(RIM_W), rr.size.y / float(RIM_H)),
	}


## Место каймы в атласе. Кайма строится один раз на (кадр, толщина, обрезку,
## цвет); переполнение атласа включает поштучный запасной путь.
func _rim_rect(set: Dictionary, f: Dictionary, color: Color, px: int, clip: int) -> Rect2:
	var key := "%d|%d|%d|%d|%d" % [int(f["x"]), int(f["y"]), px, clip, color.to_rgba32()]
	if _rim_rects.has(key):
		return _rim_rects[key]
	if _rim_img == null:
		_rim_img = Image.create_empty(RIM_W, RIM_H, false, Image.FORMAT_RGBA8)
		_rim_img.fill(Color(0, 0, 0, 0))
	var img: Image = Outline.build_image(set["img"], f, color, color.a, px, clip)
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


func _draw_building(b: Dictionary, z: float) -> void:
	if bdata == null:
		return
	if float(b["x"]) < _box.position.x - 4.0 or float(b["x"]) > _box.end.x \
			or float(b["y"]) < _box.position.y - 4.0 or float(b["y"]) > _box.end.y:
		return
	var type := str(b.get("type", "townhall"))
	var rubble := bool(b.get("rubble", false))
	var s: Dictionary = bdata.set_for("ruins" if rubble else type)
	if s.is_empty():
		return
	# У руин вариант — это тип снесённой постройки (townhall/house/...).
	var f: Dictionary = bdata.frame_for("ruins" if rubble else type,
		type if rubble else str(b.get("variant", "a")), int(b.get("rot", 0)))
	if f.is_empty():
		return
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
	drawn += 1
	var dst := Rect2(css.x * 0.5 + px - dw * float(f["ax"]),
		css.y * 0.5 + py - dh * float(f["ay"]), dw, dh)
	draw_texture_rect_region(s["tex"], dst,
		Rect2(float(f["x"]), float(f["y"]), float(f["w"]), float(f["h"])), Color.WHITE)
	var epx := maxi(1, roundi(1.4 / scx))
	var color := _team_color(int(b.get("owner", 0)), 1.0)
	var edge := _edge(_edge_b, s, f, color, epx, 0)
	if edge != null:
		draw_texture_rect(edge, dst, false, Color.WHITE)


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
	draw_texture_rect_region(set["tex"], dst,
		Rect2(float(spr["x"]), float(spr["y"]), float(spr["w"]), float(spr["h"])), Color.WHITE)
	var epx := maxi(1, roundi(1.1 / sc))
	var clip := roundi(float(spr["ay"]) * float(spr["h"])) + 1
	var color := _team_color(int(v.get("owner", 0)), 0.9)
	var edge := _edge(_edge_v, set, spr, color, epx, clip)
	if edge != null:
		draw_texture_rect(edge, dst, false, Color.WHITE)


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


func _edge(cache: Dictionary, set: Dictionary, f: Dictionary, color: Color,
		px: int, clip: int) -> Texture2D:
	var key := "%d|%d|%d|%d|%d" % [int(f["x"]), int(f["y"]), px, clip, color.to_rgba32()]
	if cache.has(key):
		return cache[key]
	var tex = Outline.build(set["img"], f, color, color.a, px, clip)
	cache[key] = tex
	return tex
