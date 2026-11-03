class_name ToxMatchFx
extends Node2D

## Слой эффектов поверх мира: клетка под курсором, кольца выбранных жителей,
## контур выбранной постройки, полосы здоровья, метка приказа. Правил здесь
## нет — только то, что уже пришло в снимке сервера.

var cam := {"x": 0.0, "y": 0.0, "zoom": 40.0}
var css := Vector2(1440, 900)
var zoom := 40.0
var hover_cell := Vector2i(-1, -1)
var show_hover := false
var selected_building := ""
var selected_villagers: Array = []
var footprint := Vector2i(0, 0)
var buildings: Array = []
var villagers: Array = []
var order_marker: Dictionary = {}
var mode := ""                    # "", "place", "order"
var place_valid := true
var max_hp_villager := 15.0
var max_hp_warrior := 25.0
var team_color := Color("#4a90d9")


func _ready() -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR


func _w2s(wx: float, wy: float) -> Vector2:
	return Vector2(
		css.x * 0.5 + (wx - wy - float(cam["x"]) + float(cam["y"])) * zoom * 0.5,
		css.y * 0.5 + (wx + wy - float(cam["x"]) - float(cam["y"])) * zoom * 0.25)


func _diamond(x0: float, y0: float, w: float, h: float) -> PackedVector2Array:
	return PackedVector2Array([
		_w2s(x0, y0), _w2s(x0 + w, y0), _w2s(x0 + w, y0 + h), _w2s(x0, y0 + h)])


func _draw() -> void:
	# Клетка под курсором: тонкий ромб. Показывается и в обычном режиме —
	# игрок должен видеть, куда попадёт клик.
	if show_hover and hover_cell.x >= 0:
		var pts := _diamond(float(hover_cell.x), float(hover_cell.y), 1.0, 1.0)
		pts.append(pts[0])
		draw_polyline(pts, Color(0.98, 0.96, 0.86, 0.35), 1.0)

	# Контур выбранной постройки: по пятну, цветом команды.
	if selected_building != "":
		for b in buildings:
			if str(b.get("id", "")) != selected_building:
				continue
			var fp := footprint
			if fp.x <= 0:
				fp = Vector2i(2, 3)
			var rect := _diamond(float(b["x"]), float(b["y"]), float(fp.x), float(fp.y))
			rect.append(rect[0])
			draw_polyline(rect, Color(team_color, 0.95), 2.0)
			draw_colored_polygon(_diamond(float(b["x"]), float(b["y"]), float(fp.x), float(fp.y)),
				Color(team_color, 0.10))
			break

	# Кольца выбранных жителей и полосы здоровья.
	for v in villagers:
		var id := str(v.get("id", ""))
		var x := float(v.get("x", 0.0))
		var y := float(v.get("y", 0.0))
		var hp := float(v.get("hp", -1.0))
		var warrior := bool(v.get("warrior", false))
		var max_hp := max_hp_warrior if warrior else max_hp_villager
		if hp >= 0.0 and hp < max_hp - 0.01 and int(v.get("owner", 0)) == 0:
			var p := _w2s(x, y)
			var w := maxf(18.0, zoom * 0.42)
			var top := p + Vector2(-w * 0.5, -zoom * 0.78)
			draw_rect(Rect2(top, Vector2(w, 3.0)), Color(0.08, 0.06, 0.04, 0.65))
			draw_rect(Rect2(top, Vector2(w * clampf(hp / max_hp, 0.0, 1.0), 3.0)),
				Color("#d9563f") if hp / max_hp < 0.5 else Color("#7dc75e"))
		if selected_villagers.has(id):
			var c := _w2s(x, y)
			var rx := maxf(9.0, zoom * 0.30)
			var ry := maxf(4.5, zoom * 0.15)
			var ring := PackedVector2Array()
			for i in range(25):
				var a := float(i) / 24.0 * TAU
				ring.append(c + Vector2(cos(a) * rx, sin(a) * ry))
			draw_polyline(ring, Color(team_color, 0.95), 2.0)
			draw_colored_polygon(ring, Color(team_color, 0.14))

	# Метка приказа: ромб с крестом.
	if not order_marker.is_empty():
		var c := _w2s(float(order_marker["x"]) + 0.5, float(order_marker["y"]) + 0.5)
		var r := maxf(8.0, zoom * 0.22)
		var d := PackedVector2Array([c + Vector2(0, -r), c + Vector2(r, 0),
			c + Vector2(0, r), c + Vector2(-r, 0), c + Vector2(0, -r)])
		draw_polyline(d, Color("#eaffb8"), 2.0)
		draw_line(c + Vector2(-r * 0.5, 0), c + Vector2(r * 0.5, 0), Color("#eaffb8"), 2.0)
		draw_line(c + Vector2(0, -r * 0.5), c + Vector2(0, r * 0.5), Color("#eaffb8"), 2.0)
