"""Хижина жителя деревни — геометрия в конвенциях пайплайна thpipe.

Снята с эталонного рендера хижины (ref/ref_full.png): овальная обмазанная
стена из крупных фасетов, тёмные столбы каркаса поверх обмазки, двускатная
крыша из длинных дранок ВДОЛЬ ската, коньковый брус с торчащими концами
дранок, тёсовая обвязка по торцам крыши, дверь с двумя стойками, перекладиной
и пологом из шкуры.

Начало координат — центр пятна, z = 0 — уровень земли.
Ось X — вдоль конька, дверь смотрит в +Y (как и у ратуши).
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

import thpipe as P

# --------------------------------------------------------------------------
# ПАЛИТРА (снята по пикселям эталона: обмазка #9C7854, дранка #C0A86C,
# каркас #6C6054 в свету и #3C3030 в тени, проём почти чёрный)
# --------------------------------------------------------------------------
PAL = {}


def reset_palette():
    PAL.clear()


def palette():
    if PAL:
        return PAL
    clay_a = P.make_material('clay_a', 0xD07C2C)      # обмазка, светлый фасет
    clay_b = P.make_material('clay_b', 0xB87028)      # обмазка, средний фасет
    clay_c = P.make_material('clay_c', 0x9A5A22)      # обмазка, тёмный фасет
    clay_d = P.make_material('clay_d', 0x7E4A1C)      # обмазка низа, затенённая
    PAL.update(
        clay_a=clay_a, clay_b=clay_b, clay_c=clay_c, clay_d=clay_d,
        clay=[clay_a, clay_b, clay_c],
        timber=P.make_material('timber', 0x413327),    # каркас, столбы, обвязка
        timber_d=P.make_material('timber_d', 0x2C231B),  # каркас в тени, торцы
        thatch_a=P.make_material('thatch_a', 0xBE8428),  # дранка светлая
        thatch_b=P.make_material('thatch_b', 0xA27630),  # дранка средняя
        thatch_c=P.make_material('thatch_c', 0x8E6628),  # дранка тёмная
        thatch_u=P.make_material('thatch_u', 0x53401C),  # настил под дранкой
        hide=P.make_material('hide', 0xB6B0A2),        # полог из шкуры
        dark=P.make_material('dark', 0x140F0A),        # проём, нутро
    )
    return PAL


def M(key):
    return palette()[key]


# --------------------------------------------------------------------------
# РАЗМЕРЫ
# --------------------------------------------------------------------------
# В системе сборки конёк идёт по X; в конце сборки всё поворачивается на 90°,
# и конёк встаёт по Y — как на эталоне (там скат уходит вправо-вниз, а торец
# с дверью смотрит влево-вперёд).
A_WALL, B_WALL = 1.08, 1.18       # полуоси овальной стены: X — вдоль конька
WALL_H = 1.25                     # высота стены до обвязки
EAVE_Z = 1.23                     # низ ската (по свесу)
RIDGE_Z = 2.50                    # конёк: скат ~42°, подобран перебором по IoU
OVER_GABLE = 0.18                 # свес крыши за торцы
OVER_EAVE = 0.16                  # свес крыши по скатам
A_ROOF = A_WALL + OVER_GABLE      # 1.26 — полудлина конька
B_ROOF = B_WALL + OVER_EAVE       # 1.34 — полупролёт ската
N_SEG = 17                        # сегментов овала в плане
N_ROWS = 6                        # рядов фасетов обмазки по высоте
N_SLAT = 23                       # дранок на скат
POST_STEP = 3                     # столб через каждые N сегментов овала

VIS = 0.02                        # насколько деталь выступает над обмазкой


# --------------------------------------------------------------------------
# ПОСТРОИТЕЛИ
# --------------------------------------------------------------------------
def slab(bm, center, size, rx=0.0, ry=0.0, rz=0.0):
    """Короб с центром в center: size — полные размеры по осям, потом повороты."""
    mat = (Matrix.Translation(center) @
           Matrix.Rotation(rz, 4, 'Z') @
           Matrix.Rotation(ry, 4, 'Y') @
           Matrix.Rotation(rx, 4, 'X') @
           Matrix.Diagonal((size[0], size[1], size[2], 1.0)))
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat)
    return bm


def boxg(bm, x, y, z, sx, sy, sz, rz=0.0, rx=0.0, ry=0.0):
    """Короб, стоящий на z: (x, y) — центр основания."""
    return P.add_box(bm, x, y, z, sx, sy, sz, rz, rx, ry)


def obj(bm, name, mat, jit=0.010, seed=1, tones=None):
    """Объект из bmesh. tones — список материалов: фасеты красятся по очереди."""
    if jit:
        P.jitter(bm, jit, seed)
    if tones:
        rnd = random.Random(seed * 977 + 13)
        for f in bm.faces:
            f.material_index = rnd.randrange(len(tones))
    ob = P.new_obj_from_bm(bm, name, tones[0] if tones else mat)
    for extra in (tones[1:] if tones else ()):
        ob.data.materials.append(extra)
    return ob


def oval_point(ang, k=1.0, z=0.0):
    return (math.cos(ang) * A_WALL * k, math.sin(ang) * B_WALL * k, z)


def oval_normal(ang):
    nx, ny = math.cos(ang) / A_WALL, math.sin(ang) / B_WALL
    n = math.hypot(nx, ny)
    return nx / n, ny / n


# --------------------------------------------------------------------------
# СТЕНА
# --------------------------------------------------------------------------
def wall_rings():
    """Кольца овала снизу вверх: у каждого ряда своя разбивка — фасеты кривые."""
    rnd = random.Random(7)
    rings = []
    for r in range(N_ROWS + 1):
        t = r / N_ROWS
        bulge = 1.0 + 0.055 * (1.0 - t) ** 1.5      # обмазка раздута книзу
        off = rnd.uniform(-0.10, 0.10)              # свой сдвиг разбивки на ряд
        pts = []
        for i in range(N_SEG):
            ang = 2 * math.pi * i / N_SEG + off + rnd.uniform(-0.10, 0.10)
            k = bulge * (1.0 + rnd.uniform(-0.035, 0.035))
            pts.append((math.cos(ang) * A_WALL * k,
                        math.sin(ang) * B_WALL * k,
                        WALL_H * t, ang))
        rings.append(pts)
    return rings


def build_wall():
    rings = wall_rings()
    bm = bmesh.new()
    grid = []
    for ring in rings:
        grid.append([bm.verts.new((x, y, z)) for x, y, z, _ in ring])
    bm.verts.ensure_lookup_table()
    for r in range(N_ROWS):
        for i in range(N_SEG):
            a, b = grid[r][i], grid[r][(i + 1) % N_SEG]
            c, d = grid[r + 1][(i + 1) % N_SEG], grid[r + 1][i]
            try:
                bm.faces.new((a, b, c, d))
            except ValueError:
                pass
    # днище и верх: закрыть, чтобы силуэт не светился на просвет
    bm.faces.new(list(reversed(grid[0])))
    bm.faces.new(grid[N_ROWS])
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    return obj(bm, 'wall', None, 0.034, 7, tones=M('clay'))


def build_skirt():
    """Земляная завалинка по низу: обмазка чуть шире и темнее."""
    bm = bmesh.new()
    for i in range(N_SEG):
        a0 = 2 * math.pi * i / N_SEG
        a1 = 2 * math.pi * (i + 1) / N_SEG
        p0, p1 = oval_point(a0, 1.035, 0.0), oval_point(a1, 1.035, 0.0)
        vs = [bm.verts.new(p0), bm.verts.new(p1),
              bm.verts.new((p1[0], p1[1], 0.07)), bm.verts.new((p0[0], p0[1], 0.07))]
        try:
            bm.faces.new(vs)
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    ob = obj(bm, 'skirt', M('clay_d'), 0.012, 8)
    # слой обмазки поверх — тем же материалом, но фасетами
    return ob


# --------------------------------------------------------------------------
# КАРКАС: СТОЛБЫ И ОБВЯЗКА
# --------------------------------------------------------------------------
POST_ANGLES = [2 * math.pi * i / N_SEG for i in range(0, N_SEG, POST_STEP)]


def build_posts():
    bm = bmesh.new()
    h = WALL_H - 0.08
    for ang in POST_ANGLES:
        nx, ny = oval_normal(ang)
        x, y, _ = oval_point(ang, 1.0)
        cx, cy = x + nx * VIS, y + ny * VIS
        rz = math.atan2(ny, nx) - math.pi / 2
        boxg(bm, cx, cy, -0.05, 0.085, 0.085, h + 0.05, rz=rz)
    return [obj(bm, 'posts', M('timber'), 0.009, 11)]


def build_bond():
    """Обвязка по верху стены: венец, на который легли скаты."""
    bm = bmesh.new()
    z = WALL_H - 0.12
    for i in range(N_SEG):
        ang = 2 * math.pi * (i + 0.5) / N_SEG
        nx, ny = oval_normal(ang)
        x, y, _ = oval_point(ang, 1.0)
        seg = 2 * math.pi * A_WALL / N_SEG
        rz = math.atan2(ny, nx) - math.pi / 2
        boxg(bm, x, y, z, 0.13, seg * 1.25, 0.13, rz=rz)
    return [obj(bm, 'bond', M('timber_d'), 0.008, 12)]


# --------------------------------------------------------------------------
# КРЫША
# --------------------------------------------------------------------------
def slope_angle():
    return math.atan2(RIDGE_Z - EAVE_Z, B_ROOF)


def build_roof_slab():
    """Сплошной настил под дранкой + тёсовая заделка торцов и конёк."""
    out = []
    ang = slope_angle()
    bm = bmesh.new()
    for sy in (1, -1):
        P.add_quad(bm, [(-A_ROOF, 0.0, RIDGE_Z - 0.03), (A_ROOF, 0.0, RIDGE_Z - 0.03),
                        (A_ROOF, sy * B_ROOF, EAVE_Z - 0.03),
                        (-A_ROOF, sy * B_ROOF, EAVE_Z - 0.03)])
    out.append(obj(bm, 'roof_deck', M('thatch_u'), 0.014, 19))

    # торцы скатов: у крыши есть толщина, снизу видно торец настила
    bm = bmesh.new()
    th = 0.075
    for sx in (-1, 1):
        for sy in (1, -1):
            P.add_quad(bm, [(sx * A_ROOF, 0.0, RIDGE_Z - 0.03),
                            (sx * A_ROOF, 0.0, RIDGE_Z - 0.03 - th),
                            (sx * A_ROOF, sy * B_ROOF, EAVE_Z - 0.03 - th),
                            (sx * A_ROOF, sy * B_ROOF, EAVE_Z - 0.03)])
    out.append(obj(bm, 'roof_deck_end', M('thatch_u'), 0.008, 20))

    # коньковый брус
    bm = bmesh.new()
    boxg(bm, 0.0, 0.0, RIDGE_Z - 0.02, 2 * A_ROOF + 0.06, 0.24, 0.095)
    out.append(obj(bm, 'ridge', M('timber_d'), 0.008, 21))

    # тёсовая обвязка торцов: брус по каждому скату у самого края
    bm = bmesh.new()
    L = math.hypot(RIDGE_Z - EAVE_Z, B_ROOF) + 0.10
    for sx in (-1, 1):
        for sy in (1, -1):
            cx = sx * (A_ROOF + 0.015)
            cy = sy * B_ROOF / 2
            cz = (RIDGE_Z + EAVE_Z) / 2 + 0.035
            slab(bm, (cx, cy, cz), (0.075, L, 0.10), rx=-sy * ang)
    out.append(obj(bm, 'barge', M('timber_d'), 0.008, 22))
    return out


def build_thatch():
    """Дранки вдоль ската: узкие дощечки с рваными концами и тёмными швами."""
    out = []
    ang = slope_angle()
    rnd = random.Random(23)
    tones = [M('thatch_a'), M('thatch_b'), M('thatch_c')]
    bms = [bmesh.new() for _ in tones]
    pitch = 2 * A_ROOF / N_SLAT
    L = math.hypot(RIDGE_Z - EAVE_Z, B_ROOF)
    for sy in (1, -1):
        for i in range(N_SLAT):
            bm = bms[rnd.randrange(3)]
            x = -A_ROOF + pitch * (i + 0.5) + rnd.uniform(-0.010, 0.010)
            w = pitch * rnd.uniform(0.70, 0.84)
            # дранка идёт от конька до свеса, концы гуляют
            t0 = rnd.uniform(-0.04, 0.08)
            t1 = rnd.uniform(0.94, 1.18)
            tc = (t0 + t1) / 2
            ln = (t1 - t0) * L
            cy = sy * B_ROOF * tc
            cz = RIDGE_Z - (RIDGE_Z - EAVE_Z) * tc + 0.05
            th = rnd.uniform(0.050, 0.066)
            slab(bm, (x, cy, cz), (w, ln, th), rx=-sy * ang)
            # настилка поверх: на части дранок ещё один короткий ряд со сдвигом
            if rnd.random() < 0.45:
                t = rnd.uniform(0.15, 0.75)
                ln2 = L * rnd.uniform(0.18, 0.34)
                slab(bm, (x + rnd.uniform(-0.012, 0.012), sy * B_ROOF * t,
                          RIDGE_Z - (RIDGE_Z - EAVE_Z) * t + 0.05 + th * 0.95),
                     (w * rnd.uniform(0.85, 1.0), ln2, th * 0.75), rx=-sy * ang)
            # концы дранок торчат над коньковым брусом
            if rnd.random() < 0.5:
                slab(bm, (x, sy * B_ROOF * 0.02, RIDGE_Z + 0.052),
                     (w * 0.9, 0.17, th), rx=-sy * ang)
    for bm, mat, name in zip(bms, tones, 'abc'):
        out.append(obj(bm, 'thatch_' + name, mat, 0.011, 31 + 'abc'.index(name)))
    return out


def build_gable_fill():
    """Заделка торцов под крышей: щипцовые треугольники обмазки (скрыты свесом)."""
    bm = bmesh.new()
    for sx in (-1, 1):
        pts = [(-B_WALL - 0.10, WALL_H - 0.06), (B_WALL + 0.10, WALL_H - 0.06),
               (0.0, RIDGE_Z - 0.10)]
        vs = [bm.verts.new((sx * (A_WALL - 0.06), y, z)) for y, z in pts]
        try:
            f = bm.faces.new(vs)
            r = bmesh.ops.extrude_face_region(bm, geom=[f])
            verts = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
            bmesh.ops.translate(bm, verts=verts, vec=(-sx * 0.11, 0, 0))
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    return [obj(bm, 'gable', M('clay_c'), 0.014, 41)]


# --------------------------------------------------------------------------
# ДВЕРЬ
# --------------------------------------------------------------------------
# Дверь ставится в КОНЕЧНОЙ системе координат: конёк идёт по Y, полуоси овала
# RX (по X) и RY (по Y). Угол 145° — левый-передний сектор овала, как на эталоне.
RX, RY = B_WALL, A_WALL
DOOR_PHI = math.radians(145.0)
DOOR_W = 0.68
DOOR_H = 1.00


def door_place():
    """Точка на овале, нормаль наружу и поворот рамы двери."""
    x = RX * math.cos(DOOR_PHI)
    y = RY * math.sin(DOOR_PHI)
    nx, ny = math.cos(DOOR_PHI) / RX, math.sin(DOOR_PHI) / RY
    n = math.hypot(nx, ny)
    nx, ny = nx / n, ny / n
    rz = math.atan2(ny, nx) - math.pi / 2       # поворот +Y к нормали
    return x, y, nx, ny, rz


def build_door():
    out = []
    cx, cy, nx, ny, rz = door_place()
    tx, ty = ny, -nx                            # вдоль стены

    def place(u, v):
        return (cx + tx * u + nx * v, cy + ty * u + ny * v)

    # тёмный проём вплотную к обмазке
    bm = bmesh.new()
    p = place(0.0, VIS)
    boxg(bm, p[0], p[1], 0.0, DOOR_W, 0.07, DOOR_H, rz=rz)
    out.append(obj(bm, 'door_hole', M('dark'), 0.004, 51))

    # стойки и перекладина поверх обмазки
    bm = bmesh.new()
    for s in (-1, 1):
        p = place(s * (DOOR_W / 2 + 0.075), 0.085)
        boxg(bm, p[0], p[1], -0.04, 0.150, 0.180, DOOR_H + 0.14, rz=rz)
    p = place(0.0, 0.095)
    boxg(bm, p[0], p[1], DOOR_H - 0.02, DOOR_W + 0.44, 0.190, 0.165, rz=rz)
    out.append(obj(bm, 'door_frame', M('timber'), 0.008, 52))

    # полог из шкуры: висит внутри проёма, нижний уголок срезан
    bm = bmesh.new()
    pts = [(-0.22, 0.92), (0.18, 0.90), (0.14, 0.36), (0.0, 0.12), (-0.15, 0.32)]
    vs = [bm.verts.new((x, 0.0, z)) for x, z in pts]
    f = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    verts = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=verts, vec=(0, -0.04, 0))
    bmesh.ops.rotate(bm, verts=list(bm.verts), cent=(0, 0, 0),
                     matrix=Matrix.Rotation(rz, 3, 'Z'))
    p = place(0.0, VIS + 0.045)
    bmesh.ops.translate(bm, verts=list(bm.verts), vec=(p[0], p[1], 0.03))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    out.append(obj(bm, 'door_hide', M('hide'), 0.009, 53))
    return out


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def set_params(**kw):
    """Переопределить размеры на лету (перебор вариантов, подгонка под эталон)."""
    global A_WALL, B_WALL, WALL_H, EAVE_Z, RIDGE_Z, OVER_GABLE, OVER_EAVE
    global A_ROOF, B_ROOF, RX, RY
    for k, v in kw.items():
        globals()[k] = v
    A_ROOF = A_WALL + OVER_GABLE
    B_ROOF = B_WALL + OVER_EAVE
    RX, RY = B_WALL, A_WALL


def build(name='h'):
    """Остов собирается с коньком по X, затем поворачивается на 90° — конёк по Y.

    Так скат уходит вправо-вниз, а торец с дверью смотрит влево-вперёд:
    ровно то, что видно на эталонном рендере.
    """
    core = [build_wall(), build_skirt()]
    core += build_posts()
    core += build_bond()
    core += build_gable_fill()
    core += build_roof_slab()
    core += build_thatch()
    core = [o for o in core if o is not None]
    for o in core:
        o.rotation_euler.z += math.radians(90.0)
    P.apply_transforms(core)
    objs = core + build_door()          # дверь — уже в конечной системе
    P.apply_transforms(objs)
    return objs


BUILDERS = {'h': build}
