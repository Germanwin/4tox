# -*- coding: utf-8 -*-
"""build_live.py — сборка кузницы в УЖЕ ЗАПУЩЕННОМ Blender (сокет MCP 9876).

Геометрия живёт в building.py (чистый Python), здесь только исполнение:
меш, материалы палитры, канонная камера и свет, кадры 96 ppu.

ПРАВИЛА ЖИВОЙ СЕССИИ (скилл 4tox-lowpoly-3d, references/blender-mcp.md):
  * НИКОГДА не звать `bpy.ops.wm.read_factory_settings` — это сносит файл
    заказчика вместе со всеми его сценами. Признак фона — только
    `bpy.app.background`, а не `bpy.context.window is None`;
  * работаем в СВОЕЙ сцене `ab_plain` и чистим только объекты со СВОИМ
    префиксом `abp_`; чужие сцены (`forge_barn` и прочие) не трогаем;
  * файл заказчика не сохраняем: ни `save_mainfile`, ни `save_as_mainfile`
    без `copy=True` здесь нет вообще.

Запуск (из корня проекта):
    python3 tools/blmcp.py run tools/build_live.py
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)


def _load(name, filename):
    """Загрузить свой модуль ПОД УНИКАЛЬНЫМ именем.

    Blender — долгоживущий процесс, и в нём уже живут модули соседних проектов
    (`building` есть и у другой постройки): обычный `import building` вернул бы
    ЧУЖОЙ модуль, и сборка молча пошла бы не тем кодом. Поэтому и имя своё, и
    кэш не трогаем — просто читаем файл заново на каждый запуск.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


B = _load('abp_building', 'building.py')
T = _load('abp_tone', 'tone.py')

SCENE = 'ab_plain'
PREFIX = 'abp_'
OBJ = PREFIX + 'smithy'

# канонная сцена (townhall/tools/thpipe.py): истинная изометрия, 96 ppu
AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
RES_X, RES_Y = 512, 640
PPU = 96.0
ORTHO = RES_Y / PPU
SUN_DIR = Vector(T.SUN).normalized()
SUN_ENERGY = 2.05
AMBIENT_COLOR = (0.62, 0.66, 0.72)
AMBIENT_STRENGTH = 0.42


def cfg():
    path = os.path.join(HERE, 'live_config.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return {}


def use_scene():
    """Своя сцена; чужие не трогаем. read_factory_settings не зовём НИКОГДА."""
    assert not bpy.app.background, (
        'этот скрипт для ЖИВОЙ сессии: в фоне он бы снёс файл пользователя')
    sc = bpy.data.scenes.get(SCENE)
    if sc is None:
        sc = bpy.data.scenes.new(SCENE)
    win = getattr(bpy.context, 'window', None)
    if win is not None:
        win.scene = sc
    return sc


def clear_own(sc):
    """Убрать из своей сцены только свои объекты и свои материалы."""
    for ob in list(sc.objects):
        if ob.name.startswith(PREFIX):
            bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.worlds):
        for item in list(coll):
            if item.users == 0 and item.name.startswith(PREFIX):
                coll.remove(item)


def make_material(name, hex_lin, rough, spec=0.02):
    r, g, b = [((hex_lin >> s) & 255) / 255.0 for s in (16, 8, 0)]
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.0
    for key in ('Specular IOR Level', 'Specular'):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = spec
            break
    mat.diffuse_color = (r, g, b, 1.0)
    return mat


def make_mesh(parts, name=OBJ):
    """Один меш из деталей; семейство каждого фасета помним по индексу."""
    verts, faces, fam_of_face = [], [], []
    for p in parts:
        off = len(verts)
        verts.extend([tuple(v) for v in p['verts']])
        for f in p['faces']:
            faces.append(tuple(off + i for i in f))
            fam_of_face.append(p['family'])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = False                # плоские фасеты — канон стиля
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob, fam_of_face


def slots(ob):
    """21 слот = 7 семейств x 3 тона; порядок слотов помним."""
    out, order = [], []
    for fam in T.FAMILIES:
        for tone in range(3):
            name = '%s%s_%d' % (PREFIX, fam, tone)
            mat = make_material(name, T.base_hex(fam, tone),
                                rough=(0.92 if fam in ('stone', 'iron') else 0.86))
            ob.data.materials.append(mat)
            order.append((fam, tone))
            out.append(mat)
    return order


def assign_tones(ob, fam_of_face, order):
    """Тон фасета — по нормали В МИРОВЫХ координатах (поворот учтён)."""
    idx = {key: i for i, key in enumerate(order)}
    m = ob.matrix_world.to_3x3()
    for i, poly in enumerate(ob.data.polygons):
        n = (m @ poly.normal).normalized()
        t = T.tone_of(fam_of_face[i], (n.x, n.y, n.z))
        poly.material_index = idx[(fam_of_face[i], t)]


def setup_camera(sc):
    cd = bpy.data.cameras.new(PREFIX + 'cam')
    cd.type = 'ORTHO'
    cd.ortho_scale = ORTHO
    cam = bpy.data.objects.new(PREFIX + 'cam', cd)
    sc.collection.objects.link(cam)
    fwd = Vector((math.cos(EL) * math.cos(AZ), -math.cos(EL) * math.sin(AZ), -math.sin(EL)))
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(fwd).normalized()
    cam.location = Vector((0.0, 0.0, 0.0)) - fwd * 40.0
    cam.rotation_euler = Matrix(((right.x, up.x, -fwd.x),
                                 (right.y, up.y, -fwd.y),
                                 (right.z, up.z, -fwd.z))).to_euler('XYZ')
    sc.camera = cam
    return cam


def setup_light(sc):
    prop = -SUN_DIR
    right = prop.cross(Vector((0, 0, 1)))
    if right.length < 1e-6:
        right = Vector((1, 0, 0))
    right.normalize()
    up = right.cross(prop).normalized()
    ld = bpy.data.lights.new(PREFIX + 'sun', 'SUN')
    ld.energy = SUN_ENERGY
    ld.angle = math.radians(4.0)
    sun = bpy.data.objects.new(PREFIX + 'sun', ld)
    sun.rotation_euler = Matrix(((right.x, up.x, -prop.x),
                                 (right.y, up.y, -prop.y),
                                 (right.z, up.z, -prop.z))).to_euler('XYZ')
    sc.collection.objects.link(sun)
    w = bpy.data.worlds.new(PREFIX + 'world')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (*AMBIENT_COLOR, 1.0)
    bg.inputs['Strength'].default_value = AMBIENT_STRENGTH
    return sun


def setup_render(sc, samples=64):
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    sc.render.dither_intensity = 0.0          # иначе ±1 LSB шума рассыпает фасеты
    try:
        sc.eevee.taa_render_samples = samples
    except Exception:
        pass
    try:
        sc.eevee.use_raytracing = False       # GI размазывает плоский фасет
    except Exception:
        pass
    return sc


def viewport_camera():
    win = getattr(bpy.context, 'window', None)
    if win is None:
        return False
    ok = False
    for area in win.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        for space in area.spaces:
            if space.type == 'VIEW_3D':
                space.region_3d.view_perspective = 'CAMERA'
                space.shading.type = 'MATERIAL'
                ok = True
        area.tag_redraw()
    return ok


def qa_views(sc, ob, fam_of_face, order, outdir, target=(0.0, 0.0, 1.15),
             ortho=3.30, views=None):
    """Осевые виды для ОСМОТРА формы: фасад, тыл, торцы.

    Это не спрайты для игры (те — истинная изометрия 96 ppu): осевой вид нужен,
    чтобы проверить композицию фасада — центр ворот, место окна, каркас, навес.
    """
    views = views or {'front': (0.0, 1.0, 0.0), 'back': (0.0, -1.0, 0.0),
                      'left': (-1.0, 0.0, 0.0), 'right': (1.0, 0.0, 0.0)}
    cam = sc.camera
    old = cam.data.ortho_scale
    cam.data.ortho_scale = ortho
    T = Vector(target)
    made = []
    for name, d in views.items():
        fwd = -Vector(d).normalized()
        right = fwd.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(fwd).normalized()
        cam.location = T - fwd * 30.0
        cam.rotation_euler = Matrix(((right.x, up.x, -fwd.x),
                                     (right.y, up.y, -fwd.y),
                                     (right.z, up.z, -fwd.z))).to_euler('XYZ')
        bpy.context.view_layer.update()
        path = os.path.join(outdir, '%sqa_%s.png' % (PREFIX, name))
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        made.append(os.path.basename(path))
    cam.data.ortho_scale = old
    return made


def main():
    c = cfg()
    variants = c.get('variants', ['a'])
    rotations = c.get('rotations', [0])
    outdir = os.path.join(ROOT, c.get('out', 'renders'))
    os.makedirs(outdir, exist_ok=True)
    sc = use_scene()
    clear_own(sc)
    cam = setup_camera(sc)
    setup_light(sc)
    setup_render(sc, samples=c.get('samples', 64))
    report = []
    for key in variants:
        parts = B.build(key)
        ob, fam = make_mesh(parts, name='%ssmithy_%s' % (PREFIX, key))
        order = slots(ob)
        fam_of_face, order = fam, order
        for rot in rotations:
            ob.rotation_euler = (0.0, 0.0, math.radians(rot))
            bpy.context.view_layer.update()
            assign_tones(ob, fam, order)
            path = os.path.join(outdir, '%s%s_%d_raw.png' % (PREFIX, key, rot))
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            report.append('%s rot=%d tris=%d -> %s'
                          % (key, rot, B.stats(parts)['tris'], os.path.basename(path)))
        ob.rotation_euler = (0.0, 0.0, 0.0)
        ob.hide_render = (key != variants[-1])
        ob.hide_viewport = (key != variants[-1])
    # оставляем в сцене только последний вариант — его и видно во вьюпорте
    keep = '%ssmithy_%s' % (PREFIX, variants[-1])
    for o in list(sc.objects):
        if o.name.startswith(PREFIX + 'smithy') and o.name != keep:
            bpy.data.objects.remove(o, do_unlink=True)
    last = bpy.data.objects.get(keep)
    if last:
        last.hide_render = False
        last.hide_viewport = False
    # кадр @4x — тем же светом и камерой, но вчетверо крупнее по ppu:
    # гейт гоняет детализацию именно на нём (на 1x сглаживание кромок ест фасеты)
    if last is not None and c.get('big4x', True):
        ob = last
        ob.rotation_euler = (0.0, 0.0, 0.0)
        bpy.context.view_layer.update()
        assign_tones(ob, fam_of_face, order)
        sc.render.resolution_x, sc.render.resolution_y = RES_X * 4, RES_Y * 4
        path = os.path.join(outdir, '%s%s_0@4x_raw.png' % (PREFIX, variants[-1]))
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
        report.append('@4x %.0f ppu -> %s' % (PPU * 4, os.path.basename(path)))
    # отдельный КРУПНЫЙ кадр для осмотра формы (гейт гоняется на 96 ppu)
    qa_ppu = float(c.get('qa_ppu', 0) or 0)
    if qa_ppu:
        if last is not None:
            ob = last
            ob.rotation_euler = (0.0, 0.0, 0.0)
            bpy.context.view_layer.update()
            assign_tones(ob, fam_of_face, order)
            sc.camera.data.ortho_scale = RES_Y / qa_ppu
            path = os.path.join(outdir, '%s%s_zoom.png' % (PREFIX, variants[-1]))
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            sc.camera.data.ortho_scale = ORTHO
            report.append('zoom %.0f ppu -> %s' % (qa_ppu, os.path.basename(path)))
    viewport_camera()
    # осевые виды для осмотра формы (не спрайты для игры)
    if last is not None and c.get('qa_views', True):
        assign_tones(last, fam_of_face, order)
        made = qa_views(sc, last, fam_of_face, order, outdir)
        report.append('qa-виды: %s' % ', '.join(made))
    # выгрузка меша в obj — доказательство, что геометрия настоящая
    try:
        if last is not None:
            bpy.ops.object.select_all(action='DESELECT')
            last.select_set(True)
            bpy.context.view_layer.objects.active = last
        exp = os.path.join(ROOT, 'out', 'smithy_%s.obj' % variants[-1])
        bpy.ops.wm.obj_export(filepath=exp, export_selected_objects=True,
                              export_materials=True)
        report.append('obj -> %s' % exp)
    except Exception as exc:                                   # noqa: BLE001
        report.append('obj не вышел: %r' % (exc,))
    print('\n'.join(report))
    print('сцена %r, объектов с префиксом %s: %d'
          % (sc.name, PREFIX, len([o for o in sc.objects if o.name.startswith(PREFIX)])))


main()
