class_name ToxModelGallery
extends Control

signal closed

const MODELS := [
	{"name": "Ратуша A", "path": "res://models/townhall_townhall_a.glb", "note": "4 × 3 клетки · вариант A"},
	{"name": "Ратуша B", "path": "res://models/townhall_townhall_b.glb", "note": "4 × 3 клетки · вариант B"},
	{"name": "Ратуша C", "path": "res://models/townhall_townhall_c.glb", "note": "4 × 3 клетки · вариант C"},
	{"name": "Дом жителя", "path": "res://models/starter_house_starter_house.glb", "note": "стартовый дом · 2 × 3 клетки"},
	{"name": "Стартовый дом (модель)", "path": "res://models/starter_house_starter_house_model.glb", "note": "исходная модель дома"},
	{"name": "Дом жителя (прежний)", "path": "res://models/villager_house_house_a.glb", "note": "прежняя модель · атлас house"},
	{"name": "Хижина A", "path": "res://models/townhall_hutrect_a.glb", "note": "запасная хижина · вариант A"},
	{"name": "Хижина B", "path": "res://models/townhall_hutrect_b.glb", "note": "запасная хижина · вариант B"},
	{"name": "Хижина C", "path": "res://models/townhall_hutrect_c.glb", "note": "запасная хижина · вариант C"},
	{"name": "Лагерь лесоруба", "path": "res://models/lumbercamp_lc_model.glb", "note": "3 × 3 клетки · рабочий двор"},
	{"name": "Казарма", "path": "res://models/barracks_br_model.glb", "note": "4 × 3 клетки · открытый плац"},
	{"name": "Военный лагерь", "path": "res://models/warcamp_wc_model.glb", "note": "площадка 5 × 5 · модель 2 × 2"},
	{"name": "Житель", "path": "res://models/villager_villager.glb", "note": "низкополигональный персонаж"},
	{"name": "Воин", "path": "res://models/armored_villager_armored_villager.glb", "note": "броня, шлем, меч"},
	{"name": "Топор A", "path": "res://models/axe_axe_a.glb", "note": "инструмент лесоруба"},
	{"name": "Топор B", "path": "res://models/axe_axe_b.glb", "note": "инструмент лесоруба"},
	{"name": "Топор C", "path": "res://models/axe_axe_c.glb", "note": "инструмент лесоруба"},
	{"name": "Лопата A", "path": "res://models/shovel_shovel_a.glb", "note": "инструмент"},
	{"name": "Лопата B", "path": "res://models/shovel_shovel_b.glb", "note": "инструмент"},
	{"name": "Лопата C", "path": "res://models/shovel_shovel_c.glb", "note": "инструмент"},
	{"name": "Волна 0", "path": "res://models/waves_wave_0.glb", "note": "гребень моря"},
	{"name": "Волна 1", "path": "res://models/waves_wave_1.glb", "note": "гребень моря"},
	{"name": "Волна 2", "path": "res://models/waves_wave_2.glb", "note": "гребень моря"},
	{"name": "Волна 3", "path": "res://models/waves_wave_3.glb", "note": "гребень моря"},
	{"name": "Волна 4", "path": "res://models/waves_wave_4.glb", "note": "гребень моря"},
]

var _viewport: SubViewport
var _pivot: Node3D
var _camera: Camera3D
var _title: Label
var _note: Label
var _list: VBoxContainer
var _index := 0
var _spin := true

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	theme = ToxUI.theme()
	var bg := ColorRect.new()
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	bg.color = Color(0.02, 0.07, 0.12, 0.96)
	add_child(bg)
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 26)
	margin.add_theme_constant_override("margin_right", 26)
	margin.add_theme_constant_override("margin_top", 20)
	margin.add_theme_constant_override("margin_bottom", 20)
	add_child(margin)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 16)
	margin.add_child(row)
	var left := ToxUI.panel(12)
	left.custom_minimum_size = Vector2(330, 0)
	row.add_child(left)
	var lv := VBoxContainer.new()
	lv.add_theme_constant_override("separation", 6)
	left.add_child(lv)
	var title := ToxUI.ink_label("Модели 4tox", 24)
	lv.add_child(title)
	var sub := ToxUI.ink_label("исходные GLB из art/ · перенесены в Godot", 11)
	sub.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	lv.add_child(sub)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	lv.add_child(scroll)
	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list.add_theme_constant_override("separation", 3)
	scroll.add_child(_list)
	for i in range(MODELS.size()):
		var b := ToxUI.button(MODELS[i].name, 12)
		b.alignment = HORIZONTAL_ALIGNMENT_LEFT
		b.custom_minimum_size = Vector2(0, 32)
		b.pressed.connect(func() -> void: _select(i))
		_list.add_child(b)
	var close := ToxUI.button("← Назад", 14)
	close.custom_minimum_size = Vector2(0, 40)
	close.pressed.connect(func() -> void: emit_signal("closed"))
	lv.add_child(close)

	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.add_theme_constant_override("separation", 8)
	row.add_child(right)
	var head := HBoxContainer.new()
	right.add_child(head)
	_title = ToxUI.ink_label("", 22)
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(_title)
	var spin := ToxUI.button("Вращение", 12)
	spin.toggle_mode = true
	spin.button_pressed = true
	spin.pressed.connect(func() -> void: _spin = spin.button_pressed)
	head.add_child(spin)
	_note = ToxUI.ink_label("", 12)
	_note.add_theme_color_override("font_color", ToxUI.INK_SOFT)
	right.add_child(_note)
	var vp_container := SubViewportContainer.new()
	vp_container.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	vp_container.size_flags_vertical = Control.SIZE_EXPAND_FILL
	vp_container.stretch = true
	vp_container.custom_minimum_size = Vector2(600, 500)
	right.add_child(vp_container)
	_viewport = SubViewport.new()
	_viewport.size = Vector2i(900, 700)
	_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	_viewport.msaa_3d = Viewport.MSAA_4X
	vp_container.add_child(_viewport)
	_build_3d()
	_select(0)

func _build_3d() -> void:
	var world := Node3D.new()
	_viewport.add_child(world)
	var env := WorldEnvironment.new()
	var e := Environment.new()
	e.background_mode = Environment.BG_COLOR
	e.background_color = Color(0.07, 0.2, 0.3)
	e.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	e.ambient_light_color = Color(0.9, 0.95, 1.0)
	e.ambient_light_energy = 0.18
	e.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	e.tonemap_exposure = 0.65
	env.environment = e
	world.add_child(env)
	var light := DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-52, -38, 0)
	light.light_energy = 0.55
	light.shadow_enabled = true
	world.add_child(light)
	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(-30, 145, 0)
	fill.light_energy = 0.12
	world.add_child(fill)
	_camera = Camera3D.new()
	_camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	_camera.size = 4.6
	_camera.position = Vector3(4.2, 3.2, 4.2)
	_camera.look_at_from_position(Vector3(4.2, 3.2, 4.2), Vector3.ZERO, Vector3.UP)
	world.add_child(_camera)
	var plane := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(14, 14)
	plane.mesh = pm
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.12, 0.22, 0.18)
	mat.roughness = 1.0
	plane.material_override = mat
	plane.position.y = -0.02
	world.add_child(plane)
	_pivot = Node3D.new()
	world.add_child(_pivot)

func _select(index: int) -> void:
	if index < 0 or index >= MODELS.size():
		return
	_index = index
	_title.text = MODELS[index].name
	_note.text = MODELS[index].note
	for c in _pivot.get_children():
		c.queue_free()
	var ps := load(MODELS[index].path) as PackedScene
	if ps == null:
		return
	var model := ps.instantiate()
	_pivot.add_child(model)
	var aabb := _model_aabb(model)
	var ext := maxf(aabb.size.x, maxf(aabb.size.y, aabb.size.z))
	var scale := 2.6 / maxf(0.001, ext)
	model.scale = Vector3.ONE * scale
	var center := aabb.get_center() * scale
	model.position = -center + Vector3(0, aabb.size.y * scale * 0.5, 0)
	_pivot.rotation = Vector3(0, deg_to_rad(-30), 0)

func _model_aabb(root: Node3D) -> AABB:
	var meshes := root.find_children("*", "MeshInstance3D", true, false)
	var box := AABB()
	var first := true
	for m in meshes:
		if m is MeshInstance3D and m.mesh != null:
			var a: AABB = m.get_aabb()
			if first:
				box = a
				first = false
			else:
				box = box.merge(a)
	if first:
		return AABB(Vector3(-1, 0, -1), Vector3(2, 2, 2))
	return box

func _process(dt: float) -> void:
	if visible and _spin and _pivot != null:
		_pivot.rotate_y(dt * 0.45)
