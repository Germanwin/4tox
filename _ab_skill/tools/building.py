"""building.py — деревенская КУЗНИЦА 2 x 2 для игры 4tox / mapgen2.

ЧИСТЫЙ Python: ни bpy, ни numpy; рядом лежит `forge.py` (тоже чистый Python) —
примитивы, отсев невидимых фасетов, триангуляция невыпуклых контуров, палитра.
Контракт генератора::

    build(variant=None) -> [dict(name, family, verts, faces)]

Ярусы снизу вверх: каменный цоколь -> стены-обмазка с деревянным каркасом ->
широкие воротца (две створки) и одно окно -> навесы над входами -> двускатная
солома -> каменная труба кузнечного горна -> двор.

Правила, по которым это собрано (references/method.md):
  * верх стены — НОМИНАЛ, наклон (wall_lean) применяется только к прибитому
    к стене: иначе обвязка и щипец пробивают скат и по карнизу идут щели;
  * низ кровли идёт по НАРУЖНОЙ кромке верхней обвязки (ROOF_Y0 = HY+FRAME_OUT),
    а не по плоскости стены;
  * щипец — замкнутая призма (полость под кровлей закрыта), кровля — одна
    замкнутая призма по контуру «пилы»;
  * ничего не кончается в воздухе: раскос заводится в стойку (`over`);
  * `autocull` — ровно один раз, в самом конце, после `ground()`.
"""
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import forge as F                                                    # noqa: E402

# ---------------------------------------------------------------------------
# SPEC — числа кузницы.  Габарит обязан лечь в пятно 2 x 2 (|x|,|y| <= 1.0).
# ---------------------------------------------------------------------------
SPEC = dict(
    footprint=(2, 2),            # клетки карты: квадрат, X — вдоль конька
    wall_x=1.76, wall_y=1.44,    # оси стен (номинал, до наклона)
    wall_h=1.26,                 # высота стен
    z_plinth=0.16,               # верх цоколя
    z_wall=1.42,                 # верх стен = z_plinth + wall_h
    pitch_deg=45.0,              # солома: канон 45..55 (задание 32..55)
    over_slope=0.18,             # свес по скату, 12.5% ширины стены
    over_end=0.10,               # свес по торцу, 5.7% длины стены
    ridge_z=None,                # подставится из геометрии
    class_='building',
)

HX, HY = SPEC['wall_x'] / 2.0, SPEC['wall_y'] / 2.0        # 0.88, 0.72
Z0, Z1 = SPEC['z_plinth'], SPEC['z_wall']                  # 0.16, 1.42
WALL_H = SPEC['wall_h']                                    # 1.26
TAN_LEAN = math.tan(math.radians(1.0))
LEAN = F.wall_lean(Z0, WALL_H, TAN_LEAN)

FRAME_OUT, FRAME_T, PLATE_H = 0.05, 0.10, 0.11
ZB0, ZB1 = Z0, Z0 + PLATE_H                                # нижняя обвязка
ZT0, ZT1 = Z1 - PLATE_H, Z1                                # верхняя обвязка
CP = 0.13                                                  # угловая стойка
CXP = HX + FRAME_OUT - CP / 2.0                            # 0.865
CYP = HY + FRAME_OUT - CP / 2.0                            # 0.705

PITCH = math.radians(SPEC['pitch_deg'])
TAN_P, COS_P = math.tan(PITCH), math.cos(PITCH)
ROOF_Y0 = HY + FRAME_OUT                                   # низ ската: кромка обвязки
EAVE_Y = HY + SPEC['over_slope']                           # 0.90 — кромка соломы
ROOF_X = HX + SPEC['over_end']                             # 0.98 — лобовая доска
PLANK_X = ROOF_X - 0.06                                    # докуда доходит солома
ROOF_T = 0.12                                              # толщина кровли
N_PLAST = 4                                                # пластов на скат
RIDGE_Z = Z1 + ROOF_Y0 * TAN_P + ROOF_T / COS_P            # 2.36 — номинальный конёк
SPEC['ridge_z'] = round(RIDGE_Z, 3)

GATE_W, GATE_H = 1.00, 0.95          # воротца: широкие и низкие
GATE_TOP = Z0 + GATE_H               # 1.11 — верх проёма (под перекладиной)
WIN_SIZE, WIN_FW, WIN_Z = 0.28, 0.05, 0.80
WIN_TOP = WIN_Z + WIN_SIZE / 2.0 + WIN_FW                  # 0.99 — верх рамы
CHX, CHY = -0.40, 0.28               # труба горна: смещена от конька и от щипца


def z_under(y):
    """Низ кровли: плоскость через наружную кромку верхней обвязки."""
    return Z1 + (ROOF_Y0 - abs(y)) * TAN_P


def z_nom(y):
    """Верх кровли по номиналу (без ступеней пластов)."""
    return z_under(y) + ROOF_T / COS_P


# ---------------------------------------------------------------------------
# ЯРУС 1: КАМЕННЫЙ ЦОКОЛЬ
# ---------------------------------------------------------------------------
def build_plinth(parts, rng):
    """Непрерывное ядро + блоки со швом + мох: камень держит постройку."""
    px, py = HX + 0.045, HY + 0.045
    v, f = F.box(0.0, 0.0, 0.0, 2 * px, 2 * py, Z0 + 0.03)
    F.part(parts, 'plinth_core', 'stone', v, f, jit=0.005, seed=101)
    for sgn in (1, -1):
        n, w = 4, (2 * (px - 0.105)) / 4.0
        for i in range(n):
            h = Z0 + rng.uniform(-0.012, 0.022)
            v, f = F.box(-(px - 0.105) + w * (i + 0.5), sgn * (py + 0.014),
                         rng.uniform(-0.008, 0.008), w - 0.028,
                         rng.uniform(0.050, 0.075), h,
                         rz=math.radians(rng.uniform(-3.0, 3.0)),
                         rx=math.radians(rng.uniform(-2.0, 2.0)))
            F.part(parts, 'plinth_y%d_%d' % (sgn, i), 'stone', v, f,
                   jit=0.004, seed=110 + i + (0 if sgn > 0 else 7))
    for sgn in (1, -1):
        n, w = 3, (2 * (py - 0.095)) / 3.0
        for i in range(n):
            h = Z0 + rng.uniform(-0.012, 0.022)
            v, f = F.box(sgn * (px + 0.014), -(py - 0.095) + w * (i + 0.5),
                         rng.uniform(-0.008, 0.008),
                         rng.uniform(0.050, 0.075), w - 0.028, h,
                         rz=math.radians(rng.uniform(-3.0, 3.0)),
                         ry=math.radians(rng.uniform(-2.0, 2.0)))
            F.part(parts, 'plinth_x%d_%d' % (sgn, i), 'stone', v, f,
                   jit=0.004, seed=130 + i + (0 if sgn > 0 else 5))
    # мох — на ПОЛКЕ цоколя (от плоскости стены до кромки ядра): пятно лежит на
    # камне и упирается в стену.  Утопленное в ядро пятно автоотсев выбрасывает
    # целиком, и деталь остаётся без единого фасета.
    y_wall = HY * (1.0 - TAN_LEAN)          # плоскость стены у низа
    y_core = py                             # кромка ядра цоколя
    for i, (mx, sy) in enumerate(((-0.72, 1), (0.30, -1), (0.74, 1))):
        w = rng.uniform(0.14, 0.20)
        v, f = F.box(mx, sy * (y_wall + y_core) / 2.0, Z0 + 0.008, w,
                     (y_core - y_wall) + 0.02, 0.030,
                     rz=math.radians(rng.uniform(-18, 18)))
        F.part(parts, 'moss_%d' % i, 'grass', v, f, jit=0.003, seed=150 + i)
    # каменный порог и ступень ПЕРЕД воротцами: стоят на земле и не заходят
    # в пятно ядра цоколя — иначе их низ ложится в одну плоскость с низом ядра
    # (z-fighting), а выброшенный низ видно с низкого ракурса
    v, f = F.box(0.0, 0.860, 0.0, GATE_W + 0.10, 0.160, 0.060)
    F.part(parts, 'gate_thresh', 'stone', v, f, jit=0.003, seed=170)
    v, f = F.box(0.0, 0.885, 0.060, GATE_W - 0.04, 0.135, 0.028)
    F.part(parts, 'gate_step', 'stone', v, f, jit=0.003, seed=171)


# ---------------------------------------------------------------------------
# ЯРУС 2: СТЕНЫ (обмазка) И ЩИПЦЫ
# ---------------------------------------------------------------------------
def build_walls(parts):
    """Стена = глиняная обмазка, каркас нашит сверху (см. build_frame).

    Верх стены — номинал; наклон уводит низ внутрь, поэтому всё, что стоит на
    стене (обвязка, щипец, кровля), сходится с ней без зазоров и без пробития
    ската.
    """
    v, f = F.box(0.0, 0.0, Z0, SPEC['wall_x'], SPEC['wall_y'], WALL_H,
                 keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    F.part(parts, 'wall_core', 'skin', v, f, jit=0.004, seed=201, lean=None)
    # Наклон (LEAN) применён ТОЛЬКО к коробке стены: всё, что к стене прибито,
    # считается по номиналу и сходится без зазоров (references/method.md §5).
    # щипец — ПЯТИУГОЛЬНИК (низ по верху стены, скаты по низу кровли) и
    # ЗАМКНУТАЯ призма: через открытый свес луч заходит в полость чердака, и
    # односторонний щипец виден изнанку.
    gable = [(HY, Z1), (HY, z_under(HY)), (0.0, z_under(0.0)),
             (-HY, z_under(HY)), (-HY, Z1)]
    for sgn in (1, -1):
        v, f = F.prism_x(gable, sgn * (HX - 0.06), sgn * HX)
        F.part(parts, 'gable_%d' % sgn, 'skin', v, f, jit=0.003,
               seed=203 + (sgn > 0))


# ---------------------------------------------------------------------------
# ЯРУС 3: ДЕРЕВЯННЫЙ КАРКАС — ОБВЯЗКИ, СТОЙКИ, РАСКОСЫ
# ---------------------------------------------------------------------------
def _stud(parts, name, wall, plane, a, z0, z1, w=0.11,
          faces=('out', 's1', 's2')):
    F.stick(parts, name, wall, plane, a - w / 2.0, a + w / 2.0, z0, z1,
            t=FRAME_T, out=FRAME_OUT, faces=faces, lean=None)


def _brace(parts, name, wall, plane, a0, za, a1, zb, t=0.07, w=0.09):
    """Раскос: брусок из (a0, za) в (a1, zb), заведённый в стойки на `over`.

    `see` = нормаль стены и «верх»: без него у бруска остаются все боковины,
    а с одними торцами он превращается в полую трубу (references/pitfalls).
    """
    sgn = 1.0 if wall in ('+y', '+x') else -1.0
    dep = sgn * (plane + FRAME_OUT - t / 2.0)
    if wall in ('+y', '-y'):
        p0, p1 = (a0, dep, za), (a1, dep, zb)
        see = ((0.0, sgn, 0.0), (0.0, 0.0, 1.0))
    else:
        p0, p1 = (dep, a0, za), (dep, a1, zb)
        see = ((sgn, 0.0, 0.0), (0.0, 0.0, 1.0))
    v, f = F.bar(p0, p1, t, w, see=see, over=0.045)
    F.part(parts, name, 'trunk', v, f, lean=None)


def build_frame(parts):
    """Каркас фахверка: угловые стойки, обвязки по периметру, стойки, раскосы."""
    for sx in (1, -1):
        for sy in (1, -1):
            v, f = F.box(sx * CXP, sy * CYP, Z0, CP, CP, WALL_H,
                         keep=(('+x' if sx > 0 else '-x'),
                               ('-x' if sx > 0 else '+x'),
                               ('+y' if sy > 0 else '-y'),
                               ('-y' if sy > 0 else '+y'), '+z'))
            F.part(parts, 'corner_%d%d' % (sx, sy), 'trunk', v, f, lean=None)
    # обвязки по периметру: торцами прячутся в угловые стойки
    pin_x, pin_y = CXP - CP / 2.0, CYP - CP / 2.0     # внутренние кромки стоек
    for wall, plane, a0, a1, tag in (('+y', HY, -pin_x, pin_x, 'fy'),
                                     ('-y', HY, -pin_x, pin_x, 'by'),
                                     ('+x', HX, -pin_y, pin_y, 'px'),
                                     ('-x', HX, -pin_y, pin_y, 'mx')):
        for nm, zz in (('bp', (ZB0, ZB1)), ('tp', (ZT0, ZT1))):
            F.stick(parts, '%s_%s' % (tag, nm), wall, plane, a0, a1,
                    zz[0], zz[1], t=FRAME_T, out=FRAME_OUT,
                    faces=('out', 'top', 'bot'), lean=None)
    # фасад: косяки ворот + перекладина над проёмом
    for sg in (1, -1):
        _stud(parts, 'gate_jamb%d' % sg, '+y', HY, sg * 0.56, ZB1, GATE_TOP)
    F.stick(parts, 'gate_lintel', '+y', HY, -0.62, 0.62, GATE_TOP, ZT0,
            t=FRAME_T, out=FRAME_OUT,
            faces=('out', 'top', 'bot', 's1', 's2'), lean=None)
    # тыл: две стойки и два раскоса «домиком» от углов к стойкам
    for a in (-0.28, 0.28):
        _stud(parts, 'stud_b%d' % int(a * 100), '-y', HY, a, ZB1, ZT0)
    _brace(parts, 'brace_b0', '-y', HY, -0.83, ZB1 + 0.02, -0.30, ZT0 - 0.02)
    _brace(parts, 'brace_b1', '-y', HY, 0.83, ZB1 + 0.02, 0.30, ZT0 - 0.02)
    # торец +X: стойки и раскос в средней панели
    for a in (-0.30, 0.30):
        _stud(parts, 'stud_p%d' % int(a * 100), '+x', HX, a, ZB1, ZT0)
    _brace(parts, 'brace_p', '+x', HX, -0.30, ZB1 + 0.02, 0.30, ZT0 - 0.02)
    # торец -X (оконный): стойки + ригель над окном и подоконная обвязка
    for a in (-0.30, 0.30):
        _stud(parts, 'stud_m%d' % int(a * 100), '-x', HX, a, ZB1, ZT0)
    F.stick(parts, 'win_rail_t', '-x', HX, -0.34, 0.34, WIN_TOP, WIN_TOP + 0.10,
            t=FRAME_T, out=FRAME_OUT, faces=('out', 'top', 'bot'), lean=None)
    _sill_z = WIN_Z - WIN_SIZE / 2.0 - WIN_FW
    F.stick(parts, 'win_rail_b', '-x', HX, -0.34, 0.34, _sill_z - 0.11, _sill_z,
            t=FRAME_T, out=FRAME_OUT, faces=('out', 'top', 'bot'), lean=None)
    # щипцы: стойка-«король» и два раскоса под скаты (обе стороны)
    for sx, wall in ((1, '+x'), (-1, '-x')):
        F.stick(parts, 'gable_king%d' % sx, wall, HX, -0.05, 0.05, Z1 - 0.03,
                z_under(0.0) - 0.05, t=0.09, out=0.04,
                faces=('out', 's1', 's2'))
        F.stick(parts, 'gable_collar%d' % sx, wall, HX, -0.34, 0.34, 1.55,
                1.65, t=0.09, out=0.04, faces=('out', 'top', 'bot'))
        for sg in (1, -1):
            dep = sx * (HX + 0.04 - 0.035)
            v, f = F.bar((dep, sg * 0.44, ZT0 + 0.07), (dep, sg * 0.07, 2.02),
                         0.07, 0.08, caps=(0, 1), over=0.045)
            F.part(parts, 'gable_brace%d%d' % (sx, sg), 'trunk', v, f)


# ---------------------------------------------------------------------------
# ЯРУС 4: ВОРОТЦА (две створки) И ОКНО
# ---------------------------------------------------------------------------
def build_gate(parts):
    """Широкие воротца: тёмный проём, две створки с X-распорками и кузнечной
    оковкой (iron) — кузница показывает свой товар на собственных воротах."""
    v, f = F.box(0.0, HY + 0.008, Z0 + 0.005, GATE_W - 0.01, 0.012,
                 GATE_H - 0.01, keep=('+y',))
    F.part(parts, 'gate_hole', 'leather', v, f, lean=None)
    for sg in (1, -1):
        cx = sg * 0.255
        v, f = F.box(cx, HY + 0.045, Z0 + 0.015, 0.478, 0.035,
                     GATE_H - 0.035)
        F.part(parts, 'gate_leaf%d' % sg, 'trunk', v, f, jit=0.003,
               seed=330 + sg, lean=None)
        for k in (1, -1):
            v, f = F.bar((cx - k * 0.185, HY + 0.069, Z0 + 0.10),
                         (cx + k * 0.185, HY + 0.069, Z0 + GATE_H - 0.11),
                         0.028, 0.045, caps=(0, 1), over=0.02)
            F.part(parts, 'gate_brace%d_%d' % (sg, k), 'trunk', v, f, lean=None)
        # оковка: две жиковины от косяка внутрь створки
        for i, zz in enumerate((Z0 + 0.14, Z0 + GATE_H - 0.20)):
            v, f = F.box(sg * 0.34, HY + 0.067, zz, 0.32, 0.016, 0.045)
            F.part(parts, 'gate_strap%d_%d' % (sg, i), 'iron', v, f, lean=None)
    v, f = F.box(0.055, HY + 0.072, Z0 + 0.52, 0.02, 0.035, 0.075)
    F.part(parts, 'gate_handle', 'iron', v, f, lean=None)


def build_window(parts):
    """Одно окно на торце -X: рама-кольцо, тёмное стекло, переплёт, подоконник."""
    F.window(parts, 'win', '-x', HX, 0.0, WIN_Z, size=WIN_SIZE, fw=WIN_FW,
             out=0.05, depth=0.07, sill=True, lean=None)


# ---------------------------------------------------------------------------
# ЯРУС 5: НАВЕСЫ НАД ВХОДАМИ
# ---------------------------------------------------------------------------
def build_awnings(parts):
    """Навес над воротцами (плита на двух подкосах) и козырёк над окном:
    навес — это не кровля, у него свой уклон и своя толщина."""
    y_in, y_out = HY + 0.015, HY + 0.225
    z_in, z_out = 1.215, 1.115
    prof = [(y_in, z_in), (y_out, z_out), (y_out, z_out - 0.05),
            (y_in, z_in - 0.05)]
    v, f = F.prism_x(prof, -0.66, 0.66)
    F.part(parts, 'canopy_gate', 'leaf_autumn', v, f, jit=0.003, seed=520)
    v, f = F.bar((-0.66, y_out - 0.012, z_out + 0.008),
                 (0.66, y_out - 0.012, z_out + 0.008), 0.055, 0.045, caps=(0, 1))
    F.part(parts, 'canopy_edge', 'trunk', v, f)
    for sg in (1, -1):
        v, f = F.bar((sg * 0.56, HY + 0.03, 0.90),
                     (sg * 0.56, HY + 0.18, 1.100), 0.05, 0.05, caps=(0, 1))
        F.part(parts, 'canopy_strut%d' % sg, 'trunk', v, f, lean=None)
    # над окном: узкий козырёк (пятно застройки не пускает дальше 0.13)
    z_hi, z_lo = WIN_TOP + 0.075, WIN_TOP + 0.030
    v, f = F.bar((-HX + 0.010, 0.0, z_hi), (-HX - 0.085, 0.0, z_lo),
                 0.60, 0.045, caps=(0, 1))
    F.part(parts, 'awning_win', 'leaf_autumn', v, f, jit=0.002, seed=525)
    for sg in (1, -1):
        v, f = F.bar((-HX + 0.03, sg * 0.26, WIN_TOP + 0.02),
                     (-HX - 0.075, sg * 0.26, WIN_TOP + 0.045), 0.035, 0.04,
                     caps=(0, 1))
        F.part(parts, 'awning_strut%d' % sg, 'trunk', v, f)


# ---------------------------------------------------------------------------
# ЯРУС 6: КРОВЛЯ — ПЛАСТЫ СОЛОМЫ
# ---------------------------------------------------------------------------
def build_roof(parts, rng):
    """Кровля: пласты соломы ступенями, гребень, прижимная жердь, лобовые доски.

    Тело кровли — ОДНА ЗАМКНУТАЯ призма по контуру «пилы»: разрезные плиты
    оставляли под собой пустоту, и с низкого ракурса в неё видно изнанку.
    Пласты подрезаны сдвигом вниз так, чтобы все верхушки легли ПОД прямую
    линию: иначе лобовая доска их не закрывает.
    """
    n = N_PLAST
    w = [1.0 + 0.55 * (n - 1 - i) / (n - 1.0) for i in range(n)]
    w = [wi * rng.uniform(0.90, 1.10) for wi in w]
    s = sum(w)
    bounds = [EAVE_Y]
    for wi in w:
        bounds.append(bounds[-1] - wi / s * EAVE_Y)
    bounds[-1] = 0.0

    steps, mids = [], []
    acc = 0.0
    for i in range(n):
        acc += rng.uniform(0.020, 0.030)
        steps.append(acc)
        mids.append((bounds[i] + bounds[i + 1]) / 2.0)

    def raw(i, ay):
        return (z_nom(ay) + steps[i]
                + 0.012 * (1.0 if i % 2 else -1.0) * (ay - mids[i]) / EAVE_Y)

    z_eave, z_ridge = raw(0, EAVE_Y), raw(n - 1, 0.0)

    def line(ay):
        return z_ridge + (z_eave - z_ridge) * (ay / EAVE_Y)

    exc = max(max(raw(i, bounds[i]) - line(bounds[i]),
                  raw(i, bounds[i + 1]) - line(bounds[i + 1]))
              for i in range(n))
    if exc > -0.008:
        steps = [st - (exc + 0.008) for st in steps]

    def top(i, ay):
        return raw(i, ay)

    poly = [(EAVE_Y, z_under(EAVE_Y)), (EAVE_Y, top(0, EAVE_Y))]
    for i in range(1, n):
        poly.append((bounds[i], top(i - 1, bounds[i])))
        poly.append((bounds[i], top(i, bounds[i])))
    poly.append((0.0, top(n - 1, 0.0)))
    for i in range(n - 1, 0, -1):
        poly.append((-bounds[i], top(i, bounds[i])))
        poly.append((-bounds[i], top(i - 1, bounds[i])))
    poly.append((-EAVE_Y, top(0, EAVE_Y)))
    poly.append((-EAVE_Y, z_under(EAVE_Y)))
    poly.append((0.0, z_under(0.0)))
    v, f = F.prism_x(poly, -PLANK_X, PLANK_X)
    F.part(parts, 'roof_thatch', 'leaf_autumn', v, f, jit=0.003, seed=401)

    # лобовые доски: призма по тому же контуру, низ утоплен под солому
    for sx in (1, -1):
        for sg in (1, -1):
            prof = [(sg * (EAVE_Y - 0.005), line(EAVE_Y) - 0.05),
                    (sg * (EAVE_Y - 0.005), line(EAVE_Y) + 0.075),
                    (0.0, line(0.0) + 0.065), (0.0, line(0.0) - 0.055)]
            v, f = F.prism_x(prof, sx * PLANK_X, sx * ROOF_X)
            F.part(parts, 'barge%d%d' % (sx, sg), 'trunk', v, f)
    # оборванный край соломы по карнизу
    seg = (2 * PLANK_X) / 3.0
    for sy in (1, -1):
        for i in range(3):
            drop = rng.uniform(0.035, 0.075)
            ztop = z_under(EAVE_Y - 0.03) + 0.045
            v, f = F.box(-PLANK_X + seg * (i + 0.5), sy * (EAVE_Y - 0.03),
                         ztop - drop, seg - 0.025, 0.07, drop + 0.05,
                         )
            F.part(parts, 'eave_rag%d_%d' % (sy, i), 'leaf_autumn', v, f,
                   jit=0.005, seed=410 + i + (0 if sy > 0 else 9))
    # конёк: соломенный гребень + прижимная жердь с выпущенными концами
    rz = top(n - 1, 0.0)
    cap = [(0.19, rz - 0.28), (0.0, rz + 0.05), (-0.19, rz - 0.28)]
    v, f = F.prism_x(cap, -PLANK_X - 0.04, PLANK_X + 0.04)
    F.part(parts, 'ridge_cap', 'leaf_autumn', v, f, jit=0.003, seed=420)
    v, f = F.bar((-PLANK_X - 0.06, 0.0, rz + 0.075),
                 (PLANK_X + 0.06, 0.0, rz + 0.075), 0.05, 0.05, caps=(0, 1))
    F.part(parts, 'ridge_pole', 'trunk', v, f)


# ---------------------------------------------------------------------------
# ЯРУС 7: КАМЕННАЯ ТРУБА КУЗНЕЧНОГО ГОРНА
# ---------------------------------------------------------------------------
def build_chimney(parts, rng):
    """Труба горна: каменная, с сужением, козырьком и тёмным устьем.

    Смещена от конька (CHX, CHY): на коньке её съедает гребень, а горн стоит
    у стены — отсюда и место трубы на скате.
    """
    blocks = ((0.38, 0.20), (0.345, 0.19), (0.315, 0.18), (0.29, 0.17))
    z = 1.62
    for i, (sxy, h) in enumerate(blocks):
        v, f = F.box(CHX + rng.uniform(-0.008, 0.008),
                     CHY + rng.uniform(-0.008, 0.008), z, sxy, sxy, h,
                     rz=math.radians(rng.uniform(-4.0, 4.0)))
        F.part(parts, 'chimney_%d' % i, 'stone', v, f, jit=0.004, seed=430 + i)
        z += h - 0.012
    v, f = F.box(CHX, CHY, z, 0.44, 0.44, 0.06)
    F.part(parts, 'chimney_cap', 'stone', v, f, jit=0.004, seed=436)
    v, f = F.box(CHX, CHY, z + 0.06, 0.235, 0.235, 0.19)
    F.part(parts, 'chimney_neck', 'stone', v, f, jit=0.003, seed=437)
    v, f = F.box(CHX, CHY, z + 0.25, 0.27, 0.27, 0.05)
    F.part(parts, 'chimney_top', 'stone', v, f, jit=0.003, seed=438)
    v, f = F.box(CHX, CHY, z + 0.30, 0.135, 0.135, 0.045)
    F.part(parts, 'chimney_flue', 'leather', v, f)


# ---------------------------------------------------------------------------
# ЯРУС 8: ДВОР — КАДКА ДЛЯ ЗАКАЛКИ И ЗАГОТОВКИ ЖЕЛЕЗА
# ---------------------------------------------------------------------------
def build_yard(parts, rng):
    """Двор кузницы: кадка для закалки и стопка железных заготовок.

    Пятно 2 x 2 занято стенами (|x|<=0.88, |y|<=0.72), поэтому двор — узкая
    полоса ПЕРЕД фасадом, между цоколем (0.765) и кромкой пятна (0.99).  Всё
    стоит НА землю и вплотную к цоколю: деталь внутри объёма стен автоотсев
    выбрасывает целиком, а висящая в воздухе читается ошибкой.
    """
    bx, by, R = 0.64, 0.875, 0.105
    poly = [(bx + math.cos(math.radians(60 * k + 30)) * R,
             by + math.sin(math.radians(60 * k + 30)) * R) for k in range(6)]
    r_mid = [(bx + (p[0] - bx) * 1.10, by + (p[1] - by) * 1.10) for p in poly]
    v = ([(p[0], p[1], 0.0) for p in poly]
         + [(p[0], p[1], 0.09) for p in poly]
         + [(p[0], p[1], 0.18) for p in r_mid]
         + [(p[0], p[1], 0.26) for p in poly])
    f = []
    for lvl in range(3):
        a, b = lvl * 6, (lvl + 1) * 6
        for k in range(6):
            k2 = (k + 1) % 6
            f.append((a + k, a + k2, b + k2, b + k))
    f.append(tuple(range(5, -1, -1)))
    f.append(tuple(range(18, 24)))
    f = F.cull(v, f, see=F.SEE_ALL + ((0.0, 0.0, -1.0),))
    F.part(parts, 'quench_barrel', 'trunk', v, f, jit=0.003, seed=450)
    # вода — своё шестиугольное зеркало ПОВЕРХ крышки: внутри кадки её
    # выбрасывает автоотсев вместе с верхней гранью
    wp = [(bx + math.cos(math.radians(60 * k + 30)) * R * 0.88,
           by + math.sin(math.radians(60 * k + 30)) * R * 0.88) for k in range(6)]
    v = ([(p[0], p[1], 0.260) for p in wp] + [(p[0], p[1], 0.272) for p in wp])
    f = [(k, (k + 1) % 6, 6 + (k + 1) % 6, 6 + k) for k in range(6)]
    f.append(tuple(range(6, 12)))
    F.part(parts, 'quench_water', 'iron', v, f)
    # заготовки: три железных бруска у другого угла фасада (с зазором, чтобы
    # верхний не оказался утоплен в нижние и не потерял все фасеты)
    for i, (dy, zz, rz) in enumerate(((0.845, 0.0, -4.0), (0.935, 0.0, 3.0),
                                      (0.890, 0.052, -1.0))):
        v, f = F.box(-0.62, dy, zz, 0.32, 0.080, 0.05, rz=math.radians(rz),
                     )
        F.part(parts, 'iron_stock%d' % i, 'iron', v, f, jit=0.002, seed=460 + i)


# ---------------------------------------------------------------------------
# СБОРКА
# ---------------------------------------------------------------------------
def build(variant=None):
    """Собрать кузницу.  `variant` зарезервирован под будущие варианты."""
    rng = random.Random(11)
    parts = []
    build_plinth(parts, rng)
    build_walls(parts)
    build_frame(parts)
    build_gate(parts)
    build_window(parts)
    build_awnings(parts)
    build_roof(parts, rng)
    build_chimney(parts, rng)
    build_yard(parts, rng)
    F.ground(parts)
    F.autocull(parts)
    return parts


if __name__ == '__main__':
    p = build()
    print(F.stats(p))
    for k, v in F.census(p).most_common(14):
        print('  %-18s %4d трис' % (k, v))
