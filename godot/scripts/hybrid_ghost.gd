class_name ToxHybridGhost
extends Node2D

## Призрак постановки: ромб пятна под курсором и слова, почему место не
## годится. Правил места здесь нет — ответ даёт `/api/check`, а решение всё
## равно принимает команда сервера. Пока ответа нет, ромб нейтральный.

var cell := Vector2i(-1, -1)
var footprint := Vector2i(4, 3)
var zoom := 40.0
var cam := {"x": 0.0, "y": 0.0}
var css := Vector2(1440, 900)
var valid := true
var valid_known := false
var reason := ""
## Спрайт ведомой постройки: сам дом, а не только ромб пятна. Так игрок видит,
## куда именно встанет стена и дверь, а не абстрактный прямоугольник.
var sprite_tex: Texture2D = null
var sprite_region := Rect2()
var sprite_dst := Rect2()
var sprite_tint := Color(1, 1, 1, 0.55)


func _draw() -> void:
	if cell.x < 0 or cell.y < 0:
		return
	var z := zoom
	var half := css * 0.5
	var x0 := float(cell.x)
	var y0 := float(cell.y)
	var x1 := x0 + float(footprint.x)
	var y1 := y0 + float(footprint.y)
	var pts := PackedVector2Array()
	for p in [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]:
		var wx: float = float(p[0])
		var wy: float = float(p[1])
		pts.append(Vector2(
			half.x + (wx - wy - float(cam["x"]) + float(cam["y"])) * z * 0.5,
			half.y + (wx + wy - float(cam["x"]) - float(cam["y"])) * z * 0.25))
	if sprite_tex != null:
		draw_texture_rect_region(sprite_tex, sprite_dst, sprite_region, sprite_tint)
	var fill := Color(0.49, 0.91, 0.64, 0.30)
	var edge := Color(0.98, 0.96, 0.86, 0.85)
	if valid_known and not valid:
		fill = Color(0.91, 0.36, 0.28, 0.30)
		edge = Color(1.0, 0.72, 0.62, 0.95)
	draw_colored_polygon(pts, fill)
	var outline := pts.duplicate()
	outline.append(pts[0])
	draw_polyline(outline, edge, 2.0)
	if valid_known and not valid and reason != "":
		var font := ThemeDB.fallback_font
		var size := 14
		var at := Vector2(pts[1].x, pts[1].y + 4.0)
		var w := font.get_string_size(reason, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x
		draw_rect(Rect2(at + Vector2(-2, -2), Vector2(w + 8, size + 8)),
			Color(0.08, 0.05, 0.03, 0.72))
		draw_string(font, at + Vector2(2, size), reason,
			HORIZONTAL_ALIGNMENT_LEFT, -1, size, Color(1.0, 0.9, 0.82))
