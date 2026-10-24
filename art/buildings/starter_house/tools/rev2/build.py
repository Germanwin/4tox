"""build.py — сборка стартового дома в Blender: меш, материалы, кадр.

Исполняется ВНУТРИ Blender (живая сессия через tools/blmcp.py или headless).
Геометрия приходит из `building.py` (чистый Python), здесь только:
    * склейка деталей в ОДИН меш `sh_house`;
    * ДВЕНАДЦАТЬ плоских материалов палитры РАТУШИ (tools/palette.py) —
      цвет один на всю деталь, никаких тонов по нормали;
    * канонный кадр 512 x 640, орто-масштаб 8.0 = 80 px на юнит.

Почему плоские материалы, а не семейства атласа с тонами по нормали: у ратуши
(эталон заказчика) именно так, и первая ревизия дома с тонами получила отзыв
«крыша другого цвета, он вообще другого стиля».
"""
import math
import os
import sys

import bpy
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
if os.path.join(os.path.dirname(ROOT), 'townhall', 'tools') not in sys.path:
    sys.path.append(os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import thpipe as P                                               # noqa: E402
import palette as PAL                                            # noqa: E402
import building as B                                             # noqa: E402

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

RES_X, RES_Y = 512, 640
PPU = 80.0
MAT_PREFIX = 'sh_'
OBJ_NAME = 'sh_house'

MATS = {}
_MATS_HEX = {}


def _abs(path):
    """Абсолютный путь от корня проекта: в живом Blender cwd = `/`."""
    return path if os.path.isabs(path) else os.path.join(ROOT, path)


def materials():
    """Двенадцать материалов палитры ратуши."""
    global MATS
    if MATS:
        alive = True
        try:
            alive = all(bpy.data.materials.get(MAT_PREFIX + n) is not None
                        for n in PAL.NAMES)
        except ReferenceError:
            alive = False
        if alive:
            return [bpy.data.materials[MAT_PREFIX + n] for n in PAL.NAMES]
    global _MATS_HEX
    MATS = {}
    _MATS_HEX = {}
    out = []
    for name in PAL.NAMES:
        hexv = PAL.HEX[name]
        mat = bpy.data.materials.get(MAT_PREFIX + name)
        # МАТЕРИАЛ ПЕРЕСОЗДАЁТСЯ, если базовый цвет изменился.  Blender живёт
        # между сборками, материал остаётся в файле, и без этой проверки
        # калибровка молча не влияла: рендер шёл старым цветом (наступили —
        # DARKEN 0.55/0.65/0.75 дали один и тот же кадр).
        if mat is not None and _MATS_HEX.get(name) != hexv:
            bpy.data.materials.remove(mat, do_unlink=True)
            mat = None
        if mat is None:
            mat = P.make_material(MAT_PREFIX + name, hexv,
                                  rough=PAL.ROUGH.get(name, 0.86), spec=0.02)
            _MATS_HEX[name] = hexv
        MATS[name] = mat
        out.append(mat)
    return out


def reset_materials():
    global MATS, _MATS_HEX
    MATS = {}
    _MATS_HEX = {}
_MATS_HEX = {}


def make_object(parts, name=OBJ_NAME):
    """Один меш из деталей; материал фасета — по имени палитры детали."""
    verts, faces, mat_of_face = [], [], []
    for p in parts:
        off = len(verts)
        verts.extend([tuple(v) for v in p['verts']])
        for f in p['faces']:
            faces.append(tuple(off + i for i in f))
            mat_of_face.append(p['family'])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    for mat in materials():
        ob.data.materials.append(mat)
    idx = {n: i for i, n in enumerate(PAL.NAMES)}
    for i, poly in enumerate(me.polygons):
        poly.material_index = idx.get(mat_of_face[i], 0)
        poly.use_smooth = False
    return ob


def rotate_meshes(deg, scene=None):
    R = Matrix.Rotation(math.radians(deg), 4, 'Z')
    for o in (scene or bpy.context.scene).objects:
        if o.type == 'MESH' and o.name.startswith(MAT_PREFIX):
            o.data.transform(R)
            o.data.update()


def tris_verts(objs):
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    verts = sum(len(o.data.vertices) for o in objs)
    return tris, verts


def world_size(objs):
    xs, ys, zs = [], [], []
    for o in objs:
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            xs.append(p.x)
            ys.append(p.y)
            zs.append(p.z)
    return (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))


def footprint(objs):
    xs, ys = [], []
    for o in objs:
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            xs.append(p.x)
            ys.append(p.y)
    return (round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3))


def build_variant(variant=None, scene=None):
    parts = B.build(variant)
    ob = make_object(parts, OBJ_NAME)
    return [ob], parts


def render_frame(variant, rot, samples, out_png, scene=None, ppu=None):
    import scene as SC
    out_png = _abs(out_png)
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    scene = scene or bpy.context.scene
    SC.clear_own(scene)
    P.RES_X, P.RES_Y = RES_X, RES_Y
    P.ORTHO = P.RES_Y / float(ppu or PPU)
    # Камера и свет — здесь: `clear_own` убирает и их (они наши, с префиксом).
    SC.setup(samples=samples, res=(RES_X, RES_Y))
    P.setup_render(samples=samples)
    objs, parts = build_variant(variant, scene)
    if rot:
        rotate_meshes(rot, scene)
    P.render_to(out_png)
    tris, verts = tris_verts(objs)
    return dict(tris=tris, verts=verts, objects=len(objs), parts=len(parts),
                size=round(world_size(objs)[2], 3),
                footprint=list(footprint(objs)))


def export_model(path_noext, scene=None):
    os.makedirs(os.path.dirname(path_noext), exist_ok=True)
    scene = scene or bpy.context.scene
    meshes = [o for o in scene.objects
              if o.type == 'MESH' and o.name.startswith(MAT_PREFIX)]
    if not meshes:
        raise RuntimeError('нечего выгружать: нет мешей %s*' % MAT_PREFIX)
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except Exception:
            pass
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    glb = path_noext + '.glb'
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB',
                              use_selection=True, use_active_scene=True,
                              export_yup=True, export_apply=True,
                              export_materials='EXPORT')
    print('EXPORTED %s' % glb)
    obj = path_noext + '.obj'
    bpy.ops.wm.obj_export(filepath=obj, export_selected_objects=True,
                          export_materials=True, export_uv=False,
                          export_normals=True, export_triangulated_mesh=True,
                          forward_axis='Y', up_axis='Z', apply_modifiers=True)
    print('EXPORTED %s' % obj)
    return glb
