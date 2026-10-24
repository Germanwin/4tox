"""build.py — сборка фигуры в Blender: меш, материалы, тона по нормалям, кадр.

Исполняется ВНУТРИ Blender (живая сессия через tools/blmcp.py или headless).
Геометрия приходит из `person.py` (чистый Python), поза — из `poses.py`, здесь
только:

    * склейка деталей в ОДИН меш `vg_woman`;
    * материалы по (семейство x тон) с базовыми цветами из калибровки;
    * раскладка фасетов по тонам ПО НОРМАЛИ — и обязательно ПОСЛЕ поворота
      (канон: «под поворотом модели свет не подкручивается»);
    * канонный кадр ortho = res_y / ppu, центр — на высоте target.

Базовые цвета материалов ТЕМНЕЕ целевых тонов спрайта: поднять тон должна сцена
(солнце 2.05 + небо 0.42), а не материал. Числа взяты из калибровки проекта
(villager_house/tools/pal_cal.json — та же сцена, те же солнце и небо), а не
подобраны на глаз: это и есть правило скилла «базовые цвета считает калибровка».
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
# Свет, рендер и материалы берутся у ратуши (art/buildings/townhall/tools/
# thpipe.py), а камера — своя (scene.py: канон игры, а не thpipe).
# Путь считается ОТ КОРНЯ РЕПОЗИТОРИЯ: до 2026-10-15 здесь стояло
# `dirname(ROOT)/townhall/tools`, то есть art/characters/townhall/tools —
# каталога нет. Ошибка не всплывала, пока живая сессия Blender была не
# первой: thpipe уже лежал в sys.modules от чужого проекта, и import
# молча брал кэш. Свежий Blender это вскрыл («No module named thpipe»).
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
sys.path.append(os.path.join(REPO, 'art', 'buildings', 'townhall', 'tools'))

import thpipe as P                                              # noqa: E402
import palette as PAL                                           # noqa: E402
import person as H                                              # noqa: E402
import poses as PO                                              # noqa: E402

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')
CAL_JSON = os.path.join(HERE, 'pal_cal.json')

RES_X, RES_Y = 144, 192
PPU = 96.0
TARGET_Z = 0.42          # высота, на которую смотрит камера (центр кадра)
MAT_PREFIX = 'vg_'
OBJ_NAME = 'vg_villager'
VARIANT = 'm'            # m — мужчина, f — женщина (см. person.SPEC_M)
LIFT = 1.0
AMBIENT_W = 0.15

P.SUN_DIR = Vector(PAL.SUN_DIR).normalized()   # см. palette.SUN_DIR: зеркало по X
SUN_FROM = Vector(P.SUN_DIR).normalized()        # направление НА солнце
VIEW_FROM = Vector((math.cos(P.EL) * math.cos(P.AZ),
                    math.cos(P.EL) * math.sin(P.AZ),
                    math.sin(P.EL))).normalized()

SLOTS = []                       # [(семейство, тон)] — порядок слотов материала
FACE_FAMILY = []                 # семейство каждого полигона собранного меша


# --------------------------------------------------------------------------
# ЦВЕТ
# --------------------------------------------------------------------------
def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _srgb(c):
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def _to_lin(hex_rgb):
    return [_lin(((hex_rgb >> s) & 255) / 255.0) for s in (16, 8, 0)]


def _lin_hex(lin_rgb):
    out = 0
    for c in lin_rgb:
        out = (out << 8) | int(round(max(0.0, min(1.0, c)) * 255))
    return out


_CAL = None


def calibration(reload=False):
    global _CAL
    if _CAL is None or reload:
        try:
            with open(CAL_JSON, encoding='utf-8') as f:
                _CAL = json.load(f)
        except Exception:
            _CAL = {}
    return _CAL


def base_hex(family, tone):
    """Базовый цвет материала (ЛИНЕЙНЫЙ hex): калибровка, иначе цель/LIFT."""
    cal = calibration()
    try:
        return int(str(cal[family][str(tone)]).lstrip('#'), 16)
    except Exception:
        target = PAL.hex_rgb(PAL.tones(family)[tone])
        return _lin_hex([c / LIFT for c in _to_lin(
            (target[0] << 16) | (target[1] << 8) | target[2])])


def _set_base(mat, hex_lin):
    r, g, b = [((hex_lin >> s) & 255) / 255.0 for s in (16, 8, 0)]
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    mat.diffuse_color = (r, g, b, 1.0)


def materials():
    """Материалы палитры: семейства x 3 тона. Кэш проверяет живость."""
    global SLOTS
    if SLOTS:
        alive = True
        try:
            alive = all(bpy.data.materials.get(MAT_PREFIX + '%s_%d' % (f, t))
                        is not None for f, t in SLOTS)
        except ReferenceError:
            alive = False
        if alive:
            for fam, tone in SLOTS:
                _set_base(bpy.data.materials[MAT_PREFIX + '%s_%d' % (fam, tone)],
                          base_hex(fam, tone))
            return [bpy.data.materials[MAT_PREFIX + '%s_%d' % (f, t)]
                    for f, t in SLOTS]
    SLOTS = []
    out = []
    for fam in PAL.FAMILIES:
        for tone in range(3):
            name = MAT_PREFIX + '%s_%d' % (fam, tone)
            mat = bpy.data.materials.get(name)
            if mat is None:
                mat = P.make_material(name, base_hex(fam, tone),
                                      rough=0.92 if fam in ('stone', 'iron')
                                      else 0.86, spec=0.02)
            else:
                _set_base(mat, base_hex(fam, tone))
            SLOTS.append((fam, tone))
            out.append(mat)
    return out


def reset_palette():
    global SLOTS
    SLOTS = []


# --------------------------------------------------------------------------
# МЕШ
# --------------------------------------------------------------------------
def make_object(parts, name=OBJ_NAME):
    """Один меш из списка деталей; полигоны остаются плоскими (use_smooth=False)."""
    global FACE_FAMILY
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
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    for mat in materials():
        ob.data.materials.append(mat)
    FACE_FAMILY = fam_of_face
    for poly in me.polygons:
        poly.use_smooth = False
    assign_tones(ob)
    return ob


def face_brightness(normal):
    """Ожидаемая яркость фасета: сколько солнца он ловит + доля неба."""
    return max(0.0, normal.dot(SUN_FROM)) + AMBIENT_W


def assign_tones(ob):
    """Разложить фасеты по трём тонам семейства — по нормали, ПОСЛЕ поворота."""
    if not SLOTS:
        materials()
    idx = {fam: [SLOTS.index((fam, t)) for t in range(3)] for fam in PAL.FAMILIES}
    th = {fam: PAL.thresholds(fam) for fam in PAL.FAMILIES}
    for i, poly in enumerate(ob.data.polygons):
        fam = FACE_FAMILY[i]
        light, mid = th[fam]
        b = face_brightness(poly.normal)
        tone = 0 if b >= light else (1 if b >= mid else 2)
        poly.material_index = idx[fam][tone]


def rotate_meshes(deg, scene=None):
    """Поворот модели вокруг Z прямо в данных меша (без bpy.ops)."""
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


def tone_census(ob):
    out = {}
    for poly in ob.data.polygons:
        fam, tone = SLOTS[poly.material_index]
        d = out.setdefault('%s_%d' % (fam, tone), [0, 0.0])
        d[0] += 1
        d[1] += poly.area
    return out


# --------------------------------------------------------------------------
# КАДР
# --------------------------------------------------------------------------
def build_variant(variant=None, pose=None, name=None, axe=False, logs=False):
    parts = H.build(variant=variant or VARIANT, pose=pose, axe=axe, logs=logs)
    ob = make_object(parts, name or OBJ_NAME)
    return [ob], parts


def render_frame(anim, frame, rot, samples, out_png, scene=None, ppu=None,
                 variant=None, res=None, axe=None, logs=None):
    """Один кадр: почистить своих, собрать позу, повернуть, разложить тона, рендер."""
    import scene as SC
    scene = scene or bpy.context.scene
    SC.clear_own(scene)
    res = res or (RES_X, RES_Y)
    SC.setup(target=(0.0, 0.0, TARGET_Z), ppu=ppu or PPU, res=res, samples=samples)
    pose = PO.pose(anim, frame, variant or VARIANT) if anim else None
    name = '%s_%s_%d_%d' % (MAT_PREFIX.rstrip('_'), anim or 'rest', frame, rot)
    # Что в руках — из ОДНОГО места (poses.PROPS), а не из условия на имя
    # анимации: анимаций с предметом теперь три (work и walk_axe с топором,
    # carry с охапкой), и условие в сборке разошлось бы с poses при первой же
    # правке. Явные аргументы перебивают правило (ими снимается топор в тестах).
    want = PO.props(anim) if anim else {}
    objs, parts = build_variant(
        variant, pose, name=name,
        axe=want.get('axe', False) if axe is None else bool(axe),
        logs=want.get('logs', False) if logs is None else bool(logs))
    if rot:
        rotate_meshes(rot, scene)
        for o in objs:
            assign_tones(o)                 # тона — ПОСЛЕ поворота
    P.render_to(out_png)
    tris, verts = tris_verts(objs)
    return dict(tris=tris, verts=verts, objects=len(objs), parts=len(parts),
                size=round(world_size(objs)[2], 3),
                tones={k: [v[0], round(v[1], 5)]
                       for k, v in tone_census(objs[0]).items()})


def export_model(path_noext, scene=None, pose=None, axe=False):
    """Выгрузить .glb (Y вверх) и .obj (Z вверх) для движка.

    Вариант берётся из VARIANT (его ставит build_live из конфига), а не строкой
    'a': эта строка осталась от старого API, и `pose_of(variant='a')` молча
    возвращал ЖЕНСКУЮ фигуру — «мужской» villager.glb был женским. Выгружается
    поза покоя и БЕЗ топора: топор живёт в кадрах рубки (anim='work'), а .glb —
    это фигура для движка, а не кадр анимации.
    """
    import scene as SC
    scene = scene or bpy.context.scene
    os.makedirs(os.path.dirname(path_noext), exist_ok=True)
    SC.clear_own(scene)
    SC.setup(samples=32)
    objs, _ = build_variant(VARIANT, pose, name=OBJ_NAME, axe=axe)
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except Exception:
            pass
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    glb = path_noext + '.glb'
    # use_active_scene обязателен: иначе экспортёр тащит в файл ВСЕ сцены файла
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
