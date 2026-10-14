"""Сборка дома в живом Blender: меши, материалы, камера, свет, рендер.

Запуск внутри Blender через MCP:
    python3 tools/live.py run tools/build_house.py

Работает в отдельной коллекции COC_House и со своим префиксом имён coc_house_,
чужие объекты не трогает; файл заказчика не сохраняет (только копией).
"""
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
for mod in ('coc_house_geom', 'palette'):
    sys.modules.pop(mod, None)

import coc_house_geom as G     # noqa: E402
import palette as P            # noqa: E402

PREFIX = 'coc_house_'
COLL = 'COC_House'
# двор и земля: в кадр входят, но кадр по ним не считаем
YARD = {'coc_house_grass', 'coc_house_leaf', 'coc_house_leaf_lit'}
RENDER = os.path.abspath(os.path.join(HERE, '..', 'renders', 'house_iso.png'))
BLEND_COPY = os.path.abspath(os.path.join(HERE, '..', 'coc_house.blend'))


def save_copy(path):
    """Сохранить .blend КОПИЕЙ: файл заказчика остаётся нетронутым."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=False,
                                check_existing=False)
    return path


# ---------------------------------------------------------------- очистка
def purge():
    """Удалить ТОЛЬКО свои объекты, коллекцию и материалы (по префиксу)."""
    for ob in list(bpy.data.objects):
        if ob.name.startswith(PREFIX):
            bpy.data.objects.remove(ob, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name == COLL:
            bpy.data.collections.remove(coll)
    for grp in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for item in list(grp):
            if item.name.startswith(PREFIX) or item.name.startswith(COLL):
                if getattr(item, 'users', 0) == 0:
                    grp.remove(item)


# ---------------------------------------------------------------- материалы
def make_material(name, base, jitter=0.0, metallic=0.0, rough=0.88,
                  emit=None, emit_strength=0.0, gradient=None, use_vcol=False):
    mat = bpy.data.materials.new(PREFIX + name)
    mat.use_nodes = True
    mat.diffuse_color = tuple(base) + (1.0,)          # цвет вьюпорта
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = tuple(base) + (1.0,)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic
    for key, val in (('Specular IOR Level', 0.25), ('IOR', 1.45)):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = val
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = tuple(emit) + (1.0,)
        bsdf.inputs['Emission Strength'].default_value = emit_strength

    src = bsdf
    if jitter > 0.0 or gradient is not None or use_vcol:
        rgb = nt.nodes.new('ShaderNodeRGB')
        rgb.location = (-620, 240)
        rgb.outputs[0].default_value = tuple(base) + (1.0,)
        mix = nt.nodes.new('ShaderNodeMixRGB')
        mix.location = (-380, 240)
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Fac'].default_value = 1.0
        mix.inputs['Color1'].default_value = tuple(base) + (1.0,)
        mix.inputs['Color2'].default_value = (1.0, 1.0, 1.0, 1.0)
        nt.links.new(rgb.outputs[0], mix.inputs['Color1'])
        if jitter > 0.0 or use_vcol:
            attr = nt.nodes.new('ShaderNodeAttribute')
            attr.location = (-620, -20)
            attr.attribute_name = 'stone_var'
            ramp = nt.nodes.new('ShaderNodeValToRGB')
            ramp.location = (-470, -20)
            ramp.color_ramp.elements[0].position = 0.0
            ramp.color_ramp.elements[0].color = (1.0 - jitter, 1.0 - jitter, 1.0 - jitter, 1.0)
            ramp.color_ramp.elements[1].position = 1.0
            ramp.color_ramp.elements[1].color = (1.0 + jitter, 1.0 + jitter, 1.0 + jitter, 1.0)
            nt.links.new(attr.outputs['Color'], ramp.inputs['Fac'])
            nt.links.new(ramp.outputs['Color'], mix.inputs['Color2'])
        src = mix
    if gradient is not None:
        inner, outer = gradient
        coord = nt.nodes.new('ShaderNodeTexCoord')
        coord.location = (-900, -240)
        grad = nt.nodes.new('ShaderNodeTexGradient')
        grad.gradient_type = 'SPHERICAL'
        grad.location = (-700, -240)
        ramp2 = nt.nodes.new('ShaderNodeValToRGB')
        ramp2.location = (-520, -240)
        ramp2.color_ramp.elements[0].position = 0.34
        ramp2.color_ramp.elements[0].color = tuple(inner) + (1.0,)
        ramp2.color_ramp.elements[1].position = 0.78
        ramp2.color_ramp.elements[1].color = tuple(outer) + (1.0,)
        mul = nt.nodes.new('ShaderNodeMixRGB')
        mul.blend_type = 'MULTIPLY'
        mul.location = (-200, 60)
        mul.inputs['Fac'].default_value = 1.0
        nt.links.new(coord.outputs['Object'], grad.inputs['Vector'])
        nt.links.new(grad.outputs['Color'], ramp2.inputs['Fac'])
        nt.links.new(src.outputs[0], mul.inputs['Color1'])
        nt.links.new(ramp2.outputs['Color'], mul.inputs['Color2'])
        src = mul
    nt.links.new(src.outputs[0], bsdf.inputs['Base Color'])
    return mat


def build_materials():
    mats = {}
    for name, spec in P.PALETTE.items():
        mats[name] = make_material(name, P.srgb_to_linear(spec['hex']),
                                   jitter=spec.get('jitter', 0.0),
                                   metallic=spec.get('metallic', 0.0),
                                   rough=spec.get('rough', 0.88),
                                   emit=(P.srgb_to_linear(spec['emit']) if spec.get('emit') else None),
                                   emit_strength=spec.get('emit_strength', 0.0),
                                   gradient=(tuple(P.srgb_to_linear(c) for c in spec['gradient'])
                                             if spec.get('gradient') else None),
                                   use_vcol=spec.get('use_vcol', False))
    return mats


# ---------------------------------------------------------------- меши
def build_meshes(parts, coll, mats):
    buckets = {}
    for name, material, verts, faces in parts:
        buckets.setdefault(material, []).append((name, verts, faces))
    made = []
    for material, group in buckets.items():
        verts, faces, shades = [], [], []
        for name, pv, pf in group:
            off = len(verts)
            verts.extend(pv)
            for f in pf:
                faces.append(tuple(i + off for i in f))
            shades.append(P.block_var(name))
            shades.extend([shades[-1]] * len(pf))
        me = bpy.data.meshes.new('%s%s_mesh' % (PREFIX, material))
        me.from_pydata(verts, [], faces)
        me.validate(verbose=False)
        me.update()
        attr = me.color_attributes.new(name='stone_var', type='FLOAT_COLOR', domain='CORNER')
        for poly in me.polygons:
            poly.use_smooth = False
            v = shades[poly.index] if poly.index < len(shades) else 0.5
            for li in poly.loop_indices:
                attr.data[li].color = (v, v, v, 1.0)
        ob = bpy.data.objects.new('%s%s' % (PREFIX, material), me)
        ob.data.materials.append(mats[material])
        coll.objects.link(ob)
        made.append(ob)
    return made


# ---------------------------------------------------------------- камера и свет
def look_at(obj, target):
    from mathutils import Vector
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def setup_camera(coll, center, ortho=8.2, az_deg=45.0, name='camera', dist=14.0):
    az, el = math.radians(az_deg), math.radians(35.2644)
    loc = (dist * math.cos(el) * math.sin(az),
           -dist * math.cos(el) * math.cos(az),
           center[2] + dist * math.sin(el))
    cam = bpy.data.cameras.new(PREFIX + name)
    cam.type = 'ORTHO'
    cam.ortho_scale = ortho
    cam.clip_start, cam.clip_end = 1.0, 60.0
    ob = bpy.data.objects.new('%s%s' % (PREFIX, name), cam)
    ob.location = loc
    coll.objects.link(ob)
    look_at(ob, center)
    return ob


def add_light(coll, name, kind, loc, energy, color, size=4.0, target=(0, 0, 2.3)):
    li = bpy.data.lights.new(PREFIX + name, type=kind)
    li.energy = energy
    li.color = color
    if kind == 'AREA':
        li.shape = 'SQUARE'
        li.size = size
    elif kind == 'SUN':
        li.angle = math.radians(3.0)
    ob = bpy.data.objects.new(PREFIX + name, li)
    ob.location = loc
    coll.objects.link(ob)
    look_at(ob, target)
    return ob


def setup_lights(coll):
    add_light(coll, 'key', 'AREA', (-5.5, -6.5, 8.6), 2700.0, (1.0, 0.94, 0.84), size=5.0)
    add_light(coll, 'fill', 'AREA', (7.0, -4.0, 3.6), 1050.0, (0.84, 0.89, 1.0), size=7.0)
    add_light(coll, 'rim', 'AREA', (1.6, 8.5, 6.4), 2600.0, (0.92, 0.95, 1.0), size=5.0)
    add_light(coll, 'sky', 'SUN', (0.0, 0.0, 12.0), 1.30, (0.88, 0.91, 1.0))


# ---------------------------------------------------------------- сцена
def setup_render(scene, res=1100, samples=220):
    sc = scene
    sc.render.engine = 'CYCLES'
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.filepath = RENDER
    cy = sc.cycles
    cy.samples = samples
    cy.preview_samples = 24
    cy.use_denoising = True
    for key, val in (('denoiser', 'OPENIMAGEDENOISE'), ('max_bounces', 6),
                     ('diffuse_bounces', 3), ('glossy_bounces', 2),
                     ('transmission_bounces', 2), ('use_adaptive_sampling', True),
                     ('adaptive_threshold', 0.02), ('use_caustics_reflective', False),
                     ('use_caustics_refractive', False), ('device', 'CPU')):
        if hasattr(cy, key):
            try:
                setattr(cy, key, val)
            except Exception:
                pass
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for compute in ('METAL', 'OPTIX', 'CUDA'):
            try:
                prefs.compute_device_type = compute
                prefs.get_devices()
                gpu = [d for d in prefs.devices if d.type != 'CPU']
                if gpu:
                    for d in prefs.devices:
                        d.use = True
                    cy.device = 'GPU'
                    break
            except Exception:
                continue
    except Exception:
        pass
    for tf in ('Standard', 'Filmic', 'AgX'):
        try:
            sc.view_settings.view_transform = tf
            break
        except Exception:
            continue
    try:
        sc.view_settings.look = 'None'
    except Exception:
        pass
    sc.view_settings.exposure = 0.0


def house_bounds(objs, skip=None):
    """Габарит самого дома (без двора) — по нему кадрируем."""
    skip = skip or set()
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for ob in objs:
        if ob.type != 'MESH' or ob.name in skip:
            continue
        for v in ob.data.vertices:
            w = ob.matrix_world @ v.co
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def fit_ortho(lo, hi, center, margin=1.07):
    """Ортомасштаб под кадр: проекция габарита дома на оси камеры."""
    az, el = math.radians(45.0), math.radians(35.2644)
    right = (math.cos(az), math.sin(az), 0.0)
    up = (-math.sin(el) * math.sin(az), math.sin(el) * math.cos(az), math.cos(el))
    hw = hh = 0.0
    for x in (lo[0], hi[0]):
        for y in (lo[1], hi[1]):
            for z in (lo[2], hi[2]):
                dx, dy, dz = x - center[0], y - center[1], z - center[2]
                hw = max(hw, abs(dx * right[0] + dy * right[1] + dz * right[2]))
                hh = max(hh, abs(dx * up[0] + dy * up[1] + dz * up[2]))
    return 2.0 * max(hw, hh) * margin


def hide_defaults():
    """Убрать дефолтные объекты из кадра, НЕ удаляя их из сцены заказчика."""
    hidden = []
    for name in ('Cube', 'Light', 'Camera'):
        ob = bpy.data.objects.get(name)
        if ob is not None and not ob.name.startswith(PREFIX):
            ob.hide_render = True
            ob.hide_viewport = True
            hidden.append(name)
    return hidden


def main():
    if not bpy.app.background:
        print('[coc_house] живая сессия Blender %s' % bpy.app.version_string)
    purge()
    print('[coc_house] скрыто из кадра: %s' % (hide_defaults(),))
    parts = G.build()
    mats = build_materials()
    coll = bpy.data.collections.new(COLL)
    bpy.context.scene.collection.children.link(coll)
    objs = build_meshes(parts, coll, mats)
    tris = sum(len(p.vertices) - 2 for ob in objs for p in ob.data.polygons)
    lo, hi = house_bounds(objs, skip=YARD)
    center = ((lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5)
    setup_lights(coll)
    ortho = fit_ortho(lo, hi, center)
    cam = setup_camera(coll, center, ortho=ortho)
    cam_back = setup_camera(coll, center, ortho=ortho, az_deg=225.0, name='camera_back')
    scene = bpy.context.scene
    scene.camera = cam
    setup_render(scene)
    print('[coc_house] объектов: %d, треугольников: %d' % (len(objs), tris))
    print('[coc_house] габарит дома X %.2f  Y %.2f  Z %.2f' %
          (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
    print('[coc_house] центр кадра: %.2f %.2f %.2f, орто %.2f' % (center + (cam.data.ortho_scale,)))
    save_copy(BLEND_COPY)
    print('[coc_house] копия .blend: %s' % BLEND_COPY)
    return objs


if __name__ == '__main__':
    main()
