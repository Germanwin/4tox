"""building.py — ШАБЛОН генератора постройки. Копируй и правь под свой объект.

Здесь собран working-пример: сарай 2 x 2 (другой класс, чем дом жителя 3 x 2),
но с теми же приёмами — ярусы, прижатый к стене каркас, ворота с X-распорками,
кровля пластами дранки.  Это не «заготовка с TODO», а собранная постройка:
её можно сразу прогнать через `xray.py probe`, `canon.py` и живую сборку
`build_live.py`, и она проходит приёмку.

ЧТО МЕНЯТЬ ПОД СВОЮ ПОСТРОЙКУ, в порядке важности:
    1. SPEC — пятно застройки, высоты, уклон, свесы, диапазоны канона;
    2. ярусы в build(): размеры стен, раскладку проёмов, материал кровли;
    3. `build_frame()` — где стойки и обвязки, если каркас вообще есть.

ЧЕГО НЕ ДЕЛАТЬ НИКОГДА:
    * не считать «номинал» и «наклон» одной величиной (см. forge.wall_lean);
    * не оставлять конец бруса в воздухе: раскос либо доходит до стойки, либо
      его нет (см. references/pitfalls.md);
    * не звать autocull в середине сборки — только в самом конце.
"""
import math
import random

import forge as F

# --------------------------------------------------------------------------
# КАНОННЫЕ РАЗМЕРЫ ЭТОЙ ПОСТРОЙКИ
# --------------------------------------------------------------------------
SPEC = dict(
    footprint=(2, 2),            # клетки карты: X — длинная сторона
    wall_x=1.80, wall_y=1.40,    # оси стен (номинал, до наклона)
    wall_h=1.10,                 # высота стен
    z_plinth=0.14,               # верх цоколя
    z_wall=1.24,                 # верх стен (z_plinth + wall_h)
    pitch_deg=33.0,              # тёс/дранка: канон 32..35
    over_slope=0.18, over_end=0.10,   # свес >=11% ширины стены (канон)
    ridge_z=None,                     # подставится из геометрии ниже
    class_='building',
    canon=dict(h_b=(1.55, 2.40), roof_wall=(0.30, 0.75), pitch=(32.0, 35.0)),
)

HX, HY = SPEC['wall_x'] / 2.0, SPEC['wall_y'] / 2.0
Z0, Z1 = SPEC['z_plinth'], SPEC['z_wall']
TAN_LEAN = math.tan(math.radians(1.0))
LEAN = F.wall_lean(Z0, SPEC['wall_h'], TAN_LEAN)

TAN_P = math.tan(math.radians(SPEC['pitch_deg']))
COS_P = math.cos(math.radians(SPEC['pitch_deg']))
FRAME_OUT, FRAME_T = 0.04, 0.09          # выступ и толщина бруса каркаса
ROOF_Y0 = HY + FRAME_OUT                 # низ кровли идёт по наружной кромке обвязки
EAVE_Y = HY + SPEC['over_slope']         # кромка кровли по Y
ROOF_X = HX + SPEC['over_end']           # кромка кровли по X
ROOF_T = 0.09                            # толщина кровли
RIDGE_Z = Z1 + ROOF_Y0 * TAN_P + ROOF_T / COS_P
SPEC['ridge_z'] = round(RIDGE_Z, 3)      # приёмка сравнивает конёк с каноном


def z_under(y):
    """Низ кровли: плоскость через наружную кромку верхней обвязки."""
    return Z1 + (ROOF_Y0 - abs(y)) * TAN_P


# --------------------------------------------------------------------------
# ЯРУС 1: ЦОКОЛЬ
# --------------------------------------------------------------------------
def build_plinth(parts, rng):
    px, py = HX + 0.04, HY + 0.04
    v, f = F.box(0.0, 0.0, 0.0, 2 * px, 2 * py, Z0 + 0.03)
    F.part(parts, 'plinth_core', 'stone', v, f, jit=0.004, seed=101)
    n = 4
    w = 2 * px / n
    for sy_ in (1, -1):
        for i in range(n):
            v, f = F.box(-px + w * (i + 0.5), sy_ * (py + 0.02), 0.0, w - 0.03,
                         0.04, Z0 + rng.uniform(-0.01, 0.02),
                         rz=math.radians(rng.uniform(-3, 3)))
            F.part(parts, 'plinth_y%d_%d' % (sy_, i), 'stone', v, f,
                   jit=0.003, seed=110 + i)


# --------------------------------------------------------------------------
# ЯРУС 2: СТЕНЫ И КАРКАС
# --------------------------------------------------------------------------
def build_walls(parts):
    """Стены сарая — доски, а не обмазка: семейство `trunk`, не `skin`."""
    v, f = F.box(0.0, 0.0, Z0, SPEC['wall_x'], SPEC['wall_y'], SPEC['wall_h'],
                 keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    F.part(parts, 'wall_core', 'trunk', v, f, jit=0.004, seed=201, lean=LEAN)
    # щипец — пятиугольник: низ по верху стены, скаты ровно по низу кровли
    # Щипец — ЗАМКНУТАЯ призма (оба торца и боковины), а не одна плоскость.
    # Под кровлей есть полость (чердак), и через открытый свес снизу в неё
    # заходит луч: односторонний щипец в этом случае виден ИЗНАНКУ.  Замкнутый
    # щипец закрывает полость, и счётчик изнанок молчит.
    gable = [(HY, Z1), (HY, z_under(HY)), (0.0, z_under(0.0)),
             (-HY, z_under(HY)), (-HY, Z1)]
    for sgn in (1, -1):
        v, f = F.prism_x(gable, sgn * (HX - 0.05), sgn * HX)
        F.part(parts, 'gable_%d' % sgn, 'trunk', v, f, jit=0.003, seed=203)


def build_frame(parts):
    """Обвязки по периметру и стойки по углам — каркас сарая простой."""
    z_bot0, z_bot1 = Z0, Z0 + 0.09
    z_top0, z_top1 = Z1 - 0.09, Z1
    for sgn in (1, -1):
        wy = '+y' if sgn > 0 else '-y'
        wx = '+x' if sgn > 0 else '-x'
        F.stick(parts, 'plate_by%d' % sgn, wy, HY, -HX, HX, z_bot0, z_bot1,
                t=FRAME_T, out=FRAME_OUT, faces=('out', 'top', 'bot'))
        F.stick(parts, 'plate_ty%d' % sgn, wy, HY, -HX, HX, z_top0, z_top1,
                t=FRAME_T, out=FRAME_OUT, faces=('out', 'top', 'bot'))
        F.stick(parts, 'plate_bx%d' % sgn, wx, HX, -HY, HY, z_bot0, z_bot1,
                t=FRAME_T, out=FRAME_OUT, faces=('out', 'top', 'bot'))
        F.stick(parts, 'plate_tx%d' % sgn, wx, HX, -HY, HY, z_top0, z_top1,
                t=FRAME_T, out=FRAME_OUT, faces=('out', 'top', 'bot'))
    for sx_ in (1, -1):
        for sy_ in (1, -1):
            v, f = F.box(sx_ * (HX + FRAME_OUT - 0.06), sy_ * (HY + FRAME_OUT - 0.06),
                         Z0, 0.12, 0.12, SPEC['wall_h'],
                         keep=(('+x' if sx_ > 0 else '-x'),
                               ('+y' if sy_ > 0 else '-y'), '+z'))
            F.part(parts, 'corner_%d%d' % (sx_, sy_), 'trunk', v, f, lean=LEAN)
    # промежуточные стойки тыла и торцов: панели сарая широкие, без стоек
    # доска walls читается как один серый лист
    for sgn in (1, -1):
        for a in (-0.45, 0.45):
            F.stick(parts, 'stud_b%d_%d' % (sgn, int(a * 100)), '-y', HY,
                    a * sgn - 0.045, a * sgn + 0.045, z_bot1, z_top0,
                    t=FRAME_T, out=FRAME_OUT, faces=('out', 's1', 's2'))
        F.stick(parts, 'stud_s%d' % sgn, '+x' if sgn > 0 else '-x', HX,
                -0.35, 0.35, z_bot1, z_top0, t=FRAME_T, out=FRAME_OUT,
                faces=('out', 's1', 's2'))


# --------------------------------------------------------------------------
# ЯРУС 3: ВОРОТА И ОКНО
# --------------------------------------------------------------------------
def build_gate(parts):
    """Ворота 0.90 x 0.90: две створки, у каждой X-распорка (канон §4)."""
    w, h = 0.90, 0.90
    y = HY + 0.015
    v, f = F.box(0.0, y, Z0 + 0.01, w + 0.02, 0.012, h, keep=('+y',))
    F.part(parts, 'gate_hole', 'leather', v, f, lean=LEAN)
    for sg in (1, -1):
        cx = sg * (w / 4.0 + 0.005)
        v, f = F.box(cx, y + 0.025, Z0 + 0.03, w / 2.0 - 0.02, 0.035, h - 0.04,
                     keep=('+y', '+z', '-z', ('+x' if sg > 0 else '-x')))
        F.part(parts, 'gate_leaf%d' % sg, 'trunk', v, f, jit=0.003,
               seed=330 + sg, lean=LEAN)
        # X-распорка: две ПЕРЕКРЁСТНЫЕ балки.  Зеркальная пара на одной глубине
        # даёт совпадающие плоскости (z-fighting) и вдвое больше трис на пустом
        # месте — поэтому вторая балка сдвинута по глубине на 0.015.
        for k in (1, -1):
            z_lo = Z0 + (0.06 if k > 0 else h - 0.06)
            z_hi = Z0 + (h - 0.06 if k > 0 else 0.06)
            dep = 0.042 if k > 0 else 0.057
            v, f = F.bar((cx - sg * (w / 4.0 - 0.05), y + dep, z_lo),
                         (cx + sg * (w / 4.0 - 0.05), y + dep, z_hi),
                         0.03, 0.05)
            F.part(parts, 'gate_brace%d_%d' % (sg, k), 'trunk', v, f, lean=LEAN)
    v, f = F.box(0.0, HY + 0.06, 0.0, 1.10, 0.16, 0.06,
                 keep=('+y', '+z', '+x', '-x'))
    F.part(parts, 'gate_step', 'stone', v, f, jit=0.003, seed=340)


def build_window(parts):
    """Одно окно 0.24 в тылу — тем же кольцом, что у дома."""
    F.window(parts, 'win_b', '-y', HY, 0.0, Z0 + 0.45 * SPEC['wall_h'],
             size=0.24, fw=0.04, out=0.04, depth=0.06, lean=LEAN)


# --------------------------------------------------------------------------
# ЯРУС 4: КРОВЛЯ ИЗ ДРАНКИ
# --------------------------------------------------------------------------
def build_roof(parts, rng):
    """Кровля: СПЛОШНОЙ подстилающий слой + дранка поверх него.

    Почему два слоя, а не одни доски.  Доски не могут покрыть скат без швов:
    где-то доска короче, где-то шов шире, и любая такая щель — это ДЫРА, через
    которую с косого луча видно небо или изнанку щипца (счётчик изнанок
    показывает это тонкими красными линиями вдоль швов).  Поэтому:

      1) подстилающий слой — сплошная плита по всему скату, от конька до
         карниза: она закрывает полость под кровлей герметично (+12 трис);
      2) дранка — доски поверх плиты, рядами с нахлёстом 35%: они дают фактуру
         и «сдвиг», но их швы уже ничего не открывают.

    Доски каждого ряда утоплены в плиту, а не лежат на ней впритык: стык
    «плоскость в плоскость» даёт совпадающие плоскости, а заход внутрь — нет.
    """
    rows = 4
    step = EAVE_Y / rows                     # шаг ряда по скату
    lap = step * 0.35                        # нахлёст на нижний ряд
    base_t = 0.035                           # толщина подстилающей плиты
    edge = ROOF_X - 0.02                     # до кромки не доходим: там лобовая доска
    for sy_ in (1, -1):
        # подстилающая плита: низ по z_under, верх на base_t выше
        prof = [(sy_ * 0.0, z_under(0.0) + base_t), (sy_ * EAVE_Y, z_under(EAVE_Y) + base_t),
                (sy_ * EAVE_Y, z_under(EAVE_Y)), (sy_ * 0.0, z_under(0.0))]
        v, f = F.prism_x(prof, -edge, edge)
        # nocull: плита — подстилающий слой.  Её верхняя грань скрыта дранкой,
        # и автоотсев честно её выбросил бы; тогда в швах дранки начинала
        # светить ИЗНАНКА нижней грани (тонкие красные линии на карте изнанок).
        F.part(parts, 'roof_base_%d' % sy_, 'leaf_autumn', v, f, jit=0.002,
               seed=390, nocull=True)
        for r in range(rows):
            d0 = max(0.0, r * step - lap)    # низ ряда (заходит на нижний)
            d1 = (r + 1) * step              # верх ряда
            y_lo, y_hi = EAVE_Y - d1, EAVE_Y - d0
            top_r = base_t + 0.012 * (r + 1)
            bot_r = top_r - 0.030            # утоплено в плиту
            prof = [(sy_ * y_lo, z_under(y_lo) + top_r),
                    (sy_ * y_hi, z_under(y_hi) + top_r),
                    (sy_ * y_hi, z_under(y_hi) + bot_r),
                    (sy_ * y_lo, z_under(y_lo) + bot_r)]
            seg = (2 * edge) / 3.0
            off = (seg / 2.0 if (r % 2) else 0.0) + r * 0.007
            for k in range(3):
                x0 = max(-edge + seg * k + off, -edge) + 0.005
                x1 = min(x0 + seg, edge) - 0.005
                if x1 - x0 < 0.25:
                    continue
                v, f = F.prism_x(prof, x0, x1)
                F.part(parts, 'shingle_%d_%d_%d' % (sy_, r, k), 'leaf_autumn',
                       v, f, jit=0.002, seed=400 + r * 7 + k)
    # конёк: брус с выпущенными концами + гребень поверх стыка скатов
    v, f = F.bar((-ROOF_X - 0.03, 0.0, RIDGE_Z - 0.05),
                 (ROOF_X + 0.03, 0.0, RIDGE_Z - 0.05), 0.09, 0.09, caps=(0, 1))
    F.part(parts, 'ridge_beam', 'trunk', v, f)
    cap = [(0.16, RIDGE_Z - 0.11), (0.0, RIDGE_Z + 0.03), (-0.16, RIDGE_Z - 0.11)]
    v, f = F.prism_x(cap, -ROOF_X - 0.02, ROOF_X + 0.02)
    F.part(parts, 'ridge_cap', 'leaf_autumn', v, f, jit=0.002, seed=420)
    # лобовые доски по кромкам торцов
    for sx_ in (1, -1):
        for sy_ in (1, -1):
            v, f = F.bar((sx_ * (ROOF_X - 0.03), sy_ * EAVE_Y,
                          z_under(EAVE_Y) + base_t * 0.5),
                         (sx_ * (ROOF_X - 0.03), 0.0, RIDGE_Z - 0.03),
                         0.05, 0.11, caps=(0, 1))
            F.part(parts, 'barge_%d%d' % (sx_, sy_), 'trunk', v, f)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None):
    """Собрать постройку. Возвращает список деталей (dict name/family/verts/faces)."""
    rng = random.Random(11)
    parts = []
    build_plinth(parts, rng)
    build_walls(parts)
    build_frame(parts)
    build_gate(parts)
    build_window(parts)
    build_roof(parts, rng)
    F.ground(parts)
    F.autocull(parts)
    return parts


if __name__ == '__main__':
    p = build()
    print(F.stats(p))
    for k, v in F.census(p).most_common(10):
        print('  %-18s %4d трис' % (k, v))
