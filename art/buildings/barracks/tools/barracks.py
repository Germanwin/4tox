"""barracks.py — КАЗАРМА для 4tox/mapgen2, пятно 4 x 3 клетки.

Четвёртая постройка деревни.  Не «ратуша поменьше» и не «дом побольше»:
длинное служебное здание, где живёт гарнизон, и двор, где он строится.
Силуэт читается ДЛИНОЙ фасада и двором, а не высотой.

    пятно        4 x 3 клетки: X — длина (4), Y — глубина (3)
    перед        +Y (как у всех трёх построек игры, правило FACE_ROT = 90)
    крупность    mul = siteMul(4) = 0.7667 — в атлас, не здесь
    кадр         96 ppu, истинная изометрия, 512 x 640, 4 поворота

Ярусы снизу вверх — как у ратуши (`townhall/tools/townhall.py`), та же школа:
    цоколь из валунов со мхом и швом -> обмазанные стены с тёмным каркасом ->
    двускатная солома пластами с прижимными слегами -> ровный конёк.
Двор: утоптанный плац перед фасадом, на нём — то, по чему видно казарму:
стойка с копьями и щитами, столб со знаменем, мишень со стрелами, кадка.
Второй вариант — с навесом во дворе (стойка с оружием и стойка для брони).

КРАСКА.  Все детали красятся ЗОНАМИ ПАЛИТРЫ РАТУШИ (`tools/paint.py`), все 12
цветов — её.  Тонов по нормали нет: один материал на зону, затенение даёт
сцена, ровно как у ратуши.

ЧИСЛА ПРИЁМКИ (SPEC) — не «на глаз»: h_b 2.60..3.00 и wall_h 1.20..1.50 —
канон класса `building` (`references/anatomy.md`), и казарма в него попадает
БЕЗ правки диапазонов.  Она ниже ратуши (конёк 2.69 против 2.82+фонарь) и
спокойнее её: уклон 43° против 52°, нет ни фонаря, ни звонницы.
"""
import math
import random

import forge as F

# --------------------------------------------------------------------------
# ОСИ И ЯРУСЫ
# --------------------------------------------------------------------------
HALF_X = 1.80             # стены 3.60 по X — длинный фасад
HALF_Y = 0.89             # стены 1.78 по Y
BCY = -0.37               # центр корпуса по Y: корпус сдвинут назад, двор спереди

PITCH_DEG = 43.0          # солома: канон 45..55, у казармы спокойнее ратуши
TAN_P = math.tan(math.radians(PITCH_DEG))
COS_P = math.cos(math.radians(PITCH_DEG))

Z_PL = 0.15               # верх цоколя — по колено человеку
WALL_BASE = 0.12          # низ стен: утоплен в цоколь, чтобы не было щели
WALL_H = 1.40
Z_WALL = Z_PL + WALL_H    # 1.55

OVER_SLOPE = 0.21         # свес по скату (11.8 % ширины стены — канон 11..31)
OVER_END = 0.16           # свес по торцу (4.4 % длины стены — канон 4..13)
ROOF_T = 0.15             # толщина соломы
ROOF_X = HALF_X + OVER_END
EAVE_Y_F = BCY + HALF_Y + OVER_SLOPE          # 0.73
EAVE_Y_B = BCY - HALF_Y - OVER_SLOPE          # -1.47

N_COURSE = 4              # пластов соломы на скат
COURSE_STEP = 0.022       # насколько каждый верхний пласт выступает
T_VERT = ROOF_T / COS_P   # вертикальная толщина ската

# Кровля стоит НА стене, но её низ приподнят: верхняя обвязка выступает за
# плоскость стены, а скат над ней опускается на TAN_P * выступ.  Зазор 0.08 —
# это та же «тёмная линия под карнизом», что у ратуши (у неё 0.11): без него
# обвязка уходит внутрь кровли и автоотсев снимает её целиком.
ROOF_LIFT = 0.08
Z_EAVE_UNDER = Z_WALL + ROOF_LIFT              # 1.63 — низ кровли у стены
RIDGE_UNDER = Z_EAVE_UNDER + TAN_P * HALF_Y    # 2.46 — низ кровли на коньке
RIDGE_TOP = RIDGE_UNDER + T_VERT + (N_COURSE - 1) * COURSE_STEP

# Двор: плац перед фасадом, от цоколя (y = 0.70) до кромки пятна (y = 1.45)
YARD_BACK = BCY + HALF_Y + 0.18      # 0.70
YARD_FRONT = 1.44

# Проёмы
DOOR_X = -0.55
DOOR_W, DOOR_H = 0.84, 1.14
WIN_W, WIN_H = 0.26, 0.46
WIN_Z = 1.02
FRONT_WIN = (0.26, 0.86, 1.46)
FRONT_STUD = (0.56, 1.16)
BACK_WIN = (-1.12, -0.34, 0.44)
BACK_STUD = (-0.73, 0.05, 0.83)

SPEC = dict(
    footprint=(4, 3),
    wall_x=2.0 * HALF_X, wall_y=2.0 * HALF_Y, wall_h=WALL_H,
    z_plinth=Z_PL, z_wall=Z_WALL, ridge_z=round(RIDGE_TOP, 4),
    pitch_deg=PITCH_DEG, over_slope=OVER_SLOPE, over_end=OVER_END,
    class_='building',
    # Канон класса `building` — БЕЗ правок: казарма проходит его как есть.
    # Здесь пусто нарочно: если бы пришлось поднимать диапазон, это была бы
    # подгонка ответа, а не канон.
    canon=dict(),
)


# --------------------------------------------------------------------------
# МЕЛКИЕ ПОСТРОИТЕЛИ
# --------------------------------------------------------------------------
def bx(parts, name, zone, x0, x1, y0, y1, z0, z1, jit=0.0, seed=0,
       keep=None, nocull=False, rx=0.0, ry=0.0, rz=0.0):
    """Короб по ДВУМ УГЛАМ: (x0..x1, y0..y1, z0..z1).  Порядок важен для чтения."""
    v, f = F.box((x0 + x1) / 2.0, (y0 + y1) / 2.0, min(z0, z1),
                 abs(x1 - x0), abs(y1 - y0), abs(z1 - z0),
                 rz=rz, rx=rx, ry=ry, keep=keep)
    F.part(parts, name, zone, v, f, jit=jit, seed=seed, nocull=nocull)


def vbar(parts, name, zone, x, y, z0, z1, sx, sy, jit=0.0, seed=0, keep=None):
    bx(parts, name, zone, x - sx / 2.0, x + sx / 2.0, y - sy / 2.0, y + sy / 2.0,
       z0, z1, jit=jit, seed=seed, keep=keep)


def prism_x_tri(poly, x0, x1):
    """Призма вдоль X с ЗАТРИАНГУЛИРОВАННЫМИ торцами.

    `prism_x` отдаёт торцы n-угольниками.  У профиля кровли двадцать вершин и
    он невыпуклый, и полагаться на то, что каждый потребитель (Blender, xray,
    canon) разберёт такой n-угольник одинаково, не стоит: триангулируем сами
    тем же ear clipping, что и весь проект.
    """
    v, f = F.prism_x(poly, x0, x1)
    n = len(poly)
    out = list(f[:n])
    for cap in f[n:]:
        pts = [v[i] for i in cap]
        for t in F.triangles(pts):
            out.append(tuple(cap[i] for i in t))
    return v, out


def on_slope(y, sign, lift=0.0):
    """Точка на ПЛОСКОСТИ НИЗА кровли над y, поднятая по нормали на `lift`.

    Низ кровли проходит через Z_EAVE_UNDER на y = BCY +- HALF_Y и поднимается
    к коньку с уклоном TAN_P.  Нормаль ската — (0, +-sin, +cos).
    """
    z = Z_EAVE_UNDER + (HALF_Y - abs(y - BCY)) * TAN_P
    return (y + sign * math.sin(math.radians(PITCH_DEG)) * lift,
            z + math.cos(math.radians(PITCH_DEG)) * lift)


# --------------------------------------------------------------------------
# ЦОКОЛЬ: ряд валунов по периметру, мох, шов
# --------------------------------------------------------------------------
def build_plinth(parts, rng):
    """Валуны по всему периметру — не сплошная плита.

    Шов между валунами — тёмная забутовка ПОД стеной (stone2): она видна в
    щелях и держит нижнюю грань, чтобы в просвет не светила изнанка ряда.
    """
    bx(parts, 'plinth_seam', 'stone2', -HALF_X - 0.02, HALF_X + 0.02,
       BCY - HALF_Y - 0.02, BCY + HALF_Y + 0.02, 0.0, 0.12,
       jit=0.004, seed=11)

    def row(tag, axis, a0, a1, n, edge0, edge1, seed):
        gap = 0.030
        w = ((a1 - a0) - gap * (n - 1)) / n
        for i in range(n):
            a = a0 + i * (w + gap) + w / 2.0
            h = 0.152 + rng.uniform(-0.012, 0.012)
            d = (edge1 - edge0) + rng.uniform(-0.02, 0.02)
            e0 = edge0 + rng.uniform(-0.008, 0.008)
            rz = math.radians(rng.uniform(-2.2, 2.2))
            if axis == 'x':
                v, f = F.box(a, e0 + d / 2.0, 0.0, w, d, h, rz=rz)
            else:
                v, f = F.box(e0 + d / 2.0, a, 0.0, d, w, h, rz=rz)
            F.part(parts, 'plinth_%s%d' % (tag, i), 'stone', v, f,
                   jit=0.010, seed=seed + i)

    # передний и задний ряды
    row('f', 'x', -1.98, 1.98, 4, BCY + HALF_Y - 0.02, BCY + HALF_Y + 0.16, 100)
    row('b', 'x', -1.98, 1.98, 4, BCY - HALF_Y - 0.16, BCY - HALF_Y + 0.02, 200)
    # боковые ряды
    row('l', 'y', BCY - HALF_Y + 0.10, BCY + HALF_Y - 0.10, 2,
        -1.98, -HALF_X + 0.02, 300)
    row('r', 'y', BCY - HALF_Y + 0.10, BCY + HALF_Y - 0.10, 2,
        HALF_X - 0.02, 1.98, 400)

    # мох: пятна на валунах, не сплошной пояс
    moss = [(-1.62, 'f'), (-0.52, 'f'), (1.18, 'f')]
    for i, (a, side) in enumerate(moss):
        if side in ('f', 'b'):
            y = BCY + HALF_Y + 0.075 if side == 'f' else BCY - HALF_Y - 0.075
            bx(parts, 'moss_%d' % i, 'moss', a - 0.09, a + 0.09,
               y - 0.075, y + 0.075, 0.140, 0.172, jit=0.006, seed=500 + i)
        else:
            bx(parts, 'moss_%d' % i, 'moss', 1.90, 1.965,
               a - 0.085, a + 0.085, 0.140, 0.172, jit=0.006, seed=500 + i)


# --------------------------------------------------------------------------
# СТЕНЫ И КАРКАС
# --------------------------------------------------------------------------
def build_walls(parts):
    bx(parts, 'walls', 'wall', -HALF_X, HALF_X, BCY - HALF_Y, BCY + HALF_Y,
       WALL_BASE, Z_WALL, jit=0.005, seed=21)


def build_frame(parts):
    """Каркас: стойки по углам, нижняя и верхняя обвязки, стойки, раскосы.

    Каждый брусок — ЗАМКНУТЫЙ короб, без ручного `keep`: `autocull` выбрасывает
    закрытые грани только у замкнутых деталей (тест «точка внутри»), и брусок,
    у которого грани срезаны руками, перестаёт прятать чужие.  Проверено
    числом: `keep` на угловых стойках поднял бюджет на 22 трис вместо того,
    чтобы его срезать.

    Всё выступает из плоскости стены на OUT — иначе каркас в одной плоскости
    со стеной и в изометрии не читается (грабли `4tox-house-3d`).
    """
    OUT = 0.045
    yF = BCY + HALF_Y          # 0.52 — передняя плоскость стены
    yB = BCY - HALF_Y          # -1.26

    # угловые стойки: одно сечение, четыре штуки, чуть выше стены
    for sx in (-1, 1):
        for y in (yF, yB):
            vbar(parts, 'post_c%s%d' % ('p' if sx > 0 else 'm', int(y * 10)),
                 'timber', sx * HALF_X, y, 0.10, Z_WALL + 0.01, 0.17, 0.17,
                 jit=0.004, seed=30 + int(y * 7) + sx)

    # нижняя обвязка: передняя рвётся на дверь
    d0, d1 = DOOR_X - DOOR_W / 2.0 - 0.12, DOOR_X + DOOR_W / 2.0 + 0.12
    bx(parts, 'sill_f0', 'timber', -HALF_X, d0, yF, yF + 0.09, 0.19, 0.33,
       jit=0.004, seed=35)
    bx(parts, 'sill_f1', 'timber', d1, HALF_X, yF, yF + 0.09, 0.19, 0.33,
       jit=0.004, seed=36)
    bx(parts, 'sill_b', 'timber', -HALF_X, HALF_X, yB - 0.09, yB, 0.19, 0.33,
       jit=0.004, seed=37)
    for sx in (-1, 1):
        x = sx * HALF_X
        bx(parts, 'sill_s%d' % sx, 'timber', x - 0.045, x + 0.045,
           yB, yF, 0.19, 0.33, jit=0.004, seed=38)

    # верхняя обвязка — по всему периметру, она же подбалка под слеги
    bx(parts, 'plate_f', 'beam', -HALF_X - 0.05, HALF_X + 0.05, yF,
       yF + 0.055, Z_WALL - 0.17, Z_WALL + 0.005, jit=0.004, seed=40)
    bx(parts, 'plate_b', 'beam', -HALF_X - 0.05, HALF_X + 0.05, yB - 0.055,
       yB, Z_WALL - 0.17, Z_WALL + 0.005, jit=0.004, seed=41)
    for sx in (-1, 1):
        x = sx * HALF_X
        bx(parts, 'plate_s%d' % sx, 'beam', x - 0.05, x + 0.05,
           yB, yF, Z_WALL - 0.17, Z_WALL + 0.005, jit=0.004, seed=42)

    # стойки на фасадах — между проёмами, а не «через равные»
    for i, x in enumerate(FRONT_STUD):
        bx(parts, 'stud_f%d' % i, 'timber', x - 0.05, x + 0.05, yF,
           yF + OUT, 0.22, Z_WALL - 0.10, jit=0.004, seed=50 + i)
    bx(parts, 'stud_fL', 'timber', -1.35 - 0.05, -1.35 + 0.05, yF,
       yF + OUT, 0.22, Z_WALL - 0.10, jit=0.004, seed=55)
    for i, x in enumerate(BACK_STUD):
        bx(parts, 'stud_b%d' % i, 'timber', x - 0.05, x + 0.05, yB - OUT,
           yB, 0.22, Z_WALL - 0.10, jit=0.004, seed=60 + i)

    # стойки торцов и раскосы 45°: торец виден на двух поворотах из четырёх
    for sx in (-1, 1):
        x = sx * HALF_X
        for y in (BCY - 0.55, BCY + 0.55):
            bx(parts, 'stud_s%d%d' % (sx, int(y * 10)), 'timber',
               x + min(0, sx) * OUT - (0.05 if sx > 0 else 0.0),
               x + max(0, sx) * OUT + (0.05 if sx < 0 else 0.0),
               y - 0.05, y + 0.05, 0.22, Z_WALL - 0.10, jit=0.004,
               seed=70 + sx + int(y * 3))
        for k, (ya, za, yb, zb) in enumerate(((BCY - 0.68, 0.36, BCY - 0.24, 0.86),
                                              (BCY + 0.04, 0.36, BCY + 0.48, 0.86))):
            v, f = F.bar((x, ya, za), (x, yb, zb), 0.085, 0.055, over=0.02,
                         caps=(0, 1))
            F.part(parts, 'brace_%d%d' % (sx, k), 'timber', v, f,
                   jit=0.004, seed=80 + 4 * sx + k, nocull=True)


# --------------------------------------------------------------------------
# ПРОЁМЫ: узкое окно с переплётом и дверь с полотном
# --------------------------------------------------------------------------
def nwin(parts, tag, wall, plane, a, zc, sw=WIN_W, sh=WIN_H, fw=0.045,
         out=0.05, depth=0.07, glass_in=0.032, mul_in=0.014, sill=True,
         mullions=True, seed=0):
    """Окно КОЛЬЦОМ, но НЕ КВАДРАТНОЕ: ширина и высота задаются отдельно.

    Геометрия глубин — та же, что у `forge.window` (и почему именно такая —
    написано там): стойки на всю высоту, планки заходят в стойки, стекло
    утоплено за раму на `glass_in`, переплёт — на `mul_in`.  Своя функция, а
    не вызов скилловой, только из-за пропорции: у казармы окна узкие и высокие,
    а `forge.window` умеет лишь квадрат `size x size`.
    """
    half_w, half_h = sw / 2.0, sh / 2.0
    ox, oz = half_w + fw, half_h + fw
    # `plane` — КООРДИНАТА плоскости стены (y для стен +-y, x для +-x), а
    # наружу — по имени стены.  У `forge.window` plane задаётся как ПОЛОЖИТЕЛЬНОЕ
    # расстояние от центра и знак берётся из имени; для постройки, сдвинутой
    # назад (BCY), это молча ставит задние окна в двор.  Здесь плоскость задана
    # явно, и такой ошибки быть не может.
    sgn = 1.0 if wall in ('+y', '+x') else -1.0
    d_frame = out - depth / 2.0
    d_glass = out - glass_in
    d_mul = out - mul_in
    d_rail = d_frame - 0.006
    d_mul_h = d_mul + 0.008
    o = wall
    s1 = '+x' if wall in ('+y', '-y') else '+y'
    s2 = '-x' if wall in ('+y', '-y') else '-y'

    def place(aa, z0, sa, sz, keep, name, zone, d=d_frame, jit=0.0, sd=0):
        if wall in ('+y', '-y'):
            v, f = F.box(aa, plane + sgn * d, z0, sa, depth, sz, keep=keep)
        else:
            v, f = F.box(plane + sgn * d, aa, z0, depth, sa, sz, keep=keep)
        F.part(parts, name, zone, v, f, jit=jit, seed=sd)

    for sg in (1, -1):
        place(a + sg * ox, zc - oz, fw, 2 * oz, (o, s1, s2, '+z'),
              '%s_fr%d' % (tag, sg), 'timber', jit=0.003, sd=seed + sg)
    # планки ШИРЕ стоек на 0.02: их торцы уходят в стойки, и грани торца не
    # нужны.  Планка «почти достала» до стойки даёт открытый торец — это и
    # было 24 px изнанки на каждом окне.
    place(a, zc + half_h, 2 * ox + 0.02, fw - 0.004, (o, '+z'),
          tag + '_ft', 'timber', d=d_rail, jit=0.003, sd=seed + 2)
    place(a, zc - half_h - fw + 0.004, 2 * ox + 0.02, fw - 0.004,
          (o, '+z'), tag + '_fb', 'timber', d=d_rail, jit=0.003,
          sd=seed + 3)

    # тёмное нутро: вплотную к стене, за рамой
    place(a, zc - half_h, sw, sh, (o,), tag + '_glass', 'dark',
          d=d_glass - 0.006, sd=seed + 4)
    # переплёт 1 x 2: вертикальный и горизонтальный бруски
    if mullions:
        place(a, zc - half_h, 0.024, sh, (o, s1, s2, '+z'), tag + '_mv',
              'timber', d=d_mul, sd=seed + 5)
        place(a, zc - 0.012, 2 * ox - 0.01, 0.024, (o, '+z'), tag + '_mh',
              'timber', d=d_mul_h, sd=seed + 6)
    if sill:
        w = sw + 2 * fw + 0.09
        place(a, zc - oz - 0.045, w, 0.05, (o, '+z'),
              tag + '_sill', 'stone', d=0.02, jit=0.004, sd=seed + 7)


def build_windows(parts, front=FRONT_WIN):
    """Окна.  `front` — центры окон по фасаду: у варианта B третье окно не
    ставится, его место занимает навес (иначе кровля навеса под острым углом
    перерезает окно пополам — на этом автоотсев снял верхнюю планку целиком)."""
    yF, yB = BCY + HALF_Y, BCY - HALF_Y
    for i, x in enumerate(front):
        nwin(parts, 'win_f%d' % i, '+y', yF, x, WIN_Z, seed=600 + 10 * i)
    for i, x in enumerate(BACK_WIN):
        nwin(parts, 'win_b%d' % i, '-y', yB, x, WIN_Z, mullions=False,
             seed=700 + 10 * i)
    for i, sx in enumerate((-1, 1)):
        nwin(parts, 'win_s%d' % i, '+x' if sx > 0 else '-x', sx * HALF_X,
             BCY, WIN_Z, seed=800 + 10 * i)


def build_door(parts):
    """Дверь: портал из каркаса, тёмный проём, полотно в три доски, приступок."""
    yF = BCY + HALF_Y
    x0, x1 = DOOR_X - DOOR_W / 2.0, DOOR_X + DOOR_W / 2.0
    z0, z1 = Z_PL, Z_PL + DOOR_H

    # портал: стойки и перекладина — часть каркаса, тот же тёмный брус
    for i, x in enumerate((x0 - 0.07, x1 + 0.07)):
        bx(parts, 'door_jamb%d' % i, 'timber', x - 0.07, x + 0.07,
           yF - 0.01, yF + 0.075, 0.16, z1 + 0.10, jit=0.004, seed=900 + i)
    bx(parts, 'door_lintel', 'timber', x0 - 0.14, x1 + 0.14, yF - 0.01,
       yF + 0.079, z1 + 0.025, z1 + 0.115, jit=0.004, seed=903)

    # тёмный проём — на 0.004 перед стеной, чтобы не спорить с ней плоскостью
    bx(parts, 'door_dark', 'dark', x0, x1, yF + 0.004, yF + 0.02, z0, z1,
       seed=904)
    # полотно ПРИОТКРЫТО на 30 градусов: тёмный проём за ним читается, и дверь
    # не выглядит заклеенной доской.  Петли — на левом откосе, створка уходит
    # наружу (в +Y), как её и оставляют в казарме днём.
    hx, hy = x0 + 0.03, yF + 0.045
    ang = math.radians(30.0)
    ca, sa = math.cos(ang), math.sin(ang)
    lw, lt = 0.42, 0.048
    cx = hx + ca * lw / 2.0
    cy = hy + sa * lw / 2.0
    v, f = F.box(cx, cy, z0 + 0.02, lw, lt, DOOR_H - 0.04, rz=ang)
    F.part(parts, 'door_leaf', 'plank', v, f, jit=0.004, seed=910)
    # два прижимных бруса поперёк створки и железная жиковина
    for i, z in enumerate((z0 + 0.30, z0 + 0.82)):
        v, f = F.box(cx, cy, z - 0.045, lw - 0.06, lt + 0.026, 0.09, rz=ang)
        F.part(parts, 'door_bat%d' % i, 'beam', v, f, jit=0.003, seed=920 + i)
    v, f = F.box(cx - ca * 0.13, cy - sa * 0.13 + 0.036, z0 + 0.58,
                 0.10, 0.02, 0.10, rz=ang)
    F.part(parts, 'door_ring', 'iron', v, f, jit=0.002, seed=925)

    # приступок: две каменные ступени ПЕРЕД цоколем, вплотную к нему.
    # Поверх цоколя их ставить нельзя: низ ступени и низ валуна легли бы в одну
    # плоскость z = 0 и перекрылись бы в плане — это z-fighting с долей 0.98
    # (замер xray.coplanar).
    yPl = yF + 0.16                      # кромка цоколя
    bx(parts, 'step_hi', 'stone', x0 - 0.22, x1 + 0.22, yPl + 0.012,
       yPl + 0.30, 0.0, 0.095, jit=0.005, seed=931)
    bx(parts, 'step_lo', 'stone2', x0 - 0.18, x1 + 0.18, yPl + 0.30,
       yPl + 0.50, 0.0, 0.048, jit=0.005, seed=930)


# --------------------------------------------------------------------------
# ЩИПЦЫ
# --------------------------------------------------------------------------
def build_gables(parts):
    """Щипцы — ЗАМКНУТЫЕ призмы: односторонняя плоскость светит изнанкой."""
    yF, yB = BCY + HALF_Y, BCY - HALF_Y
    apex = RIDGE_UNDER + 0.03
    # ПЯТИУГОЛЬНИК, а не треугольник: между верхом стены (Z_WALL) и низом
    # кровли (Z_EAVE_UNDER) сбоку остаётся полоса 0.08, и треугольник оставил
    # бы под свесом открытую щель в чердак.
    tri = [(yB, Z_WALL - 0.02), (yB, Z_EAVE_UNDER + 0.03), (BCY, apex),
           (yF, Z_EAVE_UNDER + 0.03), (yF, Z_WALL - 0.02)]
    for sx in (-1, 1):
        x0 = sx * HALF_X - sx * 0.035
        x1 = sx * HALF_X + sx * 0.085
        v, f = F.prism_x(tri, x0, x1)
        F.part(parts, 'gable_%d' % sx, 'wall', v, f, jit=0.005,
               seed=950 + sx)
        # обвязка щипца: стойка от конька вниз и ригель по низу щипца
        xm = sx * (HALF_X + 0.055)
        bx(parts, 'gable_post%d' % sx, 'timber', xm - 0.045, xm + 0.045,
           BCY - 0.045, BCY + 0.045, Z_WALL - 0.04, apex - 0.16,
           jit=0.004, seed=960 + sx)
        bx(parts, 'gable_tie%d' % sx, 'timber', xm - 0.045, xm + 0.045,
           yB + 0.04, yF - 0.04, Z_WALL + 0.10, Z_WALL + 0.19,
           jit=0.004, seed=970 + sx)
        # слуховой проёмчик в щипце: тёмная панель НА плоскости щипца
        # (утопленная в щипец панель автоотсев снимает целиком — проверено)
        xv = sx * (HALF_X + 0.085)
        bx(parts, 'gable_vent%d' % sx, 'dark', xv - 0.004, xv + 0.008,
           BCY - 0.10, BCY + 0.10, Z_WALL + 0.26, Z_WALL + 0.52,
           seed=980 + sx)


# --------------------------------------------------------------------------
# КРОВЛЯ: скаты пластами, конёк, прижимные слеги, заплаты, лобовые доски
# --------------------------------------------------------------------------
def roof_outline():
    """Контур поперечника кровли: низ гладкий, верх — ступенями пластов.

    НИЗ проходит через верх стены (Z_WALL на y = BCY +- HALF_Y) и поднимается к
    коньку с уклоном TAN_P.  ВЕРХ = низ + T_VERT (толщина соломы) + набег
    пластов: солома кладётся от свеса вверх, каждый пласт ложится на нижний,
    поэтому у свеса крыша тоньше — так она и читается.  Если забыть про T_VERT,
    верх и низ сходятся в свесе и контур вырождается (площадь 0.05 вместо 2.32,
    и кровля рассыпается на изнанки — эта грабля уже поймана).
    """
    L = HALF_Y + OVER_SLOPE

    def und(v):
        return RIDGE_UNDER - TAN_P * v * L

    def top(v, k):
        return und(v) + T_VERT + cs(k)

    # верх переднего ската: от торца свеса к коньку, ступенями вверх
    front = []
    for k in range(N_COURSE):
        va = 1.0 - k / float(N_COURSE)
        vb = 1.0 - (k + 1) / float(N_COURSE)
        front.append((BCY + va * L, top(va, k)))
        front.append((BCY + vb * L, top(vb, k)))
        if k < N_COURSE - 1:
            front.append((BCY + vb * L, top(vb, k + 1)))   # подступенок
    front = _dedup(front)
    # верх заднего ската — то же зеркально, от конька к заднему свесу
    back = _dedup([(2.0 * BCY - y, z) for (y, z) in reversed(front)])[1:]

    pts = [(BCY - L, und(1.0)),          # низ: задний свес
           (BCY, und(0.0)),              # низ: конёк
           (BCY + L, und(1.0))]          # низ: передний свес
    pts += front                          # торец переднего свеса вверх + верх
    pts += back                           # верх заднего ската вниз
    return _dedup(pts)


def _dedup(pts, eps=1e-9):
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > eps or abs(p[1] - out[-1][1]) > eps:
            out.append(p)
    return out


def cs(k):
    """Набег пласта k.  Ступень только у НИЖНЕГО пласта: солома кладётся от
    свеса вверх, и видно именно кромку первого пласта.  Если ступенить все,
    скат рассыпается на четыре полосы, и стиль-гейт читает это как
    раздробленность (замер @4x: крупных 30 %, мусорных 41 % — FAIL)."""
    return COURSE_STEP if k >= 1 else 0.0


def z_top(y, course):
    """Верхняя плоскость ската над координатой y (низ + толщина + набег)."""
    L = HALF_Y + OVER_SLOPE
    v = abs(y - BCY) / L
    return (RIDGE_UNDER - TAN_P * v * L + T_VERT
            + cs(min(course, N_COURSE - 1)))


def build_roof(parts, rng):
    poly = roof_outline()
    v, f = prism_x_tri(poly, -ROOF_X, ROOF_X)
    F.part(parts, 'roof', 'thatch', v, f, jit=0.003, seed=1000)

    # прижимные слеги: по две на скат, лежат НА ПЛОСКОСТИ своего пласта
    for sign, tag in ((1, 'f'), (-1, 'b')):
        for k in (1, 3):
            vv = 1.0 - (k + 0.5) / float(N_COURSE)     # середина пласта
            L = HALF_Y + OVER_SLOPE
            y = BCY + sign * vv * L
            z = z_top(y, k)
            nx, nz = math.sin(math.radians(PITCH_DEG)), math.cos(math.radians(PITCH_DEG))
            lift = 0.012
            cy = y + sign * nx * lift - 0.0
            cz = z + nz * lift
            v, f = F.box(0.0, cy, cz - 0.022, 2 * ROOF_X - 0.10, 0.055, 0.048,
                         rx=-sign * math.radians(PITCH_DEG))
            F.part(parts, 'batten_%s%d' % (tag, k), 'timber', v, f,
                   jit=0.003, seed=1010 + 10 * k + sign)

    # заплаты: перекрытая солома, прибитая жердью (приём ратуши)
    for i, (xc, vv, w) in enumerate(((-0.72, 0.30, 0.62), (0.78, 0.62, 0.54))):
        L = HALF_Y + OVER_SLOPE
        y = BCY + vv * L
        z = z_top(y, int((1.0 - vv) * N_COURSE))
        v, f = F.box(xc, y, z - 0.006, w, 0.34, 0.030,
                     rx=-math.radians(PITCH_DEG))
        F.part(parts, 'patch%d' % i, 'thatch2', v, f, jit=0.004, seed=1020 + i)

    # конёк: РОВНЫЙ брус — казарма не «недостроенный дом», провиса нет
    top = RIDGE_UNDER + T_VERT + (N_COURSE - 1) * COURSE_STEP
    bx(parts, 'ridge', 'thatch2', -ROOF_X - 0.01, ROOF_X + 0.01,
       BCY - 0.13, BCY + 0.13, top - 0.055, top + 0.052, jit=0.003, seed=1030)
    bx(parts, 'ridge_cap', 'beam', -ROOF_X, ROOF_X, BCY - 0.085, BCY + 0.085,
       top + 0.048, top + 0.078, jit=0.003, seed=1031)

    # лобовые доски по торцам: тёмная кромка, как у ратуши
    for sx in (-1, 1):
        for sign in (1, -1):
            L = HALF_Y + OVER_SLOPE
            y0 = BCY + sign * 0.05
            p0 = (sx * (ROOF_X - 0.035), y0, z_top(y0, N_COURSE - 1) - 0.015)
            p1 = (sx * (ROOF_X - 0.035), BCY + sign * L, z_top(BCY + sign * L, 0) - 0.015)
            v, f = F.bar(p0, p1, 0.062, 0.05, over=0.01, caps=(0, 1))
            F.part(parts, 'barge_%d%d' % (sx, sign), 'beam', v, f,
                   jit=0.003, seed=1040 + sx + sign)


# --------------------------------------------------------------------------
# ДВОР: плац и то, по чему видно казарму
# --------------------------------------------------------------------------
def build_rack(parts, rng):
    """Стойка с копьями и щитами: то, по чему сразу видно казарму.

    Стоит в плацу справа от входа.  Древки — четырёхгранные: при 96 ppu
    шестигранник даёт те же 2 px, а трис вдвое больше.
    """
    x0, x1 = 0.20, 0.80
    y = 1.14
    for i, x in enumerate((x0, x1)):
        bx(parts, 'rack_post%d' % i, 'timber', x - 0.05, x + 0.05,
           y - 0.05, y + 0.05, 0.0, 1.08, jit=0.004, seed=1200 + i)
    bx(parts, 'rack_rail_hi', 'beam', x0 - 0.06, x1 + 0.06, y - 0.035,
       y + 0.035, 0.98, 1.055, jit=0.004, seed=1210)
    bx(parts, 'rack_rail_lo', 'beam', x0 - 0.06, x1 + 0.06, y - 0.035,
       y + 0.035, 0.42, 0.495, jit=0.004, seed=1211)
    # три копья: древко вверх, наконечник, лёгкий наклон к стене
    for i, dx in enumerate((-0.18, 0.0, 0.18)):
        x = (x0 + x1) / 2.0 + dx
        v, f = F.prism(F.ngon(0.0, 0.0, 0.024, 4, phase=math.pi / 4 + 0.2 * i),
                       0.0, 1.88, 2)
        v = [(p[0] + x + p[2] * 0.055, p[1] + y + 0.075, p[2]) for p in v]
        F.part(parts, 'spear_shaft%d' % i, 'plank', v, f, jit=0.002,
               seed=1220 + i)
        v, f = F.prism(F.ngon(0.0, 0.0, 0.034, 3, phase=math.pi / 2), 1.86, 2.04, 2)
        v = [(p[0] + x + 0.105, p[1] + y + 0.075, p[2]) for p in v]
        F.part(parts, 'spear_head%d' % i, 'iron', v, f, jit=0.002,
               seed=1230 + i)
    # два щита на стойке: восьмигранник плашмя к камере, бляха в центре
    for i, x in enumerate((x0 - 0.02, x1 + 0.02)):
        v, f = F.prism(F.ngon(0.0, 0.0, 0.185, 6, phase=math.pi / 6), 0.0, 0.05, 1)
        v = [(p[0] + x, p[1] + y + 0.10, p[2] + 0.62) for p in v]
        F.part(parts, 'shield%d' % i, 'plank', v, f, jit=0.003, seed=1240 + i)
        v, f = F.prism(F.ngon(0.0, 0.0, 0.055, 4, phase=math.pi / 4), 0.04, 0.075, 1)
        v = [(p[0] + x, p[1] + y + 0.10, p[2] + 0.62) for p in v]
        F.part(parts, 'shield_boss%d' % i, 'iron', v, f, jit=0.002,
               seed=1250 + i)


def build_banner(parts):
    """Столб со знаменем: каменная база, столб, перекладина, полотнище.

    Стоит на правом переднем углу плаца — так древко выходит ЗА силуэт кровли
    и читается на фоне неба, а не теряется на стене.
    """
    x, y = 1.62, 1.24
    bx(parts, 'banner_base', 'stone', x - 0.15, x + 0.15, y - 0.15, y + 0.15,
       0.0, 0.13, jit=0.006, seed=1300)
    v, f = F.prism(F.ngon(0.0, 0.0, 0.042, 6, phase=0.0), 0.10, 2.04, 2)
    v = [(p[0] + x, p[1] + y, p[2]) for p in v]
    F.part(parts, 'banner_pole', 'timber', v, f, jit=0.003, seed=1301)
    # перекладина и полотнище — замкнутыми (`nocull`): гейт считает знаковый
    # объём у любой оболочки, и открытая деталь, стоящая далеко от начала
    # координат, попадает в «вывернутые» (0.02 % ложных срабатываний, но
    # объяснять их в отчёте дороже, чем закрыть две детали)
    bx(parts, 'banner_cross', 'timber', x - 0.40, x + 0.02, y - 0.022,
       y + 0.022, 1.97, 2.025, jit=0.0, seed=1302)
    parts[-1]['nocull'] = True
    # полотнище висит лицом в +Y, кромка рваная
    zt, zb = 1.96, 1.30
    xa, xb = x - 0.44, x - 0.04
    bx(parts, 'banner_cloth0', 'wall', xa + 0.10, xb, y - 0.012, y + 0.012,
       zb, zt, jit=0.0, seed=1303)
    parts[-1]['nocull'] = True
    bx(parts, 'banner_cloth1', 'wall', xa, xa + 0.10, y - 0.012, y + 0.012,
       zb + 0.14, zt, jit=0.0, seed=1304)
    parts[-1]['nocull'] = True
    # знак на полотнище: тёмный ромб
    v, f = F.prism(F.ngon(0.0, 0.0, 0.082, 4, phase=math.pi / 4), 0.0, 0.014, 1)
    v = [(p[0] + (xa + xb) / 2.0 + 0.03, p[1] + y + 0.012, p[2] + 1.70)
         for p in v]
    F.part(parts, 'banner_mark', 'timber', v, f, seed=1305)


def build_target(parts):
    """Мишень со стрелами: соломенный щит на козлах, три стрелы в нём."""
    x, yc = -1.66, 1.02
    for i, sx in enumerate((-1, 1)):
        xa = x + sx * 0.22
        v, f = F.bar((xa, yc - 0.22, 0.0), (x + sx * 0.15, yc + 0.02, 0.94),
                     0.055, 0.055, caps=(0, 1))
        F.part(parts, 'target_leg%d' % i, 'timber', v, f, jit=0.004,
               seed=1400 + i)
    bx(parts, 'target_rail', 'timber', x - 0.23, x + 0.23, yc - 0.14,
       yc - 0.08, 0.52, 0.58, jit=0.004, seed=1405)
    # соломенный щит: одиннадцатигранник плашмя в +Y, тёмное яблоко
    v, f = F.prism(F.ngon(0.0, 0.0, 0.245, 8, phase=0.1), 0.0, 0.08, 1)
    v = [(p[0] + x, p[1] + yc + 0.02, p[2] + 0.76) for p in v]
    F.part(parts, 'target_butt', 'thatch', v, f, jit=0.005, seed=1410)
    v, f = F.prism(F.ngon(0.0, 0.0, 0.078, 6, phase=0.3), 0.075, 0.10, 1)
    v = [(p[0] + x, p[1] + yc + 0.02, p[2] + 0.76) for p in v]
    F.part(parts, 'target_ring', 'dirt', v, f, jit=0.004, seed=1411)
    # три стрелы: древко торчит на камеру, наконечник тёмный
    for i, (dx, dz, ln) in enumerate(((-0.07, 0.05, 0.30), (0.03, -0.02, 0.26),
                                      (0.09, 0.11, 0.22))):
        v, f = F.prism(F.ngon(0.0, 0.0, 0.015, 4, phase=0.7), 0.0, ln, 1)
        v = [(p[0] + x + dx, p[1] + yc + 0.12, p[2] + 0.76 + dz) for p in v]
        F.part(parts, 'arrow%d' % i, 'plank', v, f, jit=0.002, seed=1420 + i)


def build_barrel(parts):
    """Кадка у крыльца: двенадцатигранная клёпка и два обруча."""
    x, y = -0.26, 0.88
    v, f = F.prism(F.ngon(0.0, 0.0, 0.150, 8, phase=0.1), 0.0, 0.32, 2)
    v = [(p[0] + x, p[1] + y, p[2]) for p in v]
    F.part(parts, 'barrel', 'plank', v, f, jit=0.004, seed=1500)
    for i, z in enumerate((0.05, 0.25)):
        poly = F.ngon(0.0, 0.0, 0.158, 8, phase=0.35)
        v, f = F.prism(poly, z, z + 0.032, 2)
        v = [(p[0] + x, p[1] + y, p[2]) for p in v]
        F.part(parts, 'barrel_hoop%d' % i, 'iron', v, f, jit=0.002,
               seed=1510 + i)


def build_lean_to(parts):
    """Навес во дворе: два столба на камнях, односкатная солома.

    Кровля навеса НАМЕРЕННО ниже карниза корпуса (1.10 против 1.35): если
    подвести её под самый карниз, она сливается с основным скатом и читается
    полкой, а не отдельным объёмом.
    """
    x0, x1 = 1.02, 1.92
    y_wall = BCY + HALF_Y + 0.02
    y1 = 1.32
    z_wall, z_front = 1.10, 0.93
    for i, x in enumerate((x0 + 0.10, x1 - 0.10)):
        bx(parts, 'shed_foot%d' % i, 'stone', x - 0.12, x + 0.12,
           y1 - 0.12, y1 + 0.12, 0.0, 0.13, jit=0.006, seed=1600 + i)
        vbar(parts, 'shed_post%d' % i, 'timber', x, y1, 0.10, z_front - 0.02,
             0.11, 0.11, jit=0.004, seed=1610 + i)
    bx(parts, 'shed_plate', 'beam', x0, x1, y1 - 0.055, y1 + 0.055,
       z_front - 0.10, z_front, jit=0.004, seed=1620)
    bx(parts, 'shed_beam', 'timber', x0, x1, y_wall - 0.05, y_wall + 0.05,
       z_wall - 0.09, z_wall, jit=0.004, seed=1621)
    ang = math.atan2(z_wall - z_front, y1 - y_wall)
    dy = y1 - y_wall
    v, f = F.box((x0 + x1) / 2.0, (y_wall + y1) / 2.0, 0.0, x1 - x0 + 0.16,
                 dy + 0.20, 0.075, rx=-ang)
    v = [(p[0], p[1], p[2] + z_wall + 0.045
          - (p[1] - y_wall) * (z_wall - z_front) / dy) for p in v]
    F.part(parts, 'shed_roof', 'thatch', v, f, jit=0.004, seed=1630)
    # лобовая доска по передней кромке: без неё скат навеса читается столом
    bx(parts, 'shed_fascia', 'beam', x0, x1, y1 - 0.06, y1 + 0.06,
       z_front - 0.13, z_front + 0.02, jit=0.004, seed=1625)
    for i, vv in enumerate((0.32, 0.74)):
        y = y_wall + vv * dy
        z = z_wall + 0.045 - vv * (z_wall - z_front)
        v, f = F.box((x0 + x1) / 2.0, y, z, x1 - x0 + 0.06, 0.05, 0.042,
                     rx=-ang)
        F.part(parts, 'shed_batten%d' % i, 'timber', v, f, jit=0.003,
               seed=1640 + i)


def build_sword_rack(parts):
    """Стойка с мечами под навесом: две стойки, перекладина, три клинка."""
    x, y = 1.46, 1.08
    for i, dx in enumerate((-0.26, 0.26)):
        vbar(parts, 'swr_post%d' % i, 'timber', x + dx, y, 0.0, 0.74,
             0.09, 0.09, jit=0.004, seed=1700 + i)
    bx(parts, 'swr_rail', 'beam', x - 0.30, x + 0.30, y - 0.03, y + 0.03,
       0.64, 0.71, jit=0.004, seed=1710)
    for i, dx in enumerate((-0.13, 0.13)):
        bx(parts, 'sword_blade%d' % i, 'stone', x + dx - 0.016, x + dx + 0.016,
           y + 0.02, y + 0.048, 0.28, 1.06, jit=0.002, seed=1720 + i)
        bx(parts, 'sword_guard%d' % i, 'iron', x + dx - 0.070, x + dx + 0.070,
           y + 0.015, y + 0.053, 1.04, 1.09, jit=0.002, seed=1730 + i)
        bx(parts, 'sword_grip%d' % i, 'plank', x + dx - 0.018, x + dx + 0.018,
           y + 0.02, y + 0.048, 1.07, 1.24, jit=0.002, seed=1740 + i)


def build_armor_stand(parts):
    """Стойка для брони: столб с перекладиной, кираса, шлем, щит рядом."""
    x, y = 0.42, 1.02
    bx(parts, 'arm_base', 'stone', x - 0.19, x + 0.19, y - 0.15, y + 0.15,
       0.0, 0.08, jit=0.005, seed=1800)
    vbar(parts, 'arm_post', 'timber', x, y, 0.06, 1.12, 0.10, 0.10,
         jit=0.004, seed=1801)
    bx(parts, 'arm_bar', 'timber', x - 0.28, x + 0.28, y - 0.045, y + 0.045,
       0.92, 1.01, jit=0.004, seed=1802)
    bx(parts, 'arm_cuirass', 'iron', x - 0.16, x + 0.16, y - 0.07, y + 0.07,
       0.54, 0.90, jit=0.004, seed=1810)
    bx(parts, 'arm_helm', 'iron', x - 0.10, x + 0.10, y - 0.08, y + 0.08,
       1.09, 1.24, jit=0.004, seed=1811)
    # щита рядом нет намеренно: вариант B и без него выходит за 1450 трис,
    # а кираса со шлемом уже читаются как «стойка для брони» (см. REPORT)


def build_grindstone(parts):
    """Точильный камень на колоде: круг на оси, корыто, ручка."""
    x, y = -0.30, 1.02
    for i, sx in enumerate((-1, 1)):
        bx(parts, 'grind_post%d' % i, 'timber', x + sx * 0.23 - 0.05,
           x + sx * 0.23 + 0.05, y - 0.09, y + 0.09, 0.0, 0.56,
           jit=0.004, seed=1900 + i)
    bx(parts, 'grind_trough', 'plank', x - 0.29, x + 0.29, y - 0.11, y + 0.11,
       0.44, 0.52, jit=0.004, seed=1910)
    v, f = F.prism(F.ngon(0.0, 0.0, 0.185, 8, phase=0.1), 0.0, 0.08, 1)
    v = [(p[0] + x, p[1] + y + 0.04, p[2] + 0.64) for p in v]
    F.part(parts, 'grind_wheel', 'stone', v, f, jit=0.004, seed=1920)
    bx(parts, 'grind_axle', 'iron', x - 0.18, x + 0.18, y + 0.02, y + 0.06,
       0.635, 0.675, jit=0.002, seed=1921)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def compact(parts):
    """Убрать вершины, которых не осталось ни в одной грани, и пустые детали.

    `autocull` снимает грани, но не вершины: у стоек и обвязок, утопленных в
    стену, остаётся одна-две видимые грани и семь «висячих» вершин.  Приёмка
    `3d-model-acceptance` считает такую вершину отдельным телом и валит модель
    двумя проверками сразу (C9 «висячие вершины», C12 «одиночные детали в
    воздухе»).  Замер до правки: 127 висячих вершин, 10 «деталей в воздухе».
    """
    out = []
    for p in parts:
        if not p['faces']:
            continue                       # граней не осталось — детали нет
        used = sorted({i for f in p['faces'] for i in f})
        if len(used) != len(p['verts']):
            idx = {v: k for k, v in enumerate(used)}
            p['verts'] = [p['verts'][i] for i in used]
            p['faces'] = [tuple(idx[i] for i in f) for f in p['faces']]
        out.append(p)
    parts[:] = out
    return parts


def build(variant=None):
    """Собрать казарму.  variant: None/'a' — плац, 'b' — двор с навесом."""
    v = (variant or 'a').lower()
    if v not in ('a', 'b'):
        raise ValueError('вариант %r: у казармы два — a и b' % variant)
    rng = random.Random(17)
    parts = []
    build_plinth(parts, rng)
    build_walls(parts)
    build_frame(parts)
    build_windows(parts, FRONT_WIN if v == 'a' else FRONT_WIN[:2])
    build_door(parts)
    build_gables(parts)
    build_roof(parts, rng)
    if v == 'a':
        build_banner(parts)
        build_rack(parts, rng)
        build_target(parts)
        build_barrel(parts)
    else:
        build_lean_to(parts)
        build_sword_rack(parts)
        build_armor_stand(parts)
        build_grindstone(parts)
        build_target(parts)
    F.ground(parts)
    F.autocull(parts)
    compact(parts)
    return parts


if __name__ == '__main__':
    import sys
    for var in (sys.argv[1:] or ['a', 'b']):
        p = build(var)
        print('вариант %s: %s' % (var, F.stats(p)))
        for k, val in F.census(p).most_common(20):
            print('   %-18s %4d трис' % (k, val))
