# -*- coding: utf-8 -*-
"""building.py — деревенская КУЗНИЦА 2 x 2 клетки для mapgen2 (4tox).

ЧИСТЫЙ Python: ни одной строки bpy. Форма живёт здесь, Blender её только
исполняет и рисует (tools/build_live.py). Так форму можно измерить числом и
повторить (канон скилла 4tox-house-3d: «геометрия — в чистом Python»).

    import building
    parts = building.build()             # вариант по умолчанию ('a')
    building.stats(parts)                # {'parts': .., 'verts': .., 'tris': ..}
    building.bounds(parts)               # габарит по осям

Деталь — это dict(name, family, verts, faces):
    name   — имя детали (отчёт, листы сверки, разбор полётов);
    family — семейство палитры атласа: trunk, stone, skin, leaf_autumn,
             grass, iron, leather. Тон фасета считается по нормали
             (canon.facet_tone), поэтому семья — это всё, что нужно материалу;
    verts  — [(x, y, z), ...] в юнитах карты (1 юнит = 1 клетка), Z вверх,
             низ постройки на z = 0, центр пятна в (0, 0, 0);
    faces  — [(i, j, k[, l]), ...], индексы в verts, нормали НАРУЖУ.

Канон, которого держится эта кузница (скилл 4tox-house-3d, house-canon.md):
    * пятно 2 x 2, X — длинная сторона, фасад с воротцами смотрит в +Y;
    * каменный цоколь 0.16 высотой с выступом 0.06 и швами 0.025;
    * стены 1.70 x 1.40, высота 1.22 (обмазка `skin`) + деревянный каркас
      `trunk`: нижняя и верхняя обвязка, угловые и промежуточные стойки,
      раскосы 45°, каркас щипца;
    * широкие воротца 0.90 x 1.02 из ДВУХ створок с железными накладками и
      кольцом, одно окно 0.26 x 0.26 с переплётом 2 x 2 и тёмным стеклом;
    * двускатная кровля 47° (солома — геометрия: пласты, а не текстура),
      свес по скату 14% глубины стены, по торцу 8% длины стены;
    * каменная труба кузнечного горна, смещена от конька;
    * навес над воротцами на двух подкосах;
    * бюджет класса `building` — 300..1500 треугольников.
"""

import math
import random

# --------------------------------------------------------------------------
# ПАЛИТРА: семейства, которыми разрешено краситься этой постройке
# --------------------------------------------------------------------------
FAMILIES = ('trunk', 'stone', 'skin', 'leaf_autumn', 'grass', 'iron', 'leather')

# --------------------------------------------------------------------------
# ПЯТНО И ЯРУСЫ (юниты карты; канон — house-canon.md, раздел 2)
# --------------------------------------------------------------------------
FP = 2.00                       # пятно застройки 2 x 2 клетки
HX = 0.85                       # полуширина стены по X (стена 1.70)
HY = 0.70                       # полуглубина стены по Y (стена 1.40)
PL_H = 0.16                     # высота каменного цоколя (канон 0.15..0.16)
PL_OUT = 0.06                   # выступ цоколя за плоскость стены (канон 0.06)
PL_SEAM = 0.025                 # шов между блоками цоколя (канон 0.02..0.03)

WALL_Z0 = PL_H                  # 0.16 — стены стоят на цоколе
WALL_H = 1.22                   # высота стен (канон 1.35 у дома 3 x 2; кузница ниже)
WALL_Z1 = WALL_Z0 + WALL_H      # 1.38 — верх стен

# --------------------------------------------------------------------------
# КАРКАС (trunk): стойки, обвязки, раскосы
# --------------------------------------------------------------------------
FR_OUT = 0.045                  # выступ каркаса из плоскости стены (канон 0.05)
FR_T = 0.090                    # толщина бруса каркаса
CP = 0.130                      # угловая стойка (канон 0.12..0.14)
MP = 0.100                      # промежуточная стойка (канон 0.10)
PLATE_H = 0.130                 # высота обвязки (нижней и верхней)
BRACE = 0.085                   # брус раскоса

# --------------------------------------------------------------------------
# КРОВЛЯ
# --------------------------------------------------------------------------
ROOF_GAP = 0.060                # просвет «верх стены -> низ кровли» у стены
ROOF_T = 0.095                  # тело кровли (канон 0.08..0.12)
N_PLAST = 5                     # пластов соломы на скат (канон 6..14; у нас
                                # пласт шире, зато их меньше — крупные фасеты)
PLAST_T = 0.045                 # толщина пласта соломы

# --------------------------------------------------------------------------
# ПРОЁМЫ И ДЕТАЛИ
# --------------------------------------------------------------------------
GATE_W = 0.90                   # воротца: ширина проёма (две створки)
GATE_H = 1.02                   # высота проёма
GATE_LEAF_T = 0.050             # толщина створки
JAMB = 0.045                    # косяк: ширина наличника
WIN = 0.26                      # окно (канон 0.26)
WIN_BAR = 0.040                 # планка рамы
WIN_GLASS = 0.030               # стекло утоплено в раму
CHIM_X = -0.42                  # труба смещена от середины конька (канон 0.3..0.6)
CHIM_Y = 0.20                   # ... и стоит на скате, а не на коньке


# ==========================================================================
# ПРИМИТИВЫ. Всё — «труба» между двумя кольцами из 4+ вершин, поэтому
# замкнутость и наружные нормали получаются сами, без bmesh.
# ==========================================================================
def _shoelace(poly_yz):
    s = 0.0
    n = len(poly_yz)
    for i in range(n):
        y0, z0 = poly_yz[i]
        y1, z1 = poly_yz[(i + 1) % n]
        s += y0 * z1 - y1 * z0
    return s


def _tube(ring_a, ring_b):
    """Замкнутая призма между двумя кольцами равной длины.

    Кольцо задано ПРОТИВ ЧАСОВОЙ вокруг направления a -> b. Тогда боковые квады
    [a_i, a_j, b_j, b_i] смотрят наружу, а крышки обязаны идти: у `a` — в
    обратном порядке (её нормаль -d), у `b` — в прямом (+d). Направление крышек
    тут принципиально: перепутаешь — каждое ребро кольца достанется двум граням
    в одну сторону, меш перестанет быть замкнутым, а объём уйдёт в минус
    (ловится tools/report.py).
    """
    n = len(ring_a)
    verts = list(ring_a) + list(ring_b)
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    faces.append(tuple(range(n - 1, -1, -1)))          # крышка a, нормаль -d
    faces.append(tuple(range(n, 2 * n)))               # крышка b, нормаль +d
    return verts, faces


def _ring_z(cx, cy, z, sx, sy):
    """Кольцо бокса против часовой вокруг +Z."""
    hx, hy = sx / 2.0, sy / 2.0
    return [(cx - hx, cy - hy, z), (cx + hx, cy - hy, z),
            (cx + hx, cy + hy, z), (cx - hx, cy + hy, z)]


def _rot(pts, c, rz=0.0, rx=0.0, ry=0.0):
    """Поворот точек вокруг центра c: сначала Z, потом X, потом Y."""
    if not (rz or rx or ry):
        return [tuple(p) for p in pts]
    cx, cy, cz = c
    out = []
    for x, y, z in pts:
        x, y, z = x - cx, y - cy, z - cz
        if rz:
            s, k = math.sin(rz), math.cos(rz)
            x, y = x * k - y * s, x * s + y * k
        if rx:
            s, k = math.sin(rx), math.cos(rx)
            y, z = y * k - z * s, y * s + z * k
        if ry:
            s, k = math.sin(ry), math.cos(ry)
            x, z = x * k + z * s, -x * s + z * k
        out.append((x + cx, y + cy, z + cz))
    return out


def box(cx, cy, z0, sx, sy, sz, rz=0.0, rx=0.0, ry=0.0):
    """Бокс: центр по X/Y, низ по z0, размеры sx/sy/sz, поворот вокруг центра."""
    a = _ring_z(cx, cy, z0, sx, sy)
    b = _ring_z(cx, cy, z0 + sz, sx, sy)
    verts, faces = _tube(a, b)
    if rz or rx or ry:
        verts = _rot(verts, (cx, cy, z0 + sz / 2.0), rz, rx, ry)
    return verts, faces


def frustum(cx, cy, z0, z1, sx0, sy0, sx1, sy1, rz=0.0):
    """Усечённая пирамида: цоколь, кожух горна, ствол трубы."""
    verts, faces = _tube(_ring_z(cx, cy, z0, sx0, sy0),
                         _ring_z(cx, cy, z1, sx1, sy1))
    if rz:
        verts = _rot(verts, (cx, cy, (z0 + z1) / 2.0), rz)
    return verts, faces


def prism_x(poly_yz, x0, x1):
    """Полигон в плоскости YZ, протянутый по X (скаты, пласты соломы, конёк)."""
    poly = list(poly_yz)
    if _shoelace(poly) < 0:
        poly.reverse()
    a = [(x0, y, z) for y, z in poly]
    b = [(x1, y, z) for y, z in poly]
    return _tube(a, b)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def beam(p0, p1, w, h, plane='xz'):
    """Брус между точками: раскосы, подкосы, лобовые доски, поленья.

    plane='xz' — брус лежит в плоскости y = const, w — толщина по Y;
    plane='yz' — брус лежит в плоскости x = const, w — толщина по X;
    h — толщина бруса поперёк его оси внутри этой плоскости.
    """
    d = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    ln = math.sqrt(sum(c * c for c in d)) or 1.0
    d = tuple(c / ln for c in d)
    v = (0.0, 1.0, 0.0) if plane == 'xz' else (1.0, 0.0, 0.0)   # поперёк плоскости
    u = _cross(v, d)                                            # внутри плоскости
    un = math.sqrt(sum(c * c for c in u)) or 1.0
    u = tuple(c / un for c in u)                                # u x v = d

    def ring(t):
        cx = p0[0] + d[0] * ln * t
        cy = p0[1] + d[1] * ln * t
        cz = p0[2] + d[2] * ln * t
        out = []
        for a, b in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
            out.append((cx + u[0] * a * h / 2.0 + v[0] * b * w / 2.0,
                        cy + u[1] * a * h / 2.0 + v[1] * b * w / 2.0,
                        cz + u[2] * a * h / 2.0 + v[2] * b * w / 2.0))
        return out

    return _tube(ring(0.0), ring(1.0))


def part(parts, name, family, prim, jit=0.0, rng=None, axis=None):
    """Добавить деталь в список: (verts, faces) -> dict с именем и семейством.

    Джиттер (асимметрия 1..3% габарита — канон стиля) не имеет права увести
    деталь под землю: низ постройки обязан остаться на z = 0, иначе спрайт
    «утонет» в клетке. Поэтому z подрезается снизу.
    """
    assert family in FAMILIES, 'семейство вне палитры: %s' % family
    verts, faces = prim
    if jit and rng is not None:
        out = []
        for (x, y, z) in verts:
            dx = rng.uniform(-jit, jit) if axis in (None, 'x') else 0.0
            dy = rng.uniform(-jit, jit) if axis in (None, 'y') else 0.0
            dz = rng.uniform(-jit, jit) if axis in (None, 'z') else 0.0
            out.append((x + dx, y + dy, max(0.0, z + dz)))
        verts = out
    verts = [(x, y, max(0.0, z)) for (x, y, z) in verts]
    parts.append(dict(name=name, family=family, verts=verts, faces=faces))
    return parts[-1]


# ==========================================================================
# ГЕОМЕТРИЯ ПОСТРОЙКИ: производные числа от уклона и свесов
# ==========================================================================
class Geo(object):
    """Производные числа кузницы: конёк, кромка ската, плоскость кровли."""

    def __init__(self, pitch_deg, over_slope, over_end, wall_h=WALL_H,
                 gate_w=GATE_W, gate_h=GATE_H, win_wall='-x', win_u=-0.18):
        self.pitch = math.radians(pitch_deg)
        self.tan = math.tan(self.pitch)
        self.cos = math.cos(self.pitch)
        self.sin = math.sin(self.pitch)
        self.wall_h = wall_h
        self.z_wall1 = WALL_Z0 + wall_h
        self.over_slope = over_slope
        self.over_end = over_end
        self.z_ridge = self.z_wall1 + ROOF_GAP + HY * self.tan
        self.y_eave = HY + over_slope
        self.z_eave = self.z_ridge - self.y_eave * self.tan
        self.x_barge = HX + over_end
        self.gate_w = gate_w
        self.gate_h = gate_h
        self.win_wall = win_wall          # на какой стене окно ('-x' или '+y')
        self.win_u = win_u                # где именно по стене

    # --- плоскость ската: s — вдоль ската от конька, o — по нормали наружу ---
    def roof_yz(self, s, o, sign=1):
        y = s * self.cos + o * self.sin
        z = self.z_ridge - s * self.sin + o * self.cos
        return (sign * y, z)

    def roof_z(self, y):
        """Высота ПОВЕРХНОСТИ кровли над координатой |y| (для посадки трубы)."""
        return self.z_ridge - abs(y) * self.tan

    def slope_len(self):
        return self.y_eave / self.cos


# ==========================================================================
# СТЕНЫ: локальная система координат стены (u — вдоль, v — наружу от плоскости)
# ==========================================================================
def wall_pt(wall, u, v, z):
    """Точка на стене: u — вдоль стены, v — НАРУЖУ от её плоскости.

    Плоскость стены подписана знаком: у стены `-Y` точка с выступом v лежит на
    `y = -(HY + v)`, а не на `HY - v`. Разница не косметическая: со старым
    знаком весь каркас тыла (`-Y`) и окно на торце (`-X`) уезжали на
    ПРОТИВОПОЛОЖНУЮ стену — фасад получал два каркаса, а нужная стена стояла
    голой. Поймано своим софт-рендером (tools/softrender.py, вид `left`).
    """
    axis, sign, half = wall
    if axis == 'y':
        return (u, sign * (half + v), z)
    return (sign * (half + v), u, z)


def wall_prim(wall, prim):
    """Бокс, собранный в локальных (u, v, z), -> мировые координаты.

    Отображение локальной системы стены в мир для половины стен зеркальное
    (det < 0), а зеркало меняет ориентацию граней: без разворота обхода нормали
    у такой стены смотрят ВНУТРЬ. Ловится объёмом детали в tools/report.py, а
    видно это ещё и по тону фасета — он считается по нормали.
    """
    axis, sign, _plane = wall
    verts, faces = prim
    flip = (sign < 0) if axis == 'y' else (sign > 0)
    if flip:
        faces = [tuple(reversed(f)) for f in faces]
    return [wall_pt(wall, x, y, z) for x, y, z in verts], faces


def wall_box(wall, u, z0, su, sv, sz, v0=0.0, rz=0.0):
    """Бокс на стене: центр по u, низ z0, выступ v0, размеры su/sv/sz."""
    return wall_prim(wall, box(u, v0 + sv / 2.0, z0, su, sv, sz, rz=rz))


def wall_beam(wall, p0, p1, w, h):
    """Брус на стене (в плоскости стены): p0/p1 — (u, v, z)."""
    return wall_prim(wall, beam(p0, p1, w, h, plane='xz'))


# ==========================================================================
# ЯРУС 1. КАМЕННЫЙ ЦОКОЛЬ
# ==========================================================================
def build_plinth(parts, g, rng, n_long=4, n_short=3):
    """Ядро цоколя + блоки по периметру со швом и случайным наклоном."""
    part(parts, 'plinth_core', 'stone',
         box(0, 0, 0.0, 2 * HX, 2 * HY, PL_H), jit=0.004, rng=rng)
    z0, h = 0.006, 0.145
    for sign in (1, -1):
        # длинные стены: блоки идут с заходом за угол, чтобы закрыть стык
        span = 2 * HX + 0.12
        bw = (span - (n_long + 1) * PL_SEAM) / float(n_long)
        u = -span / 2.0 + PL_SEAM
        for i in range(n_long):
            cu = u + bw / 2.0
            part(parts, 'plinth_block_%s%d' % ('p' if sign > 0 else 'm', i), 'stone',
                 box(cu, sign * (HY + PL_OUT / 2.0), z0, bw, PL_OUT, h,
                     rz=math.radians(rng.uniform(-2.5, 2.5))))
            u += bw + PL_SEAM
        # торцы
        span = 2 * HY + 0.12
        bw = (span - (n_short + 1) * PL_SEAM) / float(n_short)
        u = -span / 2.0 + PL_SEAM
        for i in range(n_short):
            cu = u + bw / 2.0
            part(parts, 'plinth_block_%s%d' % ('x' if sign > 0 else 'n', i), 'stone',
                 box(sign * (HX + PL_OUT / 2.0), cu, z0, PL_OUT, bw, h,
                     rz=math.radians(rng.uniform(-2.5, 2.5))))
            u += bw + PL_SEAM


# ==========================================================================
# ЯРУС 2. СТЕНЫ (обмазка) И ЩИПЦЫ
# ==========================================================================
def build_walls(parts, g, rng):
    """Стены — усечённая призма (верх шире низа на ~1.5°: плоскость не линейка)."""
    lean = 0.018
    part(parts, 'walls', 'skin',
         frustum(0, 0, WALL_Z0, g.z_wall1,
                 2 * HX, 2 * HY, 2 * (HX + lean), 2 * (HY + lean)),
         jit=0.0035, rng=rng)
    # Щипцы (фронтоны) на торцах: пятиугольник до низа кровли
    for sign in (1, -1):
        poly = [(-HY, g.z_wall1 - 0.02), (HY, g.z_wall1 - 0.02),
                (HY, g.z_wall1 + ROOF_GAP),
                (0.0, g.z_ridge - 0.012),
                (-HY, g.z_wall1 + ROOF_GAP)]
        x_out = sign * (HX + lean)
        x_in = sign * (HX - 0.10)
        part(parts, 'gable_%s' % ('p' if sign > 0 else 'm'), 'skin',
             prism_x(poly, min(x_in, x_out), max(x_in, x_out)))


# ==========================================================================
# ЯРУС 3. ДЕРЕВЯННЫЙ КАРКАС: обвязки, стойки, раскосы
# ==========================================================================
def build_frame(parts, g):
    """Нижняя и верхняя обвязка, угловые и промежуточные стойки, раскосы 45°."""
    walls = {'+y': ('y', 1, HY), '-y': ('y', -1, HY),
             '+x': ('x', 1, HX), '-x': ('x', -1, HX)}

    # --- обвязки: нижняя на цоколе, верхняя под кровлей ---
    for tag, wall in walls.items():
        along = 2 * HX + FR_T if wall[0] == 'y' else 2 * HY + FR_T
        for z0, name in ((WALL_Z0 + 0.010, 'plate_low'), (g.z_wall1 - PLATE_H, 'plate_top')):
            part(parts, '%s_%s' % (name, tag), 'trunk',
                 wall_box(wall, 0.0, z0, along, FR_T, PLATE_H, v0=FR_OUT - FR_T))

    # --- угловые стойки ---
    for sx in (1, -1):
        for sy in (1, -1):
            cu_x = sx * (HX + FR_OUT - CP / 2.0)
            cu_y = sy * (HY + FR_OUT - CP / 2.0)
            part(parts, 'post_corner_%s%s' % ('p' if sx > 0 else 'm',
                                              'p' if sy > 0 else 'm'), 'trunk',
                 box(cu_x, cu_y, WALL_Z0, CP, CP, g.wall_h))

    # --- промежуточные стойки ---
    gw = g.gate_w / 2.0
    studs = [('y', 1, HY, 0.0, gw + JAMB + MP / 2.0 + 0.04, (1, -1)),
             ('y', -1, HY, 0.0, 0.62, (1, -1)),
             ('x', 1, HX, 0.0, 0.34, (1, -1)),
             ('x', -1, HX, 0.0, 0.40, (1, -1))]   # не под окном: см. win_u
    for axis, sign, plane, _c, off, sgns in studs:
        wall = (axis, sign, plane)
        if abs(off) > 0.05 and len(sgns) == 2:
            us = (off, -off) if axis == 'y' else (off,)
        else:
            us = (off,)
        for k, u in enumerate(us):
            part(parts, 'post_%s%d' % ('p' if sign > 0 else 'm', k), 'trunk',
                 wall_box(wall, u, WALL_Z0, MP, FR_T, g.wall_h, v0=FR_OUT - FR_T))

    # --- раскосы 45° в верхних углах панелей (канон: «раскосы ровно под 45°») ---
    z_hi = g.z_wall1 - PLATE_H
    z_lo = z_hi - 0.30
    braces = {
        '+y': [(-(gw + 0.13), z_lo, -(HX - CP / 2.0 - 0.02), z_hi),
               ((gw + 0.13), z_lo, (HX - CP / 2.0 - 0.02), z_hi)],
        '-y': [(-0.55, z_lo, -(HX - 0.10), z_hi), (0.55, z_lo, (HX - 0.10), z_hi)],
        '+x': [(0.34, z_lo, (HY - 0.06), z_hi), (-0.30, z_lo, -(HY - 0.06), z_hi)],
        '-x': [(0.34, z_lo, (HY - 0.06), z_hi), (-0.30, z_lo, -(HY - 0.06), z_hi)],
    }
    for tag, items in braces.items():
        wall = walls[tag]
        for i, (u0, zz0, u1, zz1) in enumerate(items):
            if abs(u1 - u0) < 0.08 or abs(zz1 - zz0) < 0.08:
                continue
            part(parts, 'brace_%s%d' % (tag.strip('+-'), i), 'trunk',
                 wall_beam(wall, (u0, FR_OUT - FR_T / 2.0, zz0),
                           (u1, FR_OUT - FR_T / 2.0, zz1), FR_T, BRACE))

    # --- каркас щипца: центральная стойка и два раскоса в неё ---
    for sign in (1, -1):
        wall = ('x', sign, HX)
        z_base = g.z_wall1 - PLATE_H / 2.0
        z_top = g.z_wall1 + 0.52
        part(parts, 'gable_post_%s' % ('p' if sign > 0 else 'm'), 'trunk',
             wall_box(wall, 0.0, z_base, MP, FR_T, z_top - z_base,
                      v0=FR_OUT - FR_T))
        for i, u0 in enumerate((0.44, -0.44)):
            part(parts, 'gable_brace_%s%d' % ('p' if sign > 0 else 'm', i), 'trunk',
                 wall_beam(wall, (u0, FR_OUT - FR_T / 2.0, z_base + 0.02),
                           (0.02 * (1 if u0 > 0 else -1), FR_OUT - FR_T / 2.0, z_top - 0.06),
                           FR_T, BRACE))


# ==========================================================================
# ЯРУС 4. ВОРОТЦА (две створки) И ОКНО
# ==========================================================================
def build_gate(parts, g):
    """Широкие воротца: косяк, порог, две створки с досками, железо."""
    wall = ('y', 1, HY)
    gw, gh = g.gate_w, g.gate_h
    z0 = WALL_Z0
    # косяк: две стойки и перекладина
    for i, u in enumerate((-(gw / 2.0 + JAMB / 2.0), (gw / 2.0 + JAMB / 2.0))):
        part(parts, 'gate_jamb_%d' % i, 'trunk',
             wall_box(wall, u, z0 - 0.02, JAMB, FR_T, gh + 0.10, v0=0.0))
    part(parts, 'gate_lintel', 'trunk',
         wall_box(wall, 0.0, z0 + gh + 0.02, gw + 2 * JAMB, FR_T, 0.09, v0=0.0))
    # каменный порог
    part(parts, 'gate_sill', 'stone',
         wall_box(wall, 0.0, z0 - 0.05, gw + 0.26, 0.15, 0.06, v0=-0.03))
    # створки: тёмное полотно (кожа/просмолённая доска) + светлые доски на лице
    # + железо. Полотно ДРУГОГО семейства, чем доски: иначе створка читается
    # одним тёмным пятном и воротца превращаются в дыру (проверено кадром).
    leaf_w = gw / 2.0 - 0.008
    for side in (1, -1):
        cu = side * (leaf_w / 2.0 + 0.006)
        face = 0.020                                   # лицо створки от стены
        part(parts, 'gate_leaf_%s' % ('p' if side > 0 else 'm'), 'leather',
             wall_box(wall, cu, z0 + 0.02, leaf_w, GATE_LEAF_T, gh - 0.02, v0=face))
        for k, du in enumerate((-0.145, 0.0, 0.145)):
            part(parts, 'gate_board_%s%d' % ('p' if side > 0 else 'm', k), 'trunk',
                 wall_box(wall, cu + du, z0 + 0.03, 0.095, 0.026, gh - 0.05,
                          v0=face + GATE_LEAF_T))
        # железная накладка-жиковина у петель
        part(parts, 'gate_hinge_%s' % ('p' if side > 0 else 'm'), 'iron',
             wall_box(wall, cu + side * (leaf_w / 2.0 - 0.075), z0 + gh - 0.22,
                      0.085, 0.028, 0.20, v0=face + GATE_LEAF_T + 0.026))
        # кованый раскос створки
        part(parts, 'gate_brace_%s' % ('p' if side > 0 else 'm'), 'iron',
             wall_beam(wall, (cu - leaf_w / 2.0 + 0.05, face + GATE_LEAF_T + 0.03, z0 + 0.10),
                       (cu + leaf_w / 2.0 - 0.05, face + GATE_LEAF_T + 0.03, z0 + gh - 0.12),
                       0.026, 0.050))
    # кольцо и ручка на стыке створок
    part(parts, 'gate_ring', 'iron',
         wall_box(wall, 0.0, z0 + 0.50, 0.085, 0.035, 0.085,
                  v0=0.020 + GATE_LEAF_T + 0.020))


def build_window(parts, g, rng=None):
    """Одно окно: рама, переплёт 2 x 2, тёмное стекло, каменный подоконник."""
    axis = g.win_wall[1]
    sign = 1 if g.win_wall[0] == '+' else -1
    plane = HX if axis == 'x' else HY
    wall = (axis, sign, plane)
    w = WIN
    zc = WALL_Z0 + 0.42 * g.wall_h            # центр окна (канон: 0.42 стены)
    z0 = zc - w / 2.0
    u = g.win_u
    # рама: 4 планки
    for i, (du, dz, su, sz) in enumerate((
            (-(w / 2.0 + WIN_BAR / 2.0), z0 - WIN_BAR, WIN_BAR, w + 2 * WIN_BAR),
            ((w / 2.0 + WIN_BAR / 2.0), z0 - WIN_BAR, WIN_BAR, w + 2 * WIN_BAR),
            (0.0, z0 + w, w + 2 * WIN_BAR, WIN_BAR),
            (0.0, z0 - WIN_BAR, w + 2 * WIN_BAR, WIN_BAR))):
        part(parts, 'win_frame_%d' % i, 'trunk',
             wall_box(wall, u + du, dz, su, FR_T, sz, v0=0.0))
    # переплёт 2 x 2
    part(parts, 'win_mullion_v', 'trunk',
         wall_box(wall, u, z0, 0.032, 0.030, w, v0=FR_OUT - 0.030))
    part(parts, 'win_mullion_h', 'trunk',
         wall_box(wall, u, zc - 0.016, w, 0.030, 0.032, v0=FR_OUT - 0.030))
    # стекло: тёмное (канон: светлое стекло «слепит» фасад)
    part(parts, 'win_glass', 'iron',
         wall_box(wall, u, z0 + 0.01, w - 0.02, WIN_GLASS, w - 0.02, v0=-0.02))
    # каменный подоконник
    part(parts, 'win_sill', 'stone',
         wall_box(wall, u, z0 - WIN_BAR - 0.055, w + 0.16, 0.10, 0.055, v0=0.03))


# ==========================================================================
# ЯРУС 5. КРОВЛЯ: тело скатов, пласты соломы, конёк, лобовые доски
# ==========================================================================
def build_roof(parts, g, rng):
    """Двускатная соломенная кровля: скаты, 5 пластов на скат, гребень, доски."""
    sl = g.slope_len()
    x_body = HX + g.over_end - 0.075            # тело короче лобовой доски
    for sign in (1, -1):
        poly = [g.roof_yz(0.0, 0.0, sign), g.roof_yz(sl, 0.0, sign),
                g.roof_yz(sl, -ROOF_T, sign), g.roof_yz(0.0, -ROOF_T, sign)]
        part(parts, 'roof_slope_%s' % ('p' if sign > 0 else 'm'), 'leaf_autumn',
             prism_x(poly, -x_body, x_body))
        # пласты соломы: разной ширины и высоты, нижний край оборван
        s = 0.0
        for i in range(N_PLAST):
            s1 = sl * (i + 1) / float(N_PLAST)
            w_plast = s1 - s
            thick = PLAST_T * rng.uniform(0.75, 1.25)
            drop = thick * rng.uniform(0.35, 0.95)          # «оборванный» низ
            o0 = ROOF_T * rng.uniform(0.2, 0.5)
            poly = [g.roof_yz(s + 0.006, o0, sign),
                    g.roof_yz(s1, o0, sign),
                    g.roof_yz(s1, o0 + thick - drop, sign),
                    g.roof_yz(s + 0.006, o0 + thick, sign)]
            x0 = -x_body + rng.uniform(0.0, 0.10)
            x1 = x_body - rng.uniform(0.0, 0.14)
            part(parts, 'roof_plast_%s%d' % ('p' if sign > 0 else 'm', i),
                 'leaf_autumn', prism_x(poly, x0, x1))
            s = s1
        # лобовая доска торца (по скату, с вылетом за конёк)
        p0 = g.roof_yz(-0.03, -ROOF_T - 0.02, sign)
        p1 = g.roof_yz(sl + 0.02, -0.02, sign)
        for xs in (1, -1):
            part(parts, 'roof_barge_%s%s' % ('p' if sign > 0 else 'm',
                                             'p' if xs > 0 else 'm'), 'trunk',
                 beam((xs * (HX + g.over_end - 0.035), p0[0], p0[1]),
                      (xs * (HX + g.over_end - 0.035), p1[0], p1[1]),
                      0.070, 0.150, plane='yz'))
    # гребень: три пласта соломы поперёк конька
    for i in range(3):
        y0 = -0.13 + i * 0.02
        poly = [(y0, g.z_ridge - 0.02), (-y0, g.z_ridge - 0.02),
                (-y0 * 0.72, g.z_ridge + 0.075), (y0 * 0.72, g.z_ridge + 0.075)]
        x0 = -x_body + 0.35 * i
        x1 = x_body - 0.35 * (2 - i)
        part(parts, 'roof_ridge_%d' % i, 'leaf_autumn', prism_x(poly, x0, x1))
    # прижимные жерди по кромке скатов
    for sign in (1, -1):
        part(parts, 'roof_pole_%s' % ('p' if sign > 0 else 'm'), 'trunk',
             box(0.0, sign * (g.y_eave - 0.02), g.z_eave - 0.02,
                 2 * x_body - 0.05, 0.055, 0.055))


# ==========================================================================
# ЯРУС 6. КАМЕННАЯ ТРУБА КУЗНЕЧНОГО ГОРНА
# ==========================================================================
def build_chimney(parts, g, rng):
    """Труба горна: кожух на скате, ствол, каменный карниз, железный бугель."""
    cx, cy = CHIM_X, CHIM_Y
    z_roof = g.roof_z(cy)                        # поверхность ската под трубой
    z_top = g.z_ridge + 0.44                     # верх трубы над коньком
    z_hood = z_roof + 0.30
    # кожух (раструб) — широкая часть у ската
    part(parts, 'chimney_hood', 'stone',
         frustum(cx, cy, z_roof - 0.24, z_hood, 0.40, 0.35, 0.28, 0.25),
         jit=0.005, rng=rng)
    # ствол
    part(parts, 'chimney_stack', 'stone',
         frustum(cx, cy, z_hood, z_top, 0.28, 0.25, 0.25, 0.22),
         jit=0.004, rng=rng)
    # карниз
    part(parts, 'chimney_cap', 'stone',
         box(cx, cy, z_top, 0.35, 0.32, 0.070, rz=math.radians(1.5)))
    # железный бугель кузнечного горна
    part(parts, 'chimney_band', 'iron',
         box(cx, cy, z_hood + 0.20, 0.295, 0.265, 0.042))
    # два камня-выступа, чтобы читалась кладка
    for i, (du, dv, dz) in enumerate(((-0.11, 0.08, z_hood + 0.05),
                                      (0.10, -0.07, z_hood + 0.33))):
        part(parts, 'chimney_stone_%d' % i, 'stone',
             box(cx + du, cy + dv, dz, 0.11, 0.085, 0.075,
                 rz=math.radians(rng.uniform(-8, 8))))


# ==========================================================================
# ЯРУС 7. НАВЕС НАД ВОРОТЦАМИ
# ==========================================================================
def build_canopy(parts, g, kind='board'):
    """Навес над воротцами: доска на двух подкосах (или крыльцо на столбах)."""
    wall = ('y', 1, HY)
    z_hi = g.z_wall1 - PLATE_H + 0.02            # крепление под верхней обвязкой
    depth = 0.27 if kind == 'board' else 0.25
    drop = depth * math.tan(math.radians(30.0))
    half = g.gate_w / 2.0 + (0.24 if kind == 'board' else 0.30)
    rx = math.radians(-30.0)                     # наклон доски от стены вниз
    cy = HY + depth / 2.0
    part(parts, 'canopy_board', 'trunk',
         box(0.0, cy, z_hi - drop / 2.0 - 0.035, 2 * half, depth, 0.070, rx=rx))
    # лобовая доска навеса
    part(parts, 'canopy_fascia', 'trunk',
         box(0.0, HY + depth - 0.005, z_hi - drop - 0.075, 2 * half, 0.055, 0.115))
    for i, du in enumerate((-(half - 0.10), (half - 0.10))):
        part(parts, 'canopy_strut_%d' % i, 'trunk',
             wall_beam(wall, (du, 0.0, z_hi - 0.34), (du, depth - 0.05, z_hi - drop + 0.02),
                       FR_T, 0.070))
    if kind == 'porch':
        # столбы крыльца на каменных лежнях + лавка (всё внутри пятна)
        y_post = HY + depth - 0.07
        for i, du in enumerate((-(half - 0.06), (half - 0.06))):
            part(parts, 'porch_foot_%d' % i, 'stone',
                 box(du, y_post, 0.0, 0.16, 0.16, 0.12))
            part(parts, 'porch_post_%d' % i, 'trunk',
                 box(du, y_post, 0.12, 0.085, 0.085,
                     z_hi - drop - 0.12 - 0.01))
        part(parts, 'porch_bench', 'trunk',
             box(0.0, y_post - 0.02, 0.30, 1.02, 0.20, 0.06))


# ==========================================================================
# ЯРУС 8. ДВОР: кадка с водой, поленница, мох, кожаный фартук кузнеца
# ==========================================================================
def build_yard(parts, g, rng, wood=4, moss=3, trough=True, apron=True):
    wall_f = ('y', 1, HY)
    if trough:
        # кадка-закалка: камень + тёмная вода
        u = 0.58
        part(parts, 'trough_body', 'stone',
             box(u, 0.82, 0.0, 0.34, 0.24, 0.34), jit=0.004, rng=rng)
        part(parts, 'trough_water', 'iron',
             box(u, 0.82, 0.30, 0.25, 0.15, 0.03))
    if apron:
        # кожаный фартук на колышке — пустая панель фасада занята делом
        wall = ('y', 1, HY)
        u = -0.63
        part(parts, 'apron_peg', 'trunk',
             wall_box(wall, u, 1.00, 0.05, 0.06, 0.05, v0=-0.01))
        part(parts, 'apron', 'leather',
             wall_box(wall, u, 0.60, 0.20, 0.035, 0.40, v0=0.02))
        part(parts, 'apron_strap', 'leather',
             wall_box(wall, u, 0.94, 0.13, 0.030, 0.06, v0=0.045))
    # поленница у торца: брёвнышки лежат вдоль Y
    for i in range(wood):
        row, col = divmod(i, 2)
        part(parts, 'firewood_%d' % i, 'trunk',
             box(-0.92, -0.36 + col * 0.16, 0.02 + row * 0.115,
                 0.11, 0.14, 0.11, rz=math.radians(rng.uniform(-4, 4))))
    # мох у цоколя
    spots = ((-0.66, 0.79), (0.72, -0.76), (-0.80, -0.58), (0.24, 0.80))[:moss]
    for i, (mx, my) in enumerate(spots):
        part(parts, 'moss_%d' % i, 'grass',
             box(mx, my, 0.0, 0.15, 0.11, 0.035, rz=math.radians(rng.uniform(-20, 20))))


# ==========================================================================
# ВАРИАНТЫ И СБОРКА
# ==========================================================================
VARIANTS = {
    # variant: (уклон, свес по скату, свес по торцу, высота стен, ширина ворот,
    #           высота ворот, стена окна, место окна, навес, поленьев, мха)
    'a': dict(pitch=47.0, over_slope=0.20, over_end=0.13, wall_h=1.22,
              gate_w=0.90, gate_h=1.02, win_wall='-x', win_u=-0.18,
              canopy='board', wood=4, moss=3),
    'b': dict(pitch=40.0, over_slope=0.24, over_end=0.14, wall_h=1.30,
              gate_w=0.94, gate_h=1.06, win_wall='-x', win_u=-0.34,
              canopy='porch', wood=4, moss=3),
    'c': dict(pitch=53.0, over_slope=0.18, over_end=0.12, wall_h=1.18,
              gate_w=0.88, gate_h=0.92, win_wall='-x', win_u=-0.42,
              canopy='board', wood=3, moss=2),
}


def build(variant=None, seed=11):
    """Собрать кузницу. variant: None | 'a' | 'b' | 'c' (см. VARIANTS).

    Возвращает список деталей dict(name, family, verts, faces).
    """
    key = 'a' if variant is None else str(variant).lower()
    if key not in VARIANTS:
        raise ValueError('нет варианта %r; есть %s' % (variant, sorted(VARIANTS)))
    cfg = dict(VARIANTS[key])
    rng = random.Random(seed + ord(key))
    g = Geo(cfg['pitch'], cfg['over_slope'], cfg['over_end'],
            wall_h=cfg['wall_h'], gate_w=cfg['gate_w'], gate_h=cfg['gate_h'],
            win_wall=cfg['win_wall'], win_u=cfg['win_u'])
    parts = []
    build_plinth(parts, g, rng)
    build_walls(parts, g, rng)
    build_frame(parts, g)
    build_gate(parts, g)
    build_window(parts, g)
    build_roof(parts, g, rng)
    build_chimney(parts, g, rng)
    build_canopy(parts, g, kind=cfg['canopy'])
    build_yard(parts, g, rng, wood=cfg['wood'], moss=cfg['moss'])
    return parts


def stats(parts):
    """Вершины и ТРЕУГОЛЬНИКИ (грани считаются как len(f) - 2)."""
    verts = sum(len(p['verts']) for p in parts)
    tris = sum(sum(len(f) - 2 for f in p['faces']) for p in parts)
    return dict(parts=len(parts), verts=verts, tris=tris)


def bounds(parts):
    """Габарит: min/max по осям и размеры."""
    xs = [v[0] for p in parts for v in p['verts']]
    ys = [v[1] for p in parts for v in p['verts']]
    zs = [v[2] for p in parts for v in p['verts']]
    return dict(x=(min(xs), max(xs)), y=(min(ys), max(ys)), z=(min(zs), max(zs)),
                size=(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)))


def families_used(parts):
    return sorted({p['family'] for p in parts})


def min_feature(parts):
    """Самая тонкая деталь: наименьший размер бокса детали (канон: >= 0.02)."""
    worst = (9.9, '')
    for p in parts:
        vs = p['verts']
        sx = max(v[0] for v in vs) - min(v[0] for v in vs)
        sy = max(v[1] for v in vs) - min(v[1] for v in vs)
        sz = max(v[2] for v in vs) - min(v[2] for v in vs)
        d = min(sx, sy, sz)
        if d < worst[0]:
            worst = (d, p['name'])
    return worst


if __name__ == '__main__':
    for key in sorted(VARIANTS):
        ps = build(key)
        b = bounds(ps)
        s = stats(ps)
        print('%s: %s  габарит %.3f x %.3f x %.3f  мин.деталь %.3f (%s)  семейства %s'
              % (key, s, b['size'][0], b['size'][1], b['size'][2],
                 min_feature(ps)[0], min_feature(ps)[1], ','.join(families_used(ps))))
