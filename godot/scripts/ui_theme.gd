class_name ToxUI
extends RefCounted

const GRASS := Color("#7dc75e")
const GRASS_LITE := Color("#a6e37f")
const GRASS_DARK := Color("#4e9a34")
const SAND := Color("#f0dca2")
const WOOD_LITE := Color("#dcbe92")
const WOOD := Color("#c19a68")
const WOOD_MID := Color("#a97f4f")
const WOOD_DARK := Color("#7a5533")
const WOOD_DEEP := Color("#4a3220")
const OUTLINE := Color("#3b2a19")
const SEA := Color("#449dd1")
const SEA_DEEP := Color("#164e80")
const INK := Color("#3d2a17")
const INK_SOFT := Color("#6b5236")
const CREAM := Color("#fdf6e3")
const TEAM := Color("#4a90d9")

static var _theme: Theme
static var _wood_tex: Texture2D

static func theme() -> Theme:
	if _theme != null:
		return _theme
	var t := Theme.new()
	t.default_font_size = 16
	t.set_color("font_color", "Label", CREAM)
	t.set_color("font_shadow_color", "Label", Color(0, 0, 0, 0.35))
	t.set_constant("shadow_offset_x", "Label", 1)
	t.set_constant("shadow_offset_y", "Label", 2)
	t.set_constant("outline_size", "Label", 0)

	var normal := _box(WOOD, WOOD_DARK, 3, 10, 14)
	normal.shadow_color = Color(0.06, 0.04, 0.02, 0.35)
	normal.shadow_size = 5
	normal.shadow_offset = Vector2(0, 4)
	var hover := _box(WOOD_LITE, WOOD_DARK, 3, 10, 14)
	hover.shadow_color = Color(0.06, 0.04, 0.02, 0.3)
	hover.shadow_size = 4
	hover.shadow_offset = Vector2(0, 3)
	var pressed := _box(WOOD_MID, WOOD_DEEP, 3, 10, 14)
	var disabled := _box(Color("#8a7a63"), Color("#5f5140"), 2, 10, 14)
	var focus := _box(Color(0.98, 0.96, 0.86, 0.0), Color("#fdf6e3"), 2, 12, 4)
	t.set_stylebox("normal", "Button", normal)
	t.set_stylebox("hover", "Button", hover)
	t.set_stylebox("pressed", "Button", pressed)
	t.set_stylebox("disabled", "Button", disabled)
	t.set_stylebox("focus", "Button", focus)
	t.set_color("font_color", "Button", INK)
	t.set_color("font_hover_color", "Button", Color("#2b1d0f"))
	t.set_color("font_pressed_color", "Button", Color("#2b1d0f"))
	t.set_color("font_disabled_color", "Button", Color("#4a3d2e"))
	t.set_font_size("font_size", "Button", 15)

	var panel := _box(WOOD_LITE, WOOD_DARK, 4, 18, 16)
	panel.shadow_color = Color(0.04, 0.03, 0.02, 0.45)
	panel.shadow_size = 12
	panel.shadow_offset = Vector2(0, 8)
	t.set_stylebox("panel", "PanelContainer", panel)
	t.set_stylebox("panel", "Panel", panel)

	var edit := _box(CREAM, WOOD_DARK, 3, 8, 10)
	t.set_stylebox("normal", "LineEdit", edit)
	t.set_color("font_color", "LineEdit", INK)
	t.set_color("caret_color", "LineEdit", INK)
	t.set_color("selection_color", "LineEdit", Color(0.55, 0.78, 0.4, 0.5))
	t.set_font_size("font_size", "LineEdit", 16)

	var scroll := _box(Color(0, 0, 0, 0), Color(0, 0, 0, 0), 0, 0, 0)
	t.set_stylebox("panel", "ScrollContainer", scroll)
	t.set_color("font_color", "RichTextLabel", CREAM)
	_theme = t
	return t

static func _box(bg: Color, border: Color, bw: int, radius: int, pad: int) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(bw)
	s.set_corner_radius_all(radius)
	s.content_margin_left = pad
	s.content_margin_right = pad
	s.content_margin_top = pad * 0.6
	s.content_margin_bottom = pad * 0.6
	s.anti_aliasing = true
	return s

static func wood_texture() -> Texture2D:
	if _wood_tex != null:
		return _wood_tex
	var img := Image.create_empty(256, 256, false, Image.FORMAT_RGBA8)
	img.fill(WOOD)
	for y in range(256):
		for x in range(256):
			var plank := int(x / 32)
			var edge := x % 32
			var n := ToxNoise.hash2i(x, y, 771)
			var c := WOOD
			c = c.lerp(WOOD_LITE, n * 0.16)
			if edge < 2:
				c = c.lerp(WOOD_DARK, 0.55)
			elif edge == 2:
				c = c.lerp(WOOD_LITE, 0.35)
			if y % 64 < 2:
				c = c.lerp(WOOD_MID, 0.35)
			var grain := sin(float(y) * 0.35 + float(plank) * 1.7) * 0.04
			c = c.lightened(grain if grain > 0.0 else 0.0).darkened(-grain if grain < 0.0 else 0.0)
			img.set_pixel(x, y, c)
	_wood_tex = ImageTexture.create_from_image(img)
	return _wood_tex

static func label(text: String, size: int = 16, color: Color = CREAM, outline: int = 0) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	if outline > 0:
		l.add_theme_constant_override("outline_size", outline)
		l.add_theme_color_override("font_outline_color", OUTLINE)
	return l

static func ink_label(text: String, size: int = 16) -> Label:
	return label(text, size, INK)

static func button(text: String, size: int = 15) -> Button:
	var b := Button.new()
	b.text = text
	b.add_theme_font_size_override("font_size", size)
	b.focus_mode = Control.FOCUS_ALL
	return b

static func panel(pad: int = 14, color: Color = WOOD_LITE) -> PanelContainer:
	var p := PanelContainer.new()
	var sb := _box(color, WOOD_DARK, 4, 16, pad)
	sb.shadow_color = Color(0.04, 0.03, 0.02, 0.45)
	sb.shadow_size = 10
	sb.shadow_offset = Vector2(0, 6)
	p.add_theme_stylebox_override("panel", sb)
	return p

static func clear(node: Node) -> void:
	for c in node.get_children():
		c.queue_free()

static func hsep(h: int = 8) -> Control:
	var c := Control.new()
	c.custom_minimum_size = Vector2(0, h)
	return c

static func portrait(frame: Dictionary, target: Vector2 = Vector2(64, 64)) -> TextureRect:
	var tr := TextureRect.new()
	tr.custom_minimum_size = target
	tr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tr.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	tr.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	if frame.is_empty():
		return tr
	var at := AtlasTexture.new()
	at.atlas = frame.tex
	at.region = frame.region
	tr.texture = at
	return tr

static func fmt_time(t: float) -> String:
	var s := int(maxf(0.0, t))
	return "%02d:%02d" % [s / 60, s % 60]
