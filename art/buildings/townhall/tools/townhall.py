"""Сцены трёх вариантов бедной деревенской ратуши.

Ратуша занимает 4 x 3 клетки: X — 4 клетки (длинная сторона), Y — 3 клетки.
Начало координат — центр основания, z = 0 — уровень земли.

  a — главный дом: обмазанный плетень под двускатной соломой, глухой фонарь на коньке.
  b — тот же дом + открытый навес, плетень, кадка, поленница.
  c — тот же дом + сруб-звонница над входом под четырёхскатным колпаком.

Стиль: низкополигонально, плоские фасеты, приглушённые цвета, бедность на виду —
кривой конёк, мшистый цоколь, заплаты на соломе, ни одного лишнего украшения.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

import thpipe as P

# --------------------------------------------------------------------------
# ПАЛИТРА (сверяется с эталоном: рендер ≈ #3c7e35 у дуба, #787f85 у валуна)
# --------------------------------------------------------------------------
PAL = {}


def reset_palette():
    """Сцена чистится между кадрами — вместе с ней умирают материалы."""
    PAL.clear()


def palette():
    if PAL:
        return PAL
    PAL.update(
        wall    = P.make_material('wall',    0x93714A),   # обмазанный плетень
        timber  = P.make_material('timber',  0x5E3D1E),   # силовой каркас
        beam    = P.make_material('beam',    0x8A6238),   # балки, обвязка
        plank   = P.make_material('plank',   0xA07C4C),   # доски, ставни
        thatch  = P.make_material('thatch',  0xA8823C),   # солома
        thatch2 = P.make_material('thatch2', 0x8E6C2C),   # старая солома, заплаты
        stone   = P.make_material('stone',   0x8E9498),   # цоколь, булыжник
        stone2  = P.make_material('stone2',  0x6E747A),   # тёмный камень
        moss    = P.make_material('moss',    0x466B34),   # мох на цоколе
        dark    = P.make_material('dark',    0x1A140E),   # проёмы, нутро
        dirt    = P.make_material('dirt',    0x7A6244),   # утоптанная земля
        iron    = P.make_material('iron',    0x3A3A3E),   # колокол, обручи
    )
    return PAL


def M(key):
    return palette()[key]


# --------------------------------------------------------------------------
# МЕЛКИЕ ПОСТРОИТЕЛИ
# --------------------------------------------------------------------------
def obj(bm, name, mat, jit=0.012, seed=1):
    if jit:
        P.jitter(bm, jit, seed)
    return P.new_obj_from_bm(bm, name, mat)


def box(bm, x, y, z, sx, sy, sz, rz=0.0, rx=0.0, ry=0.0):
    return P.add_box(bm, x, y, z, sx, sy, sz, rz, rx, ry)


def tri_yz(bm, x, pts, thickness):
    """Треугольная щипцовая стенка в плоскости YZ, толщина по X."""
    me = bmesh.new()
    vs = [me.verts.new((0.0, y, z)) for y, z in pts]
    me.faces.new(vs)
    bmesh.ops.recalc_face_normals(me, faces=list(me.faces))
    r = bmesh.ops.extrude_face_region(me, geom=list(me.faces))
    up = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(me, verts=up, vec=(thickness, 0, 0))
    for v in me.verts:
        v.co.x += x - thickness / 2
    bmesh.ops.recalc_face_normals(me, faces=list(me.faces))
    tmp = bpy.data.meshes.new('tmp_tri')
    me.to_mesh(tmp)
    me.free()
    bm.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)
    return bm


# --------------------------------------------------------------------------
# ОСТОВ: ЦОКОЛЬ, СТЕНЫ, КАРКАС
# --------------------------------------------------------------------------
WALL_H = 1.55
HALF_X, HALF_Y = 1.85, 1.35          # стены: 3.7 x 2.7 внутри пятна 4 x 3
RIDGE_Z = 2.82
EAVE_Z = 1.42
OVER_X = 0.24                        # свес по коньку
OVER_Y = 0.28                        # свес по скату


def build_plinth():
    bm = bmesh.new()
    # ряд валунов по периметру пятна + забутовка внутри
    rnd = random.Random(31)
    xs = (-1.78, -0.90, 0.02, 0.94, 1.80)
    for i in range(len(xs) - 1):
        cx = (xs[i] + xs[i + 1]) / 2 + rnd.uniform(-0.05, 0.05)
        box(bm, cx, 1.46, -0.19, 0.92, 0.30, 0.24, rz=rnd.uniform(-0.05, 0.05))
        box(bm, cx, -1.46, -0.19, 0.92, 0.30, 0.24, rz=rnd.uniform(-0.05, 0.05))
    for j, cy in enumerate((-0.95, 0.0, 0.95)):
        box(bm, 1.86, cy, -0.19, 0.30, 0.86, 0.24, rz=rnd.uniform(-0.05, 0.05))
        box(bm, -1.86, cy, -0.19, 0.30, 0.86, 0.24, rz=rnd.uniform(-0.05, 0.05))
    box(bm, 0, 0, -0.26, 3.60, 2.60, 0.20)
    ob = obj(bm, 'plinth', M('stone'), 0.016, 3)

    bm = bmesh.new()
    box(bm, 0, 0, -0.03, 4.02, 3.02, 0.06)
    ob2 = obj(bm, 'plinth_top', M('stone2'), 0.008, 4)

    bm = bmesh.new()
    for x in (-1.9, -0.7, 0.9, 1.7):
        box(bm, x, 1.57, -0.03, 0.44, 0.16, 0.06)
    for x in (-1.5, -0.2, 1.2):
        box(bm, x, -1.57, -0.03, 0.36, 0.14, 0.05)
    for y in (-1.2, 0.1, 1.1):
        box(bm, -2.06, y, -0.03, 0.14, 0.38, 0.06)
    ob3 = obj(bm, 'plinth_moss', M('moss'), 0.010, 5)
    return [ob, ob2, ob3]


def build_walls():
    bm = bmesh.new()
    box(bm, 0, 0, 0.0, 3.70, 2.70, WALL_H)
    return obj(bm, 'walls', M('wall'), 0.018, 7)


def build_frame():
    bm = bmesh.new()
    h = WALL_H
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(bm, sx * HALF_X, sy * HALF_Y, 0.0, 0.18, 0.18, h)
    for sy in (-1, 1):
        box(bm, 0, sy * HALF_Y, 0.05, 3.70, 0.13, 0.13)
        box(bm, 0, sy * HALF_Y, h - 0.15, 3.70, 0.15, 0.15)
        for x in (-0.98, 0.98):
            box(bm, x, sy * HALF_Y, 0.0, 0.13, 0.13, h)
    for sx in (-1, 1):
        box(bm, sx * HALF_X, 0, 0.05, 0.13, 2.70, 0.13)
        box(bm, sx * HALF_X, 0, h - 0.15, 0.15, 2.70, 0.15)
    # подкосы от столбов к обвязке у входа
    for sx in (-1, 1):
        box(bm, sx * 1.30, HALF_Y, 1.02, 0.10, 0.10, 0.50, ry=math.radians(28 * sx))
    return obj(bm, 'frame', M('timber'), 0.012, 11)


def build_door(side=1, cx=0.0):
    y0 = side * HALF_Y
    bm = bmesh.new()
    box(bm, cx, y0 + side * 0.06, 0.0, 0.80, 0.14, 1.20)
    ob = obj(bm, 'door_arch', M('timber'), 0.008, 13)

    bm = bmesh.new()
    box(bm, cx, y0 + side * 0.02, 0.0, 0.70, 0.10, 1.10)
    ob2 = obj(bm, 'door_hole', M('dark'), 0.004, 14)

    bm = bmesh.new()
    for dx in (-0.21, 0.0, 0.21):
        box(bm, cx + dx, y0 + side * 0.10, 0.02, 0.19, 0.06, 1.06)
    box(bm, cx, y0 + side * 0.10, 0.48, 0.66, 0.05, 0.12)
    box(bm, cx, y0 + side * 0.10, 0.96, 0.66, 0.05, 0.10)
    ob3 = obj(bm, 'door_leaf', M('plank'), 0.008, 15)

    bm = bmesh.new()
    P.add_cone(bm, cx - 0.24, y0 + side * 0.16, 0.60, 0.05, 0.05, 0.03, 8,
               rot_z=math.radians(90))
    ob4 = obj(bm, 'door_ring', M('iron'), 0.0, 16)
    return [ob, ob2, ob3, ob4]


def build_windows(side=1, xs=(-0.75, 0.75)):
    y0 = side * HALF_Y
    bm = bmesh.new()
    for x in xs:
        box(bm, x, y0 + side * 0.015, 0.0, 0.34, 0.10, 0.70)
    ob = obj(bm, 'win_hole', M('dark'), 0.004, 17)

    bm = bmesh.new()
    for x in xs:
        box(bm, x, y0 + side * 0.075, 0.46, 0.40, 0.06, 0.42, rz=math.radians(3))
        box(bm, x, y0 + side * 0.075, 0.86, 0.40, 0.06, 0.10)
    ob2 = obj(bm, 'win_shut', M('plank'), 0.008, 18)
    return [ob, ob2]


# --------------------------------------------------------------------------
# ДВУСКАТНАЯ СОЛОМЕННАЯ КРЫША (общая для всех вариантов)
# --------------------------------------------------------------------------
def build_roof(ridge_len=None, half_y=None, ridge_z=RIDGE_Z, eave_z=EAVE_Z,
               over_x=OVER_X, over_y=OVER_Y, slope_ang=None):
    """Скаты, торцевые заделки, конёк, прижимные слеги, заплаты."""
    ridge_len = (2 * HALF_X if ridge_len is None else ridge_len)
    half_y = (HALF_Y if half_y is None else half_y)
    out = []
    a = ridge_len / 2 + over_x
    b = half_y + over_y
    ang = math.atan2(ridge_z - eave_z, b)

    # --- скаты
    bm = bmesh.new()
    P.add_quad(bm, [(-a, 0.0, ridge_z), (a, 0.0, ridge_z), (a, b, eave_z), (-a, b, eave_z)])
    P.add_quad(bm, [(-a, 0.0, ridge_z), (-a, -b, eave_z), (a, -b, eave_z), (a, 0.0, ridge_z)])
    out.append(obj(bm, 'roof', M('thatch'), 0.022, 19))

    # --- торцевые заделки: солома имеет толщину
    bm = bmesh.new()
    th = 0.17
    for sx in (-1, 1):
        P.add_quad(bm, [(sx * a, b, eave_z), (sx * a, b, eave_z - th),
                        (sx * a, 0.0, ridge_z - th), (sx * a, 0.0, ridge_z)])
        P.add_quad(bm, [(sx * a, -b, eave_z), (sx * a, -b, eave_z - th),
                        (sx * a, 0.0, ridge_z - th), (sx * a, 0.0, ridge_z)])
    out.append(obj(bm, 'roof_end', M('thatch2'), 0.012, 20))

    # --- конёк: толстая слега, слегка провисшая
    bm = bmesh.new()
    seg = 7
    for i in range(seg):
        t0 = -a + (2 * a) * i / seg
        t1 = -a + (2 * a) * (i + 1) / seg
        sag = 0.045 * math.sin(math.pi * (i + 0.5) / seg)
        box(bm, (t0 + t1) / 2, 0.0, ridge_z + 0.015 - sag, (t1 - t0) * 1.05, 0.26, 0.10)
    out.append(obj(bm, 'ridge', M('thatch2'), 0.012, 21))

    # --- прижимные слеги поперёк скатов
    bm = bmesh.new()
    for py in (0.78, 1.28):
        zc = ridge_z - (ridge_z - eave_z) * py / b
        for sy in (-1, 1):
            box(bm, 0.0, sy * py, zc + 0.022, ridge_len * 0.84, 0.07, 0.05,
                rx=-sy * ang)
    out.append(obj(bm, 'roof_battens', M('timber'), 0.008, 23))

    # --- заплаты: перекрытая солома, прибитая жердью
    bm = bmesh.new()
    for (px, py, w, l, rzz) in ((0.62, 0.60, 0.86, 0.46, 0.045),
                                (-1.18, 1.02, 0.66, 0.52, -0.06)):
        zc = ridge_z - (ridge_z - eave_z) * py / b + 0.02
        box(bm, px, py, zc, w, l, 0.05, rx=-ang, rz=rzz)
        box(bm, px, py, zc + 0.055, w * 1.05, 0.05, 0.045, rx=-ang, rz=rzz)
    out.append(obj(bm, 'roof_patch', M('thatch2'), 0.012, 22))
    return out


def build_gable(tri_pts_yz):
    """Два щипцовых треугольника на торцах X = ±HALF_X."""
    bm = bmesh.new()
    for sx in (-1, 1):
        tri_yz(bm, sx * HALF_X, tri_pts_yz, 0.10)
    return obj(bm, 'gable', M('wall'), 0.014, 61)


def gable_points():
    return [(-HALF_Y, WALL_H), (HALF_Y, WALL_H), (0.0, RIDGE_Z - 0.06)]


# --------------------------------------------------------------------------
# НАДСТРОЙКИ И ПРИСТРОЙКИ
# --------------------------------------------------------------------------
def build_bell_cote(x0=0.55):
    """Глухой фонарь на коньке: четыре стойки, колпак, чугунный колокол."""
    bm = bmesh.new()
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(bm, x0 + sx * 0.30, sy * 0.30, 0.0, 0.12, 0.12, 0.64)
    box(bm, x0, 0.0, 0.56, 0.78, 0.74, 0.10)
    out = [obj(bm, 'cote_frame', M('timber'), 0.010, 43)]

    e = 0.50
    top = 0.68
    apex = 1.12
    bm = bmesh.new()
    ring = [(x0 - e, -e, top), (x0 + e, -e, top), (x0 + e, e, top), (x0 - e, e, top)]
    for i in range(4):
        P.add_quad(bm, [(x0, 0.0, apex), ring[i], ring[(i + 1) % 4]])
    out.append(obj(bm, 'cote_roof', M('thatch'), 0.014, 44))

    bm = bmesh.new()
    P.add_cone(bm, x0, 0.0, 0.56, 0.12, 0.19, 0.19, 9)
    out.append(obj(bm, 'bell', M('iron'), 0.006, 45))
    return out


def build_belfry_gable():
    """Звонница в щипце: проём над щипцом, колокол на качалке, два столбика.

    Самый дешёвый способ повесить колокол — не строить башню, а прорезать
    проём в торцевой стене. Для бедной деревни это и есть настоящая ратуша.
    """
    out = []
    # проём: две стойки по краям, перекладина, тёмная ниша
    bm = bmesh.new()
    for sx in (-1, 1):
        box(bm, sx * 0.335, 0.0, 2.16, 0.13, 0.26, 0.72)
    box(bm, 0.0, 0.0, 2.80, 0.90, 0.26, 0.13)
    box(bm, 0.0, 0.0, 2.02, 1.16, 0.22, 0.12)
    out.append(obj(bm, 'belfry_frame', M('timber'), 0.008, 71))

    bm = bmesh.new()
    box(bm, 0.0, 0.0, 2.06, 0.60, 0.24, 0.82)
    out.append(obj(bm, 'belfry_dark', M('dark'), 0.004, 72))

    bm = bmesh.new()
    box(bm, 0.0, 0.0, 2.58, 0.78, 0.09, 0.08)                 # качалка
    P.add_cone(bm, 0.0, 0.0, 2.30, 0.10, 0.17, 0.20, 9)       # колокол
    box(bm, 0.0, 0.0, 2.50, 0.055, 0.055, 0.12)              # подвес
    out.append(obj(bm, 'belfry_bell', M('iron'), 0.004, 73))
    return out


def build_porch():
    """Крыльцо с навесом перед входом: четыре столба, односкатная солома, настил.

    Для бедной деревни это главный признак «здесь решают дела»: не башня,
    а место, где можно встать под дождём.
    """
    x0, x1 = -1.05, 1.05
    y_wall, y_out = HALF_Y, HALF_Y + 1.05
    h_wall, h_out = 1.16, 0.94
    bm = bmesh.new()
    for sx in (-1, 1):
        box(bm, sx * (x1 - 0.07), y_out, 0.04, 0.14, 0.14, h_out - 0.10)   # столб
    box(bm, 0.0, y_out, h_out - 0.14, x1 * 2, 0.15, 0.14)                  # прогон
    out = [obj(bm, 'porch_frame', M('timber'), 0.012, 31)]

    # настил и ступенька
    bm = bmesh.new()
    box(bm, 0.0, (y_wall + y_out) / 2 + 0.10, 0.0, x1 * 2 - 0.10, 1.28, 0.14)
    box(bm, 0.0, y_out + 0.14, -0.06, 0.90, 0.32, 0.14)
    out.append(obj(bm, 'porch_deck', M('plank'), 0.010, 32))

    # односкатная соломенная кровля крыльца
    bm = bmesh.new()
    P.add_quad(bm, [(x0 - 0.14, y_wall - 0.18, h_wall), (x1 + 0.14, y_wall - 0.18, h_wall),
                    (x1 + 0.14, y_out + 0.16, h_out), (x0 - 0.14, y_out + 0.16, h_out)])
    out.append(obj(bm, 'porch_roof', M('thatch2'), 0.016, 33))

    bm = bmesh.new()
    th = 0.14
    for xe in (x0 - 0.14, x1 + 0.14):
        P.add_quad(bm, [(xe, y_wall - 0.18, h_wall), (xe, y_wall - 0.18, h_wall - th),
                        (xe, y_out + 0.16, h_out - th), (xe, y_out + 0.16, h_out)])
    out.append(obj(bm, 'porch_roof_end', M('thatch2'), 0.009, 34))
    return out


def build_fence():
    bm = bmesh.new()
    for i in range(3):
        y = 1.66 + i * 0.36
        box(bm, -1.66, y, 0.0, 0.08, 0.08, 0.42 + 0.03 * (i % 3))
    for z in (0.15, 0.29, 0.41):
        box(bm, -1.66, 2.02, z, 0.05, 0.96, 0.055)
    return obj(bm, 'fence', M('timber'), 0.014, 35)


def build_barrel(x=-1.15, y=1.60):
    bm = bmesh.new()
    P.add_cone(bm, x, y, 0.0, 0.24, 0.21, 0.52, 9)
    out = [obj(bm, 'barrel', M('plank'), 0.010, 37)]
    bm = bmesh.new()
    for z in (0.10, 0.37):
        P.add_cone(bm, x, y, z, 0.238, 0.226, 0.05, 9)
    out.append(obj(bm, 'barrel_hoop', M('iron'), 0.006, 38))
    return out


def build_woodpile(x=1.42, y=-1.66):
    bm = bmesh.new()
    rnd = random.Random(41)
    for row in range(3):
        for i in range(5):
            xc = x + i * 0.19 - (0.09 if row % 2 else 0.0)
            r = 0.085 + rnd.uniform(-0.008, 0.008)
            P.add_cone(bm, xc, y, 0.02 + row * 0.165, r, r, 0.46, 7,
                       rot_z=math.radians(90))
    return obj(bm, 'woodpile', M('timber'), 0.012, 41)


def build_yard():
    """Булыжники у входа.

    Утоптанной земли (настила-«порога» перед входом) здесь больше нет: он
    выходил за пятно застройки на 0.6 клетки, и заказчик видел его как
    выступающий порог. Правило посадки (`mapgen2/AGENTS.md`, 2026-10-13):
    всё, что стоит на земле, — внутри пятна, поэтому двор кончается по его
    кромке. Булыжники остались: их край доходит до 1.91 юнита при пятне 1.5,
    но игра поджимает спрайт (mul 0.7667), и они внутри.
    """
    bm = bmesh.new()
    P.add_ico(bm, -1.66, 1.78, 0.06, 0.20, 0.18, 0.13, 1)
    P.add_ico(bm, 1.58, 1.66, 0.05, 0.14, 0.16, 0.10, 1)
    return [obj(bm, 'stones', M('stone'), 0.014, 51)]


# --------------------------------------------------------------------------
# ВАРИАНТЫ
# --------------------------------------------------------------------------
def build_common():
    out = build_plinth()
    out.append(build_walls())
    out.append(build_frame())
    out.append(build_gable(gable_points()))
    out += build_roof()
    return out


def build_variant_a():
    out = build_common()
    out += build_door(1, 0.0)
    out += build_windows(1, (-1.05, 1.05))
    out += build_bell_cote(0.50)
    out += build_yard()
    return out


def build_variant_b():
    out = build_common()
    out += build_door(1, -0.35)
    out += build_windows(1, (0.80, 1.42))
    out += build_porch()
    out.append(build_fence())
    out += build_barrel(-0.86, 2.02)
    out.append(build_woodpile(1.58, -1.62))
    out += build_yard()
    return out


def build_variant_c():
    out = build_common()
    out += build_door(1, 0.62)
    out += build_windows(1, (-1.10, -0.20))
    out += build_windows(-1, (0.60,))
    out += build_belfry_gable()
    out += build_yard()
    return out


BUILDERS = {'a': build_variant_a, 'b': build_variant_b, 'c': build_variant_c}


def build(name):
    objs = [o for o in BUILDERS[name]() if o is not None]
    P.apply_transforms(objs)
    return objs
