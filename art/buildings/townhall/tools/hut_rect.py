"""hut_rect.py — прямоугольная хижина 3 x 2 клетки, три варианта ранней деревни.

Конвенции пайплайна (thpipe / geom, замерены по assets/sprites/atlas.png):
    1 юнит модели = 1 клетка карты, пятно 3 x 2 (X — длинная сторона),
    начало координат — центр пятна, z = 0 — земля, дверь смотрит в +Y.

Стиль снят с атласа деревьев mapgen2: плоские крупные фасетки, плоское
затенение, контур по силуэту (рисует compose), палитра — только «лесные»
цвета атласа: коричневые, серые, зелёные плюс янтарный акцент.

Три варианта отличаются строительной идеей и силуэтом:
    A  сруб из брёвен под двускатной соломой — самая читаемая «первая изба»;
    B  каркас с глиняной обмазкой, вальмовая кровля из каменных плит,
       наружная труба из валунов — дом уже «с пристройкой»;
    C  полуземлянка: низкие стены, земляная присыпка, дерновая кровля.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

import thpipe as P

# --------------------------------------------------------------------------
# ПАЛИТРА (замер по assets/sprites/atlas.png: p50/p90 фасетов спрайтов)
# --------------------------------------------------------------------------
SRGB = {
    'wood':      0xAB7527,   # бревно, светлый фасет (осенняя крона #A46F24)
    'wood_mid':  0x8A6128,
    'wood_dark': 0x553A1A,   # тёмная обвязка, тень стволов
    'roof':      0x7C858B,   # каменная плита (камень #798084)
    'roof_dark': 0x5C656C,
    'stone':     0x7C8388,   # цоколь (камень #7A8286)
    'stone_dark': 0x666D72,
    'daub':      0x8A7150,   # глиняная обмазка — тёплый серо-коричневый
    'daub_dark': 0x6E5A3E,
    'earth':     0x6E5230,   # утоптанная земля, присыпка
    'straw':     0xA87C34,   # солома (палитра ратуши, приглушённая)
    'straw_light': 0xC09040,  # солома в свету — кровля читается отдельно от стен
    'straw_dark': 0x8E6C2C,
    'leaf':      0x4C8434,   # дёрн / куст
    'leaf_dark': 0x2C5C25,
    'glow':      0xF7C765,
    'dark':      0x1A140E,   # проёмы, дымовое отверстие
}

M = {}
_cache = {}


def _lin255(hex_rgb):
    """sRGB -> линейное значение, упакованное в int (thpipe.make_material
    кладёт компоненты в Base Color как линейные)."""
    out = 0
    for i in (16, 8, 0):
        c = ((hex_rgb >> i) & 255) / 255.0
        lin = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        out |= int(round(lin * 255)) << i
    return out


def materials():
    if _cache:
        return _cache
    for name, hexcol in SRGB.items():
        _cache[name] = P.make_material('hr_' + name, _lin255(hexcol),
                                       rough=0.92, spec=0.0)
    return _cache


def reset_palette():
    _cache.clear()


def mat(name):
    return materials()[name]


# --------------------------------------------------------------------------
# ГЕОМЕТРИЯ
# --------------------------------------------------------------------------
def obj(bm, name, material, jitter_amt=0.012, seed=1, flat=True):
    if jitter_amt:
        P.jitter(bm, jitter_amt, seed)
    ob = P.new_obj_from_bm(bm, name, material)
    return ob


def box(bm, cx, cy, z0, sx, sy, sz, rz=0.0, rx=0.0, ry=0.0):
    return P.add_box(bm, cx, cy, z0, sx, sy, sz, rot_z=rz, rot_x=rx, rot_y=ry)


def orient_outward(bm, faces, center):
    """Развернуть грани наружу от точки внутри объёма (для ручных оболочек)."""
    c = Vector(center)
    for f in faces:
        if (f.calc_center_median() - c).dot(f.normal) < 0.0:
            f.normal_flip()
    return bm


def quad(bm, pts, center=(0.0, 0.0, 0.8)):
    f = bm.faces.new([bm.verts.new(p) for p in pts])
    bm.verts.ensure_lookup_table()
    orient_outward(bm, [f], center)
    return bm


def tri(bm, pts, center=(0.0, 0.0, 0.8)):
    return quad(bm, pts, center)


def prism_x(bm, poly_yz, x0, x1, center=None):
    """Призма вдоль X по контуру в плоскости YZ (для щипцов крыши)."""
    a = [bm.verts.new((x0, y, z)) for y, z in poly_yz]
    b = [bm.verts.new((x1, y, z)) for y, z in poly_yz]
    bm.verts.ensure_lookup_table()
    faces = [bm.faces.new(a), bm.faces.new(list(reversed(b)))]
    n = len(poly_yz)
    for i in range(n):
        j = (i + 1) % n
        faces.append(bm.faces.new([a[i], a[j], b[j], b[i]]))
    if center is None:
        zs = [z for _, z in poly_yz]
        center = ((x0 + x1) / 2.0, 0.0, (min(zs) + max(zs)) / 2.0)
    orient_outward(bm, faces, center)
    return bm


def stone_run(bm, x0, x1, y, z0, n, h=0.22, depth=0.30, seed=1, along_x=True):
    """Ряд валунов-плитняка по линии (цоколь)."""
    rnd = random.Random(seed)
    for i in range(n):
        t = (i + 0.5) / n
        c = x0 + (x1 - x0) * t + rnd.uniform(-0.03, 0.03)
        w = (x1 - x0) / n * rnd.uniform(0.82, 1.02)
        if along_x:
            box(bm, c, y, z0, w, depth, h * rnd.uniform(0.85, 1.1),
                rz=rnd.uniform(-0.05, 0.05))
        else:
            box(bm, y, c, z0, depth, w, h * rnd.uniform(0.85, 1.1),
                rz=rnd.uniform(-0.05, 0.05))
    return bm


# --------------------------------------------------------------------------
# ОБЩИЕ ЧАСТИ
# --------------------------------------------------------------------------
HALF_X, HALF_Y = 1.30, 0.81          # стены 2.60 x 1.62 внутри пятна 3 x 2
Z_PLINTH = 0.22


def build_plinth(bm, seed=11, moss=True):
    """Каменный цоколь по периметру пятна + верхняя плита."""
    stone_run(bm, -1.44, 1.44, HALF_Y + 0.10, 0.0, 4, h=0.24, depth=0.30, seed=seed)
    stone_run(bm, -1.44, 1.44, -HALF_Y - 0.10, 0.0, 4, h=0.24, depth=0.30, seed=seed + 1)
    stone_run(bm, -HALF_Y - 0.18, HALF_Y + 0.18, 1.44, 0.0, 2, h=0.24,
              depth=0.30, seed=seed + 2, along_x=False)
    stone_run(bm, -HALF_Y - 0.18, HALF_Y + 0.18, -1.44, 0.0, 2, h=0.24,
              depth=0.30, seed=seed + 3, along_x=False)
    box(bm, 0, 0, 0.06, 2.86, 1.86, 0.16)
    return bm


def build_door(bm, bmf, x, w=0.60, h=0.94, y=None, seed=21):
    """Полотно двери (bm) и рама (bmf). Дверь смотрит в +Y."""
    y = HALF_Y if y is None else y
    yo = y + 0.02
    # полотно
    box(bm, x, yo + 0.03, Z_PLINTH + 0.04, w, 0.08, h)
    # рама: стойки, перекладина, порог
    for sx in (-1, 1):
        box(bmf, x + sx * (w / 2 + 0.045), y + 0.05, Z_PLINTH,
            0.11, 0.14, h + 0.16)
    box(bmf, x, y + 0.05, Z_PLINTH + h + 0.10, w + 0.20, 0.14, 0.10)
    box(bmf, x, y + 0.05, Z_PLINTH - 0.04, w + 0.20, 0.16, 0.08)
    return bm, bmf


def build_window(bm, bmf, x, y, z, size=0.34, nx=0.0, ny=1.0, seed=31):
    """Окно с деревянной рамой и ставней. nx/ny — нормаль стены."""
    t = 0.07
    if abs(ny) > 0.5:                                   # стена по X
        box(bm, x, y + 0.02 * ny, z, size * 0.86, 0.05, size * 0.86)
        box(bmf, x, y + 0.05 * ny, z - size / 2 - t, size + 0.18, 0.10, 0.10)
        box(bmf, x, y + 0.05 * ny, z + size / 2, size + 0.18, 0.10, 0.10)
        box(bmf, x - size / 2 - t, y + 0.05 * ny, z - t, 0.09, 0.10, size)
        box(bmf, x + size / 2 + 0.05, y + 0.05 * ny, z - t, 0.09, 0.10, size)
    else:                                               # стена по Y
        box(bm, x + 0.02 * nx, y, z, 0.05, size * 0.86, size * 0.86)
        box(bmf, x + 0.05 * nx, y, z - size / 2 - t, 0.10, size + 0.18, 0.10)
        box(bmf, x + 0.05 * nx, y, z + size / 2, 0.10, size + 0.18, 0.10)
        box(bmf, x + 0.05 * nx, y - size / 2 - t, z - t, 0.10, 0.09, size)
        box(bmf, x + 0.05 * nx, y + size / 2 + 0.05, z - t, 0.10, 0.09, size)
    return bm, bmf


def build_firewood(bm, x, y, z, rz=0.0, rows=3, seed=41):
    """Поленница: короткие чурки, уложенные штабелем."""
    rnd = random.Random(seed)
    for r in range(rows):
        for c in range(rows - (r % 2)):
            dx = (c - (rows - 1 - (r % 2)) / 2.0) * 0.17
            box(bm, x + dx * math.cos(rz), y + dx * math.sin(rz),
                z + r * 0.15, 0.15, 0.15, 0.62, rz=rz + rnd.uniform(-0.05, 0.05))
    return bm


def build_bush(bm, x, y, z, r=0.24, seed=51):
    P.add_ico(bm, x, y, z + r * 0.8, r * 1.1, r, r * 0.95, subdiv=1)
    return bm


# --------------------------------------------------------------------------
# ВАРИАНТ A — сруб под двускатной соломой
# --------------------------------------------------------------------------
A = dict(courses=4, course_h=0.29, z0=Z_PLINTH, ridge=1.90, eave=1.30,
         over_x=0.12, over_y=0.12, stub=0.16)


def build_a(name='hut_a'):
    objs = []
    mats = materials()

    # --- цоколь ---
    bm = bmesh.new()
    build_plinth(bm, seed=11)
    objs.append(obj(bm, name + '_plinth', mats['stone'], 0.016, 3))

    # --- сруб: венцы + выпуски брёвен ТОЛЬКО в углах (иначе перерезают дверь) ---
    bm = bmesh.new()
    for i in range(A['courses']):
        z = A['z0'] + i * A['course_h']
        k = 1.0 + (0.006 if i % 2 else -0.004)
        box(bm, 0, 0, z, HALF_X * 2 * k, HALF_Y * 2 * k, A['course_h'])
    objs.append(obj(bm, name + '_walls', mats['wood'], 0.012, 7))

    bm = bmesh.new()
    st, sw = A['stub'], 0.15
    for i in range(A['courses']):
        z = A['z0'] + i * A['course_h']
        for sx in (-1, 1):
            for sy in (-1, 1):
                if i % 2 == 0:
                    box(bm, sx * (HALF_X + st / 2), sy * (HALF_Y - sw / 2), z,
                        st, sw, A['course_h'])
                else:
                    box(bm, sx * (HALF_X - sw / 2), sy * (HALF_Y + st / 2), z,
                        sw, st, A['course_h'])
    objs.append(obj(bm, name + '_logends', mats['wood_dark'], 0.008, 9))

    # --- фронтоны (щипцы) ---
    z_top = A['z0'] + A['courses'] * A['course_h']
    tri = [(-HALF_Y, z_top), (HALF_Y, z_top), (0.0, A['ridge'] - 0.02)]
    bm = bmesh.new()
    prism_x(bm, tri, -HALF_X - 0.01, -HALF_X + 0.09)
    prism_x(bm, tri, HALF_X - 0.09, HALF_X + 0.01)
    objs.append(obj(bm, name + '_gable', mats['wood_mid'], 0.012, 13))

    # --- двускатная солома: 3 ступенчатых слоя на скат ---
    bm = bmesh.new()
    z_e, z_r = A['eave'], A['ridge']
    ov = HALF_Y + A['over_y']
    rise = z_r - z_e
    ang = math.atan2(rise, ov)
    slope = math.hypot(ov, rise)
    thick = 0.15
    for s in (1, -1):
        for k in range(3):
            t0, t1 = k / 3.0, (k + 1) / 3.0
            tm = (t0 + t1) / 2.0
            cy = ov * (1.0 - tm)
            cz = z_e + rise * tm
            # ступень: каждый следующий слой лежит на предыдущем
            cy -= s * math.sin(ang) * thick * k
            cz += math.cos(ang) * thick * k
            box(bm, 0, s * cy, cz, HALF_X * 2 + 0.34, slope / 3.0 + 0.07,
                thick, rx=-s * ang)
    # конёк и торчащие концы жердей
    box(bm, 0, 0, z_r - 0.02, 2.96, 0.20, 0.14)
    objs.append(obj(bm, name + '_roof', mats['straw_light'], 0.014, 17))

    bm = bmesh.new()
    for sx in (-1, 1):
        box(bm, sx * 1.38, 0, A['ridge'] - 0.06, 0.22, 0.15, 0.12)
    box(bm, 0, 0, A['ridge'] + 0.06, 2.70, 0.12, 0.08)
    for s in (1, -1):                                    # жерди вдоль ската
        box(bm, 0.30, s * 0.44, A['eave'] + 0.30, 2.30, 0.09, 0.07, rx=-s * 0.55)
    objs.append(obj(bm, name + '_ridge', mats['wood_dark'], 0.010, 19))

    # --- дверь, окно, ставень ---
    bm, bmf = bmesh.new(), bmesh.new()
    build_door(bm, bmf, -0.46, w=0.64, h=1.00)
    objs.append(obj(bm, name + '_door', mats['dark'], 0.008, 23))
    objs.append(obj(bmf, name + '_doorframe', mats['wood_mid'], 0.010, 29))

    bm, bmf = bmesh.new(), bmesh.new()
    build_window(bm, bmf, 0.66, HALF_Y, Z_PLINTH + 0.70, size=0.36)
    objs.append(obj(bm, name + '_glass', mats['glow'], 0.0, 31))
    objs.append(obj(bmf, name + '_winframe', mats['wood_mid'], 0.008, 37))
    bm = bmesh.new()
    box(bm, 1.10, HALF_Y + 0.09, Z_PLINTH + 0.70, 0.22, 0.06, 0.44)
    objs.append(obj(bm, name + '_shutter', mats['wood_dark'], 0.008, 41))

    # --- двор: поленница, валун, куст ---
    bm = bmesh.new()
    build_firewood(bm, -1.12, -0.52, Z_PLINTH, rz=math.radians(90), rows=3, seed=43)
    objs.append(obj(bm, name + '_firewood', mats['wood_mid'], 0.012, 43))
    bm = bmesh.new()
    build_bush(bm, 1.16, -0.66, 0.0, 0.26, 47)
    objs.append(obj(bm, name + '_bush', mats['leaf'], 0.02, 47))
    bm = bmesh.new()
    P.add_ico(bm, -1.34, 0.72, 0.14, 0.22, 0.20, 0.16, subdiv=0)
    P.add_ico(bm, 0.32, -0.95, 0.11, 0.17, 0.17, 0.13, subdiv=0)
    objs.append(obj(bm, name + '_stones', mats['stone_dark'], 0.02, 53))
    return objs


# --------------------------------------------------------------------------
# ВАРИАНТ B — каркас + обмазка, вальмовая кровля из плит, наружная труба
# --------------------------------------------------------------------------
B = dict(wall_h=1.28, ridge=2.46, eave=1.56, over=0.13)


def build_b(name='hut_b'):
    objs = []
    mats = materials()

    bm = bmesh.new()
    build_plinth(bm, seed=61)
    objs.append(obj(bm, name + '_plinth', mats['stone'], 0.016, 3))

    # --- обмазка: пузатая стена из отдельных «замесов» ---
    bm = bmesh.new()
    box(bm, 0, 0, Z_PLINTH, HALF_X * 2 - 0.02, HALF_Y * 2 - 0.02, B['wall_h'])
    objs.append(obj(bm, name + '_daub', mats['daub'], 0.028, 63))

    bm = bmesh.new()                                   # заплатки обмазки
    for (px, py, pz, pw, ph) in ((-0.62, HALF_Y - 0.02, Z_PLINTH + 0.34, 0.54, 0.42),
                                 (0.30, HALF_Y - 0.02, Z_PLINTH + 0.86, 0.62, 0.36),
                                 (HALF_X - 0.02, 0.26, Z_PLINTH + 0.44, 0.50, 0.46)):
        if abs(px) > 1.0:
            box(bm, px, py, pz, 0.06, pw, ph)
        else:
            box(bm, px, py, pz, pw, 0.06, ph)
    objs.append(obj(bm, name + '_daub_patches', mats['daub_dark'], 0.012, 64))

    # --- каркас: столбы, обвязка, раскосы ---
    bm = bmesh.new()
    z_top = Z_PLINTH + B['wall_h']
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(bm, sx * (HALF_X - 0.06), sy * (HALF_Y - 0.06), Z_PLINTH - 0.02,
                0.16, 0.16, B['wall_h'] + 0.14)
    for sy in (-1, 1):                                   # промежуточные столбы
        for x in (-0.44, 0.44):
            box(bm, x, sy * (HALF_Y - 0.03), Z_PLINTH, 0.13, 0.13, B['wall_h'] + 0.06)
    for y in (-0.30, 0.30):                              # на коротких стенах
        box(bm, -(HALF_X - 0.03), y, Z_PLINTH, 0.13, 0.13, B['wall_h'] + 0.06)
    # верхняя обвязка по периметру
    box(bm, 0, HALF_Y - 0.04, z_top - 0.04, HALF_X * 2, 0.15, 0.14)
    box(bm, 0, -(HALF_Y - 0.04), z_top - 0.04, HALF_X * 2, 0.15, 0.14)
    box(bm, HALF_X - 0.04, 0, z_top - 0.04, 0.15, HALF_Y * 2, 0.14)
    box(bm, -(HALF_X - 0.04), 0, z_top - 0.04, 0.15, HALF_Y * 2, 0.14)
    # поясок по стенам: делит обмазку на панели, читается на спрайте
    z_mid = Z_PLINTH + B['wall_h'] * 0.52
    box(bm, 0, HALF_Y - 0.05, z_mid, HALF_X * 2 - 0.02, 0.12, 0.11)
    box(bm, 0, -(HALF_Y - 0.05), z_mid, HALF_X * 2 - 0.02, 0.12, 0.11)
    box(bm, HALF_X - 0.05, 0, z_mid, 0.12, HALF_Y * 2 - 0.02, 0.11)
    box(bm, -(HALF_X - 0.05), 0, z_mid, 0.12, HALF_Y * 2 - 0.02, 0.11)
    # раскосы в углах на видимых стенах
    for sy in (1, -1):
        for sx in (1, -1):
            box(bm, sx * (HALF_X - 0.30), sy * (HALF_Y - 0.02), Z_PLINTH + 0.10,
                0.42, 0.11, 0.11, rz=0.0, ry=sx * 0.62)
    objs.append(obj(bm, name + '_frame', mats['wood_dark'], 0.010, 67))

    # --- вальмовая кровля из каменных плит ---
    bm = bmesh.new()
    z_e, z_r = B['eave'], B['ridge']
    hp = 0.70                                            # длина конька
    ex, ey = HALF_X + B['over'], HALF_Y + B['over']
    ctr = (0.0, 0.0, (z_e + z_r) / 2.0)
    quad(bm, [(-ex, ey, z_e), (ex, ey, z_e), (hp / 2, 0.0, z_r), (-hp / 2, 0.0, z_r)], ctr)
    quad(bm, [(ex, -ey, z_e), (-ex, -ey, z_e), (-hp / 2, 0.0, z_r), (hp / 2, 0.0, z_r)], ctr)
    tri(bm, [(ex, -ey, z_e), (ex, ey, z_e), (hp / 2, 0.0, z_r)], ctr)
    tri(bm, [(-ex, ey, z_e), (-ex, -ey, z_e), (-hp / 2, 0.0, z_r)], ctr)
    # толщина свеса: плиты по периметру
    box(bm, 0, ey, z_e - 0.05, ex * 2 + 0.02, 0.15, 0.11)
    box(bm, 0, -ey, z_e - 0.05, ex * 2 + 0.02, 0.15, 0.11)
    box(bm, ex, 0, z_e - 0.05, 0.15, ey * 2 + 0.02, 0.11)
    box(bm, -ex, 0, z_e - 0.05, 0.15, ey * 2 + 0.02, 0.11)
    # коньковый брус
    box(bm, 0, 0, z_r - 0.03, hp + 0.22, 0.20, 0.12)
    objs.append(obj(bm, name + '_roof', mats['roof'], 0.012, 71))

    # --- наружная труба из валунов ---
    bm = bmesh.new()
    cx, cy = 1.02, -0.32
    for i, (dz, w) in enumerate(((0.00, 0.36), (0.26, 0.33), (0.50, 0.31),
                                 (0.72, 0.29))):
        box(bm, cx + (i % 2) * 0.025, cy, 1.62 + dz, w, w * 0.94, 0.28,
            rz=(i - 1.5) * 0.07)
    box(bm, cx, cy, 2.34, 0.42, 0.39, 0.10)
    objs.append(obj(bm, name + '_chimney', mats['stone'], 0.014, 73))
    bm = bmesh.new()
    box(bm, cx, cy, 2.44, 0.23, 0.22, 0.05)
    objs.append(obj(bm, name + '_chimney_hole', mats['dark'], 0.006, 79))

    # --- дверь с навесом, окно ---
    bm, bmf = bmesh.new(), bmesh.new()
    build_door(bm, bmf, -0.54, w=0.62, h=1.00)
    objs.append(obj(bm, name + '_door', mats['wood_dark'], 0.008, 83))
    objs.append(obj(bmf, name + '_doorframe', mats['wood_mid'], 0.010, 89))
    bm = bmesh.new()
    box(bm, -0.54, HALF_Y + 0.20, 1.30, 0.92, 0.42, 0.09, rx=0.34)
    for sx in (-1, 1):
        box(bm, -0.54 + sx * 0.40, HALF_Y + 0.34, Z_PLINTH, 0.08, 0.08,
            1.30 - Z_PLINTH)
    objs.append(obj(bm, name + '_awning', mats['wood_mid'], 0.010, 97))

    bm, bmf = bmesh.new(), bmesh.new()
    build_window(bm, bmf, 0.80, HALF_Y, Z_PLINTH + 0.72, size=0.34)
    objs.append(obj(bm, name + '_glass', mats['glow'], 0.0, 101))
    objs.append(obj(bmf, name + '_winframe', mats['wood_mid'], 0.008, 103))

    bm = bmesh.new()
    build_firewood(bm, 1.12, 0.48, Z_PLINTH, rz=math.radians(-90), rows=3, seed=107)
    objs.append(obj(bm, name + '_firewood', mats['wood_mid'], 0.012, 107))
    bm = bmesh.new()
    build_bush(bm, -1.30, -0.62, 0.0, 0.24, 109)
    objs.append(obj(bm, name + '_bush', mats['leaf'], 0.02, 109))
    return objs


# --------------------------------------------------------------------------
# ВАРИАНТ C — полуземлянка с дерновой кровлей
# --------------------------------------------------------------------------
C = dict(courses=3, course_h=0.30, z0=0.30, ridge=1.98, eave=1.16, stub=0.14)


def build_c(name='hut_c'):
    objs = []
    mats = materials()

    # --- земляная присыпка по периметру ---
    bm = bmesh.new()
    box(bm, 0, 0, 0.0, 3.00, 2.00, 0.18)
    box(bm, 0, HALF_Y + 0.26, 0.0, 2.78, 0.40, 0.30)
    box(bm, 0, -(HALF_Y + 0.26), 0.0, 2.78, 0.40, 0.30)
    box(bm, HALF_X + 0.20, 0, 0.0, 0.36, 1.62, 0.28)
    box(bm, -(HALF_X + 0.20), 0, 0.0, 0.36, 1.62, 0.28)
    objs.append(obj(bm, name + '_mound', mats['earth'], 0.02, 111))

    bm = bmesh.new()                                   # трава на бруствере
    rnd0 = random.Random(112)
    for i in range(10):
        side = i % 4
        t = rnd0.uniform(-1.15, 1.15)
        if side == 0:
            x, y, z = t, HALF_Y + 0.26, 0.30
        elif side == 1:
            x, y, z = t, -(HALF_Y + 0.26), 0.30
        elif side == 2:
            x, y, z = HALF_X + 0.20, t * 0.6, 0.28
        else:
            x, y, z = -(HALF_X + 0.20), t * 0.6, 0.28
        P.add_ico(bm, x, y, z, 0.11, 0.11, 0.14, subdiv=0)
    objs.append(obj(bm, name + '_mound_grass', mats['leaf_dark'], 0.02, 112))

    # --- каменный подклет + низкие стены из брёвен ---
    bm = bmesh.new()
    stone_run(bm, -1.28, 1.28, HALF_Y - 0.06, 0.12, 3, h=0.20, depth=0.26, seed=113)
    stone_run(bm, -1.28, 1.28, -(HALF_Y - 0.06), 0.12, 3, h=0.20, depth=0.26, seed=115)
    objs.append(obj(bm, name + '_stone', mats['stone_dark'], 0.018, 113))

    bm = bmesh.new()
    for i in range(C['courses']):
        z = C['z0'] + i * C['course_h']
        box(bm, 0, 0, z, HALF_X * 2, HALF_Y * 2 - 0.04, C['course_h'])
    objs.append(obj(bm, name + '_walls', mats['wood'], 0.014, 117))

    bm = bmesh.new()
    st, sw = C['stub'], 0.14
    for i in range(C['courses']):
        z = C['z0'] + i * C['course_h']
        for sx in (-1, 1):
            for sy in (-1, 1):
                if i % 2 == 0:
                    box(bm, sx * (HALF_X + st / 2), sy * (HALF_Y - 0.02 - sw / 2), z,
                        st, sw, C['course_h'])
                else:
                    box(bm, sx * (HALF_X - sw / 2), sy * (HALF_Y - 0.02 + st / 2), z,
                        sw, st, C['course_h'])
    objs.append(obj(bm, name + '_logends', mats['wood_dark'], 0.008, 118))

    # --- фронтоны ---
    z_top = C['z0'] + C['courses'] * C['course_h']
    tri = [(-HALF_Y + 0.02, z_top), (HALF_Y - 0.02, z_top), (0.0, C['ridge'] - 0.06)]
    bm = bmesh.new()
    prism_x(bm, tri, -HALF_X + 0.01, -HALF_X + 0.11)
    prism_x(bm, tri, HALF_X - 0.11, HALF_X - 0.01)
    objs.append(obj(bm, name + '_gable', mats['wood_dark'], 0.012, 119))

    # --- дерновая кровля: крупные плиты дёрна в два слоя ---
    bm = bmesh.new()
    ov = HALF_Y + 0.20
    rise = C['ridge'] - C['eave']
    ang = math.atan2(rise, ov)
    slope = math.hypot(ov, rise)
    for s in (1, -1):
        for (t0, t1, wid, th, lift) in ((0.00, 0.72, 2.68, 0.20, 0.0),
                                        (0.58, 1.00, 2.34, 0.17, 0.13)):
            tm = (t0 + t1) / 2.0
            cy = ov * (1.0 - tm) - s * math.sin(ang) * lift
            cz = C['eave'] + rise * tm + math.cos(ang) * lift
            box(bm, 0, s * cy, cz, wid, slope * (t1 - t0) + 0.08, th, rx=-s * ang)
    objs.append(obj(bm, name + '_turf', mats['leaf'], 0.020, 121))
    bm = bmesh.new()
    for s in (1, -1):
        box(bm, 0, s * 0.13, C['ridge'] - 0.02 + 0.06, 2.14, 0.34, 0.13,
            rx=-s * ang)
    objs.append(obj(bm, name + '_turf_dark', mats['leaf_dark'], 0.016, 127))

    # --- коньковые жерди и дымовое отверстие ---
    bm = bmesh.new()
    for sy in (-0.14, 0.14):
        box(bm, 0.0, sy, C['ridge'] + 0.06, 2.66, 0.09, 0.09)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(bm, sx * 1.30, sy * 0.14, C['ridge'] + 0.02, 0.14, 0.09, 0.13)
    objs.append(obj(bm, name + '_poles', mats['wood_dark'], 0.010, 131))
    bm = bmesh.new()
    P.add_cone(bm, -0.72, 0.0, C['ridge'] - 0.14, 0.16, 0.13, 0.14, seg=6)
    objs.append(obj(bm, name + '_smoke', mats['dark'], 0.008, 137))

    # --- низкая дверь, ступень, окно ---
    bm, bmf = bmesh.new(), bmesh.new()
    build_door(bm, bmf, -0.30, w=0.56, h=0.78)
    objs.append(obj(bm, name + '_door', mats['wood_dark'], 0.008, 139))
    objs.append(obj(bmf, name + '_doorframe', mats['wood_mid'], 0.010, 149))
    bm = bmesh.new()
    box(bm, -0.30, HALF_Y + 0.30, 0.0, 0.70, 0.34, 0.16)
    objs.append(obj(bm, name + '_step', mats['stone'], 0.012, 151))

    bm, bmf = bmesh.new(), bmesh.new()
    build_window(bm, bmf, 0.52, HALF_Y, 0.86, size=0.28)
    objs.append(obj(bm, name + '_glass', mats['glow'], 0.0, 157))
    objs.append(obj(bmf, name + '_winframe', mats['wood_mid'], 0.008, 163))

    # --- трава на крыше, кусты, валуны ---
    bm = bmesh.new()
    rnd = random.Random(167)
    for i in range(9):
        x = rnd.uniform(-1.15, 1.15)
        y = rnd.choice((-1, 1)) * rnd.uniform(0.20, 0.86)
        z = C['eave'] + (1 - abs(y) / (HALF_Y + 0.30)) * (C['ridge'] - C['eave'])
        P.add_ico(bm, x, y, z + 0.10, 0.10, 0.10, 0.13, subdiv=0)
    objs.append(obj(bm, name + '_grass', mats['leaf'], 0.02, 167))
    bm = bmesh.new()
    build_bush(bm, -1.34, 0.60, 0.06, 0.22, 173)
    objs.append(obj(bm, name + '_bush', mats['leaf_dark'], 0.02, 173))
    bm = bmesh.new()
    P.add_ico(bm, 1.32, -0.70, 0.14, 0.24, 0.21, 0.17, subdiv=0)
    P.add_ico(bm, 0.36, -1.02, 0.10, 0.16, 0.15, 0.12, subdiv=0)
    objs.append(obj(bm, name + '_stones', mats['stone'], 0.02, 179))
    return objs


BUILDERS = {'a': build_a, 'b': build_b, 'c': build_c}


def build(variant='a', name=None):
    fn = BUILDERS[variant]
    return fn(name or ('hut_' + variant))
