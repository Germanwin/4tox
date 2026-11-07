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
## Палитра интерфейса: дерево/пергамент + мох + золото + опасность. Одна на
## меню, HUD и лобби — как требует стиль игры (низкополигональная деревня).
const MOSS := Color("#6fb84a")
const MOSS_LITE := Color("#8ed167")
const MOSS_DARK := Color("#39702a")
const PARCHMENT := Color("#f6e7c4")
const GOLD := Color("#e7bd63")
const GOLD_DARK := Color("#a87a2a")
const DANGER := Color("#c8563f")
const PANEL_DARK := Color("#1a2420")

static var _theme: Theme
static var _wood_tex: Texture2D
static var _font: Font
static var _btn_tex: Dictionary = {}
static var _box_tex: Dictionary = {}
static var _glow_tex: Texture2D
static var _vignette_tex: Texture2D
static var _shadow_tex: Texture2D

## Округлый системный шрифт, как в браузере (SF Pro Rounded на macOS). Без
## него Godot рисует обычный рубленый шрифт, и интерфейс выглядит «не как в
## браузере» даже при тех же цветах.
static func font() -> Font:
	if _font != null:
		return _font
	var f := SystemFont.new()
	f.font_names = PackedStringArray([
		"SF Pro Rounded", "Arial Rounded MT Bold", "Trebuchet MS",
		"Segoe UI", "Noto Sans", "Arial"])
	f.font_weight = 600
	f.allow_system_fallback = true
	_font = f
	return _font


static func theme() -> Theme:
	if _theme != null:
		return _theme
	var t := Theme.new()
	t.default_font = font()
	t.default_font_size = 16
	t.set_color("font_color", "Label", CREAM)
	t.set_color("font_shadow_color", "Label", Color(0, 0, 0, 0.35))
	t.set_constant("shadow_offset_x", "Label", 1)
	t.set_constant("shadow_offset_y", "Label", 2)
	t.set_constant("outline_size", "Label", 0)

	var secondary := button_set("secondary")
	for key in secondary:
		t.set_stylebox(str(key), "Button", secondary[key])
	var focus := _box(Color(0.98, 0.96, 0.86, 0.0), Color("#fff4cf"), 2, 14, 2)
	focus.expand_margin_left = 2
	focus.expand_margin_right = 2
	focus.expand_margin_top = 2
	focus.expand_margin_bottom = 2
	t.set_stylebox("focus", "Button", focus)
	t.set_color("font_color", "Button", INK)
	t.set_color("font_hover_color", "Button", Color("#2b1d0f"))
	t.set_color("font_pressed_color", "Button", Color("#2b1d0f"))
	t.set_color("font_disabled_color", "Button", Color("#4a3d2e"))
	t.set_font_size("font_size", "Button", 15)
	t.set_font("font", "Button", font())
	t.set_font("font", "Label", font())

	var panel := panel_style(false)
	t.set_stylebox("panel", "PanelContainer", panel)
	t.set_stylebox("panel", "Panel", panel)

	var edit := _box(Color("#fbf3dd"), WOOD_DARK, 3, 12, 12)
	edit.shadow_color = Color(0.12, 0.08, 0.04, 0.35)
	edit.shadow_size = 3
	edit.shadow_offset = Vector2(0, 2)
	t.set_stylebox("normal", "LineEdit", edit)
	t.set_stylebox("focus", "LineEdit", _box(Color("#fffaf0"), GOLD_DARK, 3, 12, 12))
	t.set_color("font_color", "LineEdit", INK)
	t.set_color("caret_color", "LineEdit", INK)
	t.set_color("selection_color", "LineEdit", Color(0.55, 0.78, 0.4, 0.5))
	t.set_font_size("font_size", "LineEdit", 16)

	var scroll := _box(Color(0, 0, 0, 0), Color(0, 0, 0, 0), 0, 0, 0)
	t.set_stylebox("panel", "ScrollContainer", scroll)
	t.set_color("font_color", "RichTextLabel", CREAM)
	_theme = t
	return t


## Набор стилей кнопки. Стили — девять ломтей из процедурной текстуры: дерево,
## фаска, тёмный контур, без «плоских» прямоугольников.
static func button_set(kind: String) -> Dictionary:
	var out := {}
	for state in ["normal", "hover", "pressed", "disabled"]:
		var sb := StyleBoxTexture.new()
		sb.texture = button_texture(kind, state)
		sb.texture_margin_left = 26
		sb.texture_margin_right = 26
		sb.texture_margin_top = 22
		sb.texture_margin_bottom = 22
		sb.content_margin_left = 16
		sb.content_margin_right = 16
		sb.content_margin_top = 9
		sb.content_margin_bottom = 9
		sb.axis_stretch_horizontal = StyleBoxTexture.AXIS_STRETCH_MODE_STRETCH
		sb.axis_stretch_vertical = StyleBoxTexture.AXIS_STRETCH_MODE_STRETCH
		out[state] = sb
	return out


static func button_texture(kind: String, state: String) -> Texture2D:
	var key := kind + "|" + state
	if _btn_tex.has(key):
		return _btn_tex[key]
	var base := PARCHMENT
	var edge := WOOD_DARK
	var seed := 911
	match kind:
		"primary":
			base = MOSS
			edge = MOSS_DARK
			seed = 1301
		"danger":
			base = DANGER
			edge = Color("#6d2418")
			seed = 1709
		"ghost":
			base = Color("#24352c")
			edge = GOLD_DARK
			seed = 2003
		_:
			base = PARCHMENT
			edge = WOOD_DARK
	if state == "hover":
		base = base.lightened(0.10)
	elif state == "pressed":
		base = base.darkened(0.16)
	elif state == "disabled":
		base = Color("#8d8170")
		edge = Color("#5f5548")
	var img := Image.create_empty(96, 64, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var w := 96
	var h := 64
	var r := 15.0
	for y in range(h):
		for x in range(w):
			var d := _round_dist(x, y, w, h, r)
			var a := clampf(0.5 - d, 0.0, 1.0)
			if a <= 0.0:
				continue
			var t := float(y) / float(h - 1)
			var c := base.lightened(0.055 * (1.0 - t)).darkened(0.055 * t)
			if kind == "ghost":
				c = base.lightened(0.02 * _noise01(x, y, seed))
			else:
				c = c.lightened((_noise01(x, y, seed) - 0.5) * 0.035)
				# древесные волокна
				var grain := sin(float(y) * 0.85 + float(x) * 0.07 + _noise01(x, y, seed + 7) * 2.0)
				c = c.lightened(grain * 0.012)
			if d > -4.0:
				c = edge
			elif d > -7.0:
				c = c.lightened(0.10 if state != "pressed" else 0.04)
			if state == "pressed":
				if y < 6:
					c = c.darkened(0.10)
				elif y > h - 7:
					c = c.lightened(0.05)
			else:
				if y < 5:
					c = c.lightened(0.11)
				elif y > h - 6:
					c = c.darkened(0.10)
			if x < 5:
				c = c.lightened(0.04)
			elif x > w - 6:
				c = c.darkened(0.05)
			img.set_pixel(x, y, Color(c.r, c.g, c.b, a))
	var tex := ImageTexture.create_from_image(img)
	_btn_tex[key] = tex
	return tex


static func panel_texture(dark := false) -> Texture2D:
	var key := "dark" if dark else "light"
	if _box_tex.has(key):
		return _box_tex[key]
	var w := 128
	var h := 128
	var img := Image.create_empty(w, h, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var base := WOOD_LITE if not dark else Color("#1d2a24")
	var edge := WOOD_DARK if not dark else Color("#0d1512")
	for y in range(h):
		for x in range(w):
			var d := _round_dist(x, y, w, h, 22.0)
			var a := clampf(0.5 - d, 0.0, 1.0)
			if a <= 0.0:
				continue
			var c := base
			if dark:
				c = c.lightened((_noise01(x, y, 3301) - 0.5) * 0.045)
				c = c.lightened(sin(float(x) * 0.11 + float(y) * 0.05) * 0.012)
			else:
				c = c.lightened((_noise01(x, y, 771) - 0.5) * 0.06)
				# Мягкие волокна без жёстких швов: nine-patch растягивает
				# центр, и шов на x=64 превращался в полосу через всю панель.
				c = c.lightened(sin(float(y) * 0.28
					+ _noise01(x, y, 771) * 1.3) * 0.018)
			# фаска и контур
			if d > -6.0:
				c = edge
			elif d > -9.0:
				c = c.lightened(0.08 if not dark else 0.04)
			if not dark:
				# гвоздики в углах — их не растягивает nine-patch
				for nail in [Vector2(20, 20), Vector2(w - 20, 20),
						Vector2(20, h - 20), Vector2(w - 20, h - 20)]:
					var dd := Vector2(x, y).distance_to(nail)
					if dd < 4.6:
						c = Color("#8a6b3c") if dd > 2.6 else Color("#f1d79a")
			img.set_pixel(x, y, Color(c.r, c.g, c.b, a))
	var tex := ImageTexture.create_from_image(img)
	_box_tex[key] = tex
	return tex


static func panel_style(dark := false) -> StyleBoxTexture:
	var sb := StyleBoxTexture.new()
	sb.texture = panel_texture(dark)
	sb.texture_margin_left = 32
	sb.texture_margin_right = 32
	sb.texture_margin_top = 32
	sb.texture_margin_bottom = 32
	sb.content_margin_left = 16
	sb.content_margin_right = 16
	sb.content_margin_top = 12
	sb.content_margin_bottom = 12
	sb.axis_stretch_horizontal = StyleBoxTexture.AXIS_STRETCH_MODE_STRETCH
	sb.axis_stretch_vertical = StyleBoxTexture.AXIS_STRETCH_MODE_STRETCH
	return sb


static func _round_dist(x: int, y: int, w: int, h: int, r: float) -> float:
	var hx := float(w) * 0.5
	var hy := float(h) * 0.5
	var dx := maxf(absf(float(x) + 0.5 - hx) - (hx - r), 0.0)
	var dy := maxf(absf(float(y) + 0.5 - hy) - (hy - r), 0.0)
	return sqrt(dx * dx + dy * dy) - r


static func _noise01(x: int, y: int, seed: int) -> float:
	var h := (x * 374761393 + y * 668265263 + seed * 1442695041) & 0x7FFFFFFF
	h = (h ^ (h >> 13)) * 1274126177
	return float((h ^ (h >> 16)) & 0xFFFF) / 65535.0


## Тёплое свечение за заголовком: одна текстура, без шейдеров в кадре.
static func glow_texture() -> Texture2D:
	if _glow_tex != null:
		return _glow_tex
	var n := 256
	var img := Image.create_empty(n, n, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	for y in range(n):
		for x in range(n):
			var dx := (float(x) - n * 0.5) / (n * 0.5)
			var dy := (float(y) - n * 0.5) / (n * 0.5)
			var d := sqrt(dx * dx + dy * dy)
			var a := clampf(1.0 - d, 0.0, 1.0)
			a = a * a * 0.55
			if a > 0.0:
				img.set_pixel(x, y, Color(1.0, 0.82, 0.45, a))
	_glow_tex = ImageTexture.create_from_image(img)
	return _glow_tex


static func vignette_texture() -> Texture2D:
	if _vignette_tex != null:
		return _vignette_tex
	var n := 256
	var img := Image.create_empty(n, n, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	for y in range(n):
		for x in range(n):
			var dx := (float(x) - n * 0.5) / (n * 0.5)
			var dy := (float(y) - n * 0.5) / (n * 0.5)
			var d := sqrt(dx * dx + dy * dy)
			var a := clampf((d - 0.35) / 0.65, 0.0, 1.0) * 0.55
			if a > 0.0:
				img.set_pixel(x, y, Color(0.02, 0.07, 0.10, a))
	_vignette_tex = ImageTexture.create_from_image(img)
	return _vignette_tex

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

static func button(text: String, size: int = 15, kind := "secondary") -> Button:
	var b := Button.new()
	b.text = text
	b.add_theme_font_size_override("font_size", size)
	b.focus_mode = Control.FOCUS_ALL
	b.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	if kind != "secondary":
		var set := button_set(kind)
		for key in set:
			b.add_theme_stylebox_override(str(key), set[key])
		if kind == "primary" or kind == "danger":
			b.add_theme_color_override("font_color", CREAM)
			b.add_theme_color_override("font_hover_color", CREAM)
			b.add_theme_color_override("font_pressed_color", CREAM)
			b.add_theme_color_override("font_disabled_color", Color(0.88, 0.84, 0.76, 0.55))
		elif kind == "ghost":
			b.add_theme_color_override("font_color", PARCHMENT)
			b.add_theme_color_override("font_hover_color", Color("#fff4cf"))
			b.add_theme_color_override("font_pressed_color", GOLD)
	_wire_hover(b)
	return b


## Мягкая реакция на наведение: только яркость, без сдвига коробки. Сдвиг
## коробки уводил бы область нажатия из-под курсора (правило 2026-10-19).
static func _wire_hover(b: Button) -> void:
	b.mouse_entered.connect(func() -> void:
		if b.disabled:
			return
		var tw := b.create_tween()
		tw.tween_property(b, "modulate", Color(1.07, 1.05, 1.0, 1.0), 0.11) \
			.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT))
	b.mouse_exited.connect(func() -> void:
		var tw := b.create_tween()
		tw.tween_property(b, "modulate", Color(1, 1, 1, 1), 0.14) \
			.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT))


## Панель-доска: процедурная текстура с фаской и гвоздиками, а не плоский
## прямоугольник. `pad` — внутренние поля содержимого.
static func panel(pad: int = 14, color: Color = WOOD_LITE) -> PanelContainer:
	var p := PanelContainer.new()
	var sb := panel_style(color == PANEL_DARK or color == Color(0.05, 0.08, 0.10, 0.84))
	sb.content_margin_left = pad
	sb.content_margin_right = pad
	sb.content_margin_top = int(pad * 0.7)
	sb.content_margin_bottom = int(pad * 0.7)
	p.add_theme_stylebox_override("panel", sb)
	return p


## Появление панели: лёгкий «вдох» с возвратом. Одна анимация на открытие, в
## кадре ничего не тикает.
static func pop_in(c: Control, dur := 0.22) -> void:
	if c == null:
		return
	c.pivot_offset = c.size * 0.5
	c.scale = Vector2(0.94, 0.94)
	c.modulate.a = 0.0
	var tw := c.create_tween()
	tw.set_parallel(true)
	tw.tween_property(c, "scale", Vector2.ONE, dur) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(c, "modulate:a", 1.0, dur * 0.8) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)


## Мягкое постоянное дыхание для точки «в сети»/ожидания. Амплитуда мала,
## чтобы не рябило.
static func pulse(c: CanvasItem, period := 1.6) -> void:
	if c == null:
		return
	var tw := c.create_tween().set_loops()
	tw.tween_property(c, "modulate:a", 0.45, period * 0.5) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_property(c, "modulate:a", 1.0, period * 0.5) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)

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
