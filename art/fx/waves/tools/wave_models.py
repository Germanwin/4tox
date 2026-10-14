"""Гребни волн — низкополигональная геометрия в конвенциях thpipe.

Стиль снят с атласа игры (`mapgen2/assets/sprites/atlas.png`) и его описания
(`townhall/README.md`): низкополигональные фасеты, плоское затенение, тёмный
контур по силуэту, мягкая тень-пятно под моделью, солнце сверху-слева.

Гребень — не «горка» и не «искра», а вал: в плане это дуга, поперёк — узкий
профиль с острой кромкой. Белая пена лежит только на передней кромке вала,
склоны — вода. Широкая пена и пологий верх превращают волну в сугроб: у
настоящего гребня видно воду и только по кромке — пену.

Ось X — вдоль вала (по ней волна и бежит), +Y — на игрока (камера рендера
стоит со стороны +Y), Z — вверх. Один юнит модели — одна клетка карты.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix

import thpipe as P
from wave_shapes import SHAPES, shape as shape_params

# --------------------------------------------------------------------------
# ПАЛИТРА
#
# Вода берётся из палитры моря рендера (PAL в js/render.js: отмель #56B0CD,
# вода #2670A6, глубина #164E80), пена — светлее всего этого: гребень обязан
# читаться на любой глубине, а цвет моря под ним гуляет от берега к глубине.
# Тона на вид тёмные: солнце рендера поднимает их примерно в полтора раза.
# --------------------------------------------------------------------------

MATS = {}


def reset_palette():
    MATS.clear()


def palette():
    if MATS:
        return MATS
    MATS.update(
        water_c=P.make_material('water_c', 0x1C5478),   # низ и тень вала
        water_b=P.make_material('water_b', 0x2F7CA6),   # вода на склоне
        water_a=P.make_material('water_a', 0x4F9CC4),   # светлая вода у пены
        foam_c=P.make_material('foam_c', 0x86BACE),     # пена в тени
        foam_b=P.make_material('foam_b', 0xAED9E8),     # пена средняя
        foam_a=P.make_material('foam_a', 0xD6EDF5),     # пена на свету
        dark=P.make_material('dark', 0x143F5E),         # нутро и днище
    )
    return MATS


SLOTS = ('water_c', 'water_b', 'water_a', 'foam_c', 'foam_b', 'foam_a', 'dark')


def slot(name):
    return SLOTS.index(name)


# Профиль поперёк вала: (y, z), от задней кромки через гребень к передней.
# Узкий и острый: покатые бока дают воде фасеты под углом к солнцу, а не
# блик сверху, и гребень читается линией, а не площадкой.
PROFILE = ((-0.46, 0.00), (-0.34, 0.36), (-0.17, 0.70), (0.00, 1.00),
           (0.14, 0.68), (0.28, 0.34), (0.42, 0.00))

# Материал полосы между соседними точками профиля. Белая пена — только полоса
# у передней кромки (её и видно игроку), склоны остаются водой.
ROWS = (('water_c', 'water_b'), ('water_b', 'water_a'), ('water_a', 'foam_c'),
        ('foam_b', 'foam_a'), ('foam_c', 'water_a'), ('water_a', 'water_b'))


def add_face(bm, verts, row, rnd):
    """Фасет с материалом из пары тонов: цвет выбирается на каждый фасет."""
    pair = ROWS[row] if isinstance(row, int) else (row, row)
    try:
        f = bm.faces.new(verts)
    except ValueError:
        return None
    f.material_index = slot(pair[0] if rnd.random() < 0.62 else pair[1])
    return f


def build_crest(bm, rnd, length, height, chop):
    """Вал: кольца профиля вдоль дуги в плане, концы сходятся в точки."""
    n = rnd.randint(4, 5) if chop else rnd.randint(5, 7)
    bulge = rnd.uniform(0.08, 0.20) * length       # выгиб кромки на игрока
    lean = rnd.uniform(-0.08, 0.08)                # наклон вала вперёд-назад
    rings = []
    for i in range(n):
        t = i / (n - 1)
        taper = math.sin(math.pi * t) ** (0.22 if chop else 0.26)
        x = -length / 2 + length * t + rnd.uniform(-0.02, 0.02) * length
        y0 = bulge * math.sin(math.pi * t) + lean * (t - 0.5)
        if taper < 0.12:
            rings.append([bm.verts.new((x, y0, 0.0))])
            continue
        ring = []
        for (py, pz) in PROFILE:
            y = y0 + (py + rnd.uniform(-0.05, 0.05)) * taper
            z = pz * taper * height * rnd.uniform(0.68, 1.26)
            ring.append(bm.verts.new((x + rnd.uniform(-0.02, 0.02),
                                      y, max(0.0, z))))
        rings.append(ring)

    for i in range(n - 1):
        a, b = rings[i], rings[i + 1]
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            for k in range(len(b) - 1):
                add_face(bm, [a[0], b[k], b[k + 1]], k, rnd)
        elif len(b) == 1:
            for k in range(len(a) - 1):
                add_face(bm, [a[k], a[k + 1], b[0]], k, rnd)
        else:
            for k in range(len(a) - 1):
                add_face(bm, [a[k], a[k + 1], b[k + 1], b[k]], k, rnd)
            # Днище: вал стоит на воде, но силуэт не должен просвечивать.
            add_face(bm, [a[0], b[0], b[-1], a[-1]], 'dark', rnd)
    return bm


def new_obj(bm, name):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    for s in SLOTS:
        ob.data.materials.append(palette()[s])
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False          # плоское затенение фасетов, как в атласе
    return ob


def build(shape, rot_deg=0.0, seed=None):
    """Собрать один гребень: shape — номер формы, rot_deg — поворот вокруг Z."""
    length, height, chop = shape_params(shape)
    rnd = random.Random((seed if seed is not None else 1) * 977 + shape * 31)
    bm = bmesh.new()
    build_crest(bm, rnd, length, height, chop)
    if rot_deg:
        r = math.radians(rot_deg)
        bmesh.ops.rotate(bm, verts=bm.verts,
                         cent=(0.0, 0.0, 0.0),
                         matrix=Matrix.Rotation(r, 3, 'Z'))
    return [new_obj(bm, 'wave_%d_%d' % (shape, int(rot_deg)))]
