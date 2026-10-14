"""build.py — сборка дома в Blender: меш, материалы, тона по нормалям, кадр.

Исполняется ВНУТРИ Blender (живая сессия через tools/blmcp.py или headless).
Геометрия приходит из `house.py` (чистый Python), здесь только:
    * склейка деталей в ОДИН меш `vh_house`;
    * материалы по (семейство x тон) с базовыми цветами из калибровки;
    * раскладка фасетов по тонам ПО НОРМАЛИ — и обязательно ПОСЛЕ поворота
      (канон: «под поворотом модели свет не подкручивается»);
    * канонный кадр 512 x 640, орто-масштаб 8.0 = 80 px на юнит (как ратуша
      и хижина) либо 96 ppu — для стиль-гейта скилла.

Базовые цвета материалов ТЕМНЕЕ целевых тонов спрайта: поднять тон должна
сцена (солнце 2.05 + небо 0.42), а не материал. Их считает калибровка
(tools/calib.py -> tools/pal_cal.json), а не глаз.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
sys.path.append(os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import thpipe as P                                              # noqa: E402
import palette as PAL                                           # noqa: E402
import house as H                                               # noqa: E402

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')
CAL_JSON = os.path.join(HERE, 'pal_cal.json')

RES_X, RES_Y = 512, 640
PPU = 80.0                       # как у ратуши и хижины (ORTHO = 640/80 = 8.0)
MAIN = 'a'
MAT_PREFIX = 'vh_'
OBJ_NAME = 'vh_house'

# Запасная оценка подъёма тона, если калибровки ещё нет: фасет, повёрнутый к
# камере, отдаёт около половины линейного альбедо (замер по топору и лопате).
LIFT = 1.0
AMBIENT_W = 0.15                 # доля неба в ожидаемой яркости фасета

SUN_FROM = Vector(P.SUN_DIR).normalized()        # направление НА солнце
VIEW_FROM = Vector((-math.cos(P.EL) * math.cos(P.AZ),
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
    """Линейные значения -> hex для thpipe.make_material (он читает hex как
    ЛИНЕЙНЫЙ, поэтому в pal_cal.json лежат линейные цвета)."""
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
    """Базовый цвет материала (линейный hex): калибровка, иначе цель/LIFT."""
    cal = calibration()
    try:
        return int(str(cal[family][str(tone)]).lstrip('#'), 16)
    except Exception:
        target = PAL.hex_rgb(PAL.tones(family)[tone])
        return _lin_hex([c / LIFT for c in _to_lin(
            (target[0] << 16) | (target[1] << 8) | target[2])])


def target_rgb(family, tone):
    return PAL.hex_rgb(PAL.tones(family)[tone])


def _set_base(mat, hex_lin):
    r, g, b = [((hex_lin >> s) & 255) / 255.0 for s in (16, 8, 0)]
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    mat.diffuse_color = (r, g, b, 1.0)


def materials():
    """Материалы палитры дома: 7 семейств x 3 тона. Кэш проверяет живость."""
    global SLOTS
    if SLOTS:
        alive = True
        try:
            alive = all(bpy.data.materials.get(MAT_PREFIX + '%s_%d' % (f, t))
                        is not None for f, t in SLOTS)
        except ReferenceError:
            alive = False
        if alive:
            for i, (fam, tone) in enumerate(SLOTS):
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
                                      rough=(0.92 if fam in ('stone', 'iron')
                                             else 0.86),
                                      spec=0.02)
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
    """Разложить фасеты по трём тонам семейства — по нормали, ПОСЛЕ поворота.

    Семейство фасета берётся из FACE_FAMILY (какая деталь его породила), а тон —
    из нормали: грани, смотрящие в небо, светлые, отвернувшиеся — тёмные.
    """
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


def visible_weight(poly):
    return poly.area * max(0.0, poly.normal.dot(VIEW_FROM))


def bucket_normals(ob):
    """(семейство, тон) -> нормаль самого крупного ВИДИМОГО фасета."""
    best = {}
    for i, poly in enumerate(ob.data.polygons):
        fam, tone = SLOTS[poly.material_index]
        w = visible_weight(poly)
        if w <= 1e-9:
            continue
        key = (fam, tone)
        if key not in best or w > best[key][1]:
            best[key] = (poly.normal.copy(), w)
    return best


def tone_census(ob):
    out = {}
    for poly in ob.data.polygons:
        fam, tone = SLOTS[poly.material_index]
        d = out.setdefault('%s_%d' % (fam, tone), [0, 0.0])
        d[0] += 1
        d[1] += poly.area
    return out


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


def footprint(objs):
    xs, ys = [], []
    for o in objs:
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            xs.append(p.x)
            ys.append(p.y)
    return (round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3))


# --------------------------------------------------------------------------
# КАДР
# --------------------------------------------------------------------------
def build_variant(variant, scene=None):
    """Собрать дом варианта в текущей сцене. Возвращает список объектов."""
    parts = H.build(variant)
    ob = make_object(parts, OBJ_NAME)
    return [ob], parts


def render_frame(variant, rot, samples, out_png, scene=None, ppu=None):
    """Один кадр: почистить своих, собрать, повернуть, разложить тона, рендер."""
    import scene as SC
    scene = scene or bpy.context.scene
    SC.clear_own(scene)
    P.RES_X, P.RES_Y = RES_X, RES_Y
    P.ORTHO = P.RES_Y / float(ppu or PPU)
    SC.setup(samples=samples)
    objs, parts = build_variant(variant, scene)
    if rot:
        rotate_meshes(rot, scene)
        for o in objs:
            assign_tones(o)                 # тона — ПОСЛЕ поворота
    P.render_to(out_png)
    tris, verts = tris_verts(objs)
    return dict(tris=tris, verts=verts, objects=len(objs),
                parts=len(parts),
                size=round(world_size(objs)[2], 3),
                footprint=list(footprint(objs)),
                tones={k: [v[0], round(v[1], 5)]
                       for k, v in tone_census(objs[0]).items()})


def export_model(path_noext, scene=None):
    """Выгрузить .glb (Y вверх) и .obj (Z вверх) для движка."""
    os.makedirs(os.path.dirname(path_noext), exist_ok=True)
    meshes = [o for o in (scene or bpy.context.scene).objects
              if o.type == 'MESH' and o.name.startswith(MAT_PREFIX)]
    if not meshes:
        raise RuntimeError('нечего выгружать: в сцене нет мешей %s*' % MAT_PREFIX)
    # Выделяем БЕЗ bpy.ops: в контексте таймера аддона `object.select_all`
    # молча не срабатывает, и в GLB уезжает чужой объект из сцены заказчика
    # (наступили: в house_a.glb оказался его заводской Cube).
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except Exception:
            pass
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    glb = path_noext + '.glb'
    # use_active_scene обязателен: без него экспортёр glTF тащит в файл ВСЕ
    # сцены файла, и в house_a.glb уезжал заводской Cube из сцены заказчика
    # (грабли живого Blender: `use_selection` сам по себе не спасает).
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
