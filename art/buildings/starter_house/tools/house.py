"""house.py — СТАРТОВЫЙ ДОМ ЖИТЕЛЯ для mapgen2. Чистый Python, без bpy.

Деревня на ранней стадии: дом поставлен и почти покрыт, но работа не кончена.
Образец — РАТУША (`art/buildings/townhall/tools/townhall.py`), единственная
постройка, которую заказчик назвал идеальной. Оттуда взято ВСЁ, что определяет
школу, и ничего не додумано:

  1. ПАЛИТРА — те же двенадцать плоских красок (`thpal.py`), тот же hex.
     Никаких «тонов по нормали»: у ратуши цвет один на всю плоскость.
  2. ЦОКОЛЬ — ряд отдельных валунов по периметру + забутовка + верхняя плита
     + пятна мха по углам.
  3. КРОВЛЯ — НЕСКОЛЬКО ПЛОСКИХ ПЛОСКОСТЕЙ: два ската, торцевые заделки,
     провисший конёк из сегментов, прижимные слеги, заплаты из старой соломы.
  4. КАРКАС — обвязки, угловые столбы, стойки, ригель, раскосы 45°, всё
     выступает за плоскость стены на 0.05.
  5. ПРОЁМЫ — тёмное нутро, наличник из досок, дощатое полотно, кольцо.

ЧТО ЗДЕСЬ ДРУГОЕ (ранняя стадия — дом НЕ ДОСТРОЕН, а не сломан):
  1. Кровля недомощена: на переднем скате у карниза не хватает куска соломы —
     видны стропила и обрешётка. Кроют снизу вверх, поэтому недоложен именно
     низ ската.
  2. Одна панель стены без обмазки: стоит голый плетень (колья и прутья).
  3. Цоколь не досложен: два валуна вынуты из ряда и лежат у своей лунки.
  4. Двор стройки: штабель брёвен и вязанка соломы.
  5. Печи нет — трубы нет. Обжитой мелочи (ставни, поленница, кадка) нет.

ГЕОМЕТРИЯ.  Пятно 2 x 3: X — короткая сторона (2 клетки), Y — длинная (3),
дверь смотрит в +Y. Конёк идёт ВДОЛЬ длинной оси (Y), щипцы — на торцах ±Y,
скаты падают по ±X. Оси стен — номинал (0.84 / 1.40), наклон вниз внутрь.
Ярусы: цоколь -> стены с каркасом -> проёмы -> кровля -> конёк -> двор.

ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ: интерьера (камера наружная), рига, анимации;
меш намеренно не замкнут — грани, скрытые от камеры, не строятся.
"""
import math
import random

import forge as F

# --------------------------------------------------------------------------
# СПЕКА ПОСТРОЙКИ.  wall_x / wall_y — по конвенции приёмки `canon.py`:
# wall_x — сторона ВДОЛЬ конька, wall_y — ПОПЕРЁК скатов.  В модели конёк идёт
# по оси Y, поэтому wall_x = 2.80 (ось Y), wall_y = 1.68 (ось X).  Путать их
# нельзя: от этого зависят отношения свесов и габаритная проверка пятна.
# --------------------------------------------------------------------------
PLINTH_H = 0.15                    # канон дома: цоколь 0.15, выступ блока 0.06
WALL_X, WALL_Y = 1.66, 2.80        # оси стен: X — поперёк скатов, Y — вдоль конька
HX, HY = WALL_X / 2.0, WALL_Y / 2.0
WALL_T = 0.08                      # толщина обмазки (плита, не короб)
Z0 = PLINTH_H                      # низ стен, верх цоколя
WALL_H = 1.42                      # канон дома 1.20..1.50
Z1 = Z0 + WALL_H                   # 1.57 — верх стен (номинал: наклон ниже)
TAN_LEAN = math.tan(math.radians(1.2))
LEAN = F.wall_lean(Z0, WALL_H, TAN_LEAN)

FRAME_OUT, FRAME_T = 0.05, 0.10    # выступ и толщина бруса каркаса

# --- КРОВЛЯ: конёк вдоль Y, скаты падают по +-X ---------------------------
RIDGE_X = -0.05                    # конёк смещён: скаты РАЗНОЙ крутизны
Z_RIDGE_S = 2.60                   # низ кровли на коньке
Z_EAVE_X = 1.025                   # кромка кровли по X (свес 0.195 = 11.7% стены)
TAN_F = (Z_RIDGE_S - Z1) / (HX - RIDGE_X)      # передний скат (+X) 49.2 град
TAN_B = (Z_RIDGE_S - Z1) / (HX + RIDGE_X)      # задний скат (-X)  52.5 град
OVER_SLOPE = Z_EAVE_X - HX                     # 0.19
OVER_END = 0.115                   # свес по торцу (4.1% длины конька)
ROOF_HALF_Y = HY + OVER_END        # 1.515
ROOF_T = 0.11                      # толщина соломы
CUT_X = 0.72                       # докуда недомощен передний скат
CUT_Y = -0.15                      # с какой стороны видна недомощенность

PITCH_F = math.degrees(math.atan(TAN_F))
PITCH_B = math.degrees(math.atan(TAN_B))


def z_soffit(x):
    """Нижняя плоскость кровли: через верх стен на кромке стены (номинал)."""
    if x > RIDGE_X:
        return Z_RIDGE_S - (x - RIDGE_X) * TAN_F
    return Z_RIDGE_S - (RIDGE_X - x) * TAN_B


# --------------------------------------------------------------------------
# МЕЛКИЕ ПОСТРОИТЕЛИ
# --------------------------------------------------------------------------
def box(parts, name, fam, cx, cy, z0, sx, sy, sz, keep=None, jit=0.0, seed=0,
        lean=None, rz=0.0, nocull=False):
    v, f = F.box(cx, cy, z0, sx, sy, sz, rz=rz, keep=keep)
    return F.part(parts, name, fam, v, f, jit=jit, seed=seed, lean=lean,
                  nocull=nocull)


def slab_x(parts, name, fam, x0, x1, z0, z1, y0, y1, jit=0.0, seed=0,
           nocull=False):
    """Плита стены: тонкая по X (обмазка вдоль длинной стены)."""
    return box(parts, name, fam, (x0 + x1) / 2.0, (y0 + y1) / 2.0, z0,
               abs(x1 - x0), abs(y1 - y0), z1 - z0, jit=jit, seed=seed,
               nocull=nocull)


def slab_y(parts, name, fam, y0, y1, z0, z1, x0, x1, jit=0.0, seed=0,
           nocull=False):
    """Плита стены: тонкая по Y (торец, щипец)."""
    return box(parts, name, fam, (x0 + x1) / 2.0, (y0 + y1) / 2.0, z0,
               abs(x1 - x0), abs(y1 - y0), z1 - z0, jit=jit, seed=seed,
               nocull=nocull)


def stick6(parts, name, wall, plane, a0, a1, z0, z1, t=FRAME_T, out=FRAME_OUT,
           fam='timber', jit=0.0, seed=0):
    """Брусок каркаса ЗАМКНУТЫМ коробом (все шесть граней).

    `forge.stick` оставляет пять граней: шестая — та, что прижата к стене.
    Годится это не везде: у панели с голым плетнем стены за бруском нет, видно
    насквозь, и выброшенная грань светила изнанкой (замер xray: 25 px).
    """
    sgn = 1.0 if wall in ('+y', '+x') else -1.0
    if wall in ('+y', '-y'):
        cx, cy = (a0 + a1) / 2.0, sgn * (plane + out - t / 2.0)
        sx, sy = abs(a1 - a0), t
    else:
        cx, cy = sgn * (plane + out - t / 2.0), (a0 + a1) / 2.0
        sx, sy = t, abs(a1 - a0)
    return box(parts, name, fam, cx, cy, z0, sx, sy, z1 - z0, jit=jit, seed=seed)


def bar(parts, name, fam, p0, p1, sx, sy, caps=(0, 1), seed=0, jit=0.0):
    v, f = F.bar(p0, p1, sx, sy, caps=caps)
    return F.part(parts, name, fam, v, f, jit=jit, seed=seed)


# --------------------------------------------------------------------------
# ЯРУС 1: ЦОКОЛЬ
# --------------------------------------------------------------------------
def build_plinth(parts):
    """Ряд КРУПНЫХ валунов по периметру + забутовка + полка + мох.

    Как у ратуши: снаружи виден ряд отдельных валунов, а не гладкая плита.
    Валун 0.40 x 0.22 x 0.22, выступает за стену на 0.06..0.10, верх валуна на
    0.07 ВЫШЕ полки: ряд читается отдельно, а полка (по ней стоят стены)
    спрятана за ним.  Плита-полка поэтому узкая (по плоскости стен) и низкая —
    прошлая ревизия клала её шире ряда, и цоколь читался бетонной отмосткой.

    Цоколь НЕ ДОСЛОЖЕН: на +X стороне у фасада двух валунов нет — там видна
    лунка (утоптанная земля), а сами валуны лежат рядом, у своего места.
    """
    rng = random.Random(31)
    out = 0.07                                   # выступ валуна за стену
    # забутовка: ядро под стенами (его не видно — держит ряд и полку)
    box(parts, 'plinth_core', 'stone2', 0.0, 0.0, 0.0, WALL_X - 0.08,
        WALL_Y - 0.08, PLINTH_H - 0.02, jit=0.004, seed=3)
    # полка под стены: узкая (по плоскости стен) и НИЖЕ верха валунов
    box(parts, 'plinth_top', 'stone2', 0.0, 0.0, PLINTH_H - 0.09, WALL_X + 0.02,
        WALL_Y + 0.02, 0.09, jit=0.003, seed=4)

    def boulder(name, cx, cy, sx, sy, rz, seed):
        box(parts, name, 'stone', cx, cy, 0.0, sx, sy, PLINTH_H + 0.07,
            rz=rz, jit=0.008, seed=seed)

    # вдоль +-X (длинные стены): 6 валунов, у фасада два вынуты из ряда
    w = WALL_Y / 6.0
    gap_y = (0.62, 1.03)                         # лунка: откуда вынуты валуны
    for sgn in (1, -1):
        for i in range(6):
            c = -HY + w * (i + 0.5)
            if sgn > 0 and gap_y[0] < c < gap_y[1]:
                continue
            boulder('plinth_bx%d_%d' % (sgn, i),
                    sgn * (HX + out - 0.11), c + rng.uniform(-0.04, 0.04),
                    0.22, w - 0.05, math.radians(rng.uniform(-3, 3)), 100 + i)
    # вдоль +-Y (торцы): 3 валуна
    w2 = WALL_X / 3.0
    for sgn in (1, -1):
        for i in range(3):
            c = -HX + w2 * (i + 0.5)
            boulder('plinth_by%d_%d' % (sgn, i), c + rng.uniform(-0.04, 0.04),
                    sgn * (HY + out - 0.11), w2 - 0.05, 0.22,
                    math.radians(rng.uniform(-3, 3)), 200 + i)
    # лунка на месте вынутых валунов: утоптанная земля в ряд с цоколем
    box(parts, 'plinth_trench', 'dirt', HX + out - 0.10,
        sum(gap_y) / 2.0, 0.0, 0.13, gap_y[1] - gap_y[0], PLINTH_H - 0.02,
        jit=0.005, seed=7)
    # вынутые валуны лежат у своей лунки (входят в основание, как и цоколь).
    # Выступают дальше ряда: это и есть «цоколь не досложен», но за габарит
    # пятна не выходят — 0.96 при пятне 1.00.
    rng2 = random.Random(77)
    for k, (dy, s) in enumerate(((-0.19, 0.30), (0.19, 0.27))):
        boulder('plinth_loose_%d' % k, HX + out - 0.09,
                sum(gap_y) / 2.0 + dy, 0.18, s,
                math.radians(rng2.uniform(-14, 14)), 300 + k)
    # мох на верхней полке цоколя — как у ратуши: пятна у самой стены.
    # Стоит на плите цоколя (утоплен на 5 мм), за плоскость стены не заходит.
    mx = HX + out - 0.025
    for k, (sx_, cy) in enumerate(((1, HY - 0.20), (1, -HY + 0.24),
                                   (-1, -HY + 0.18))):
        box(parts, 'plinth_moss_%d' % k, 'moss', sx_ * mx, cy,
            PLINTH_H - 0.005, 0.045, 0.26, 0.04,
            rz=math.radians(rng.uniform(-9, 9)), jit=0.005, seed=400 + k)


# --------------------------------------------------------------------------
# ЯРУС 2: СТЕНЫ (обмазка плитами) И КАРКАС
# --------------------------------------------------------------------------
def build_walls(parts):
    """Стены плитами: где проём — там плиты вокруг него, а не наклейка.

    Канонная камера (азимут 45°, подъём 35.26°) смотрит на стены -X и +Y,
    поэтому НЕДОСТРОЙ собран на -X: там панель без обмазки (голый плетень) и
    окно, а на +X — только окно.  При повороте 180 видно +X и -Y: там читается
    недосложенный цоколь и вязанка соломы.
    """
    xi, xo = HX - WALL_T, HX          # внутренняя и наружная плоскости +X
    # Плиты, обрамляющие проём, не отсеваются: за ними не стена, а НУТРО дома,
    # и выброшенная грань светила изнанкой в проём (замер: wall_ym1_c 11 px).
    # ... и вся ВИДИМАЯ длинная стена: в её низ теперь врезается ряд крупных
    # валунов, и отсечённая грань светила изнанкой (замер: 23 px на повороте 315)
    NC = ('wall_xm1_a', 'wall_xm1_b', 'wall_xm1_c', 'wall_xm1_d', 'wall_xm1_e',
          'wall_x1_c', 'wall_x1_d',
          'wall_ym1_c', 'wall_ym1_d', 'wall_y1_c')
    # --- видимая длинная стена (-X): ПЛЕТЕНЬ без обмазки у фасада, окно у тыла
    for name, z0, z1, y0, y1, seed in (
            ('wall_xm1_a', Z0, Z1, -HY, -0.30, 211),
            ('wall_xm1_b', Z0, Z1, 0.42, 0.86, 212),
            ('wall_xm1_c', Z0, Z1, 1.14, HY, 213),
            ('wall_xm1_d', Z0, 0.61, 0.86, 1.14, 214),
            ('wall_xm1_e', 0.89, Z1, 0.86, 1.14, 215),
            ('wall_xm1_f', 1.20, Z1, -0.30, 0.42, 216)):
        slab_x(parts, name, 'wall', -xo, -xi, z0, z1, y0, y1,
               jit=0.004, seed=seed, nocull=name in NC)
    # --- глухая длинная стена (+X): окно посередине
    for name, z0, z1, y0, y1, seed in (
            ('wall_x1_a', Z0, Z1, -HY, -0.20, 201),
            ('wall_x1_b', Z0, Z1, 0.20, HY, 202),
            ('wall_x1_c', Z0, 0.61, -0.20, 0.20, 203),
            ('wall_x1_d', 0.89, Z1, -0.20, 0.20, 204)):
        slab_x(parts, name, 'wall', xi, xo, z0, z1, y0, y1,
               jit=0.004, seed=seed, nocull=name in NC)
    # --- торец +Y (фасад под щипцом): дверь посередине
    yi, yo = HY - WALL_T, HY
    slab_y(parts, 'wall_y1_a', 'wall', yi, yo, Z0, Z1, -HX + WALL_T, -0.18,
           jit=0.004, seed=221)
    slab_y(parts, 'wall_y1_b', 'wall', yi, yo, Z0, Z1, 0.18, HX - WALL_T,
           jit=0.004, seed=222)
    slab_y(parts, 'wall_y1_c', 'wall', yi, yo, Z0 + 0.80, Z1, -0.18, 0.18,
           jit=0.004, seed=223, nocull=True)
    # --- торец -Y: окно посередине
    slab_y(parts, 'wall_ym1_a', 'wall', -yo, -yi, Z0, Z1, -HX + WALL_T, -0.17,
           jit=0.004, seed=231)
    slab_y(parts, 'wall_ym1_b', 'wall', -yo, -yi, Z0, Z1, 0.17, HX - WALL_T,
           jit=0.004, seed=232)
    slab_y(parts, 'wall_ym1_c', 'wall', -yo, -yi, Z0, 0.61, -0.17, 0.17,
           jit=0.004, seed=233, nocull=True)
    slab_y(parts, 'wall_ym1_d', 'wall', -yo, -yi, 0.89, Z1, -0.17, 0.17,
           jit=0.004, seed=234, nocull=True)
    # --- плетень: колья и прутья в панели без обмазки (на -X, лицом к камере)
    for k, cy in enumerate((-0.30, -0.06, 0.18, 0.42)):
        box(parts, 'wattle_stake_%d' % k, 'timber', -HX + 0.03, cy, Z0, 0.05,
            0.05, 1.05, jit=0.004, seed=240 + k)
    for k in range(5):
        z = Z0 + 0.10 + 0.21 * k
        box(parts, 'wattle_rod_%d' % k, 'timber', -(HX - 0.055) - 0.012 * (k % 2),
            0.06, z, 0.03, 0.72, 0.045, jit=0.004, seed=250 + k)


def build_gables(parts):
    """Щипцы — ЗАМКНУТЫЕ призмы: полость под кровлей закрыта с торцов.

    Верх щипца на 0.02 НИЖЕ нижней плоскости кровли: ровно под скатом он лёг бы
    с ней в одну плоскость и дал z-fighting (C8), а щель спрятана под свесом
    кровли, который выступает за щипец на 0.115.
    """
    for sgn in (1, -1):
        poly = [(HX, Z1), (RIDGE_X, Z_RIDGE_S - 0.02), (-HX, Z1)]
        v, f = F.prism(poly, sgn * (HY - WALL_T - 0.004), sgn * (HY - 0.004),
                       axis=1)
        F.part(parts, 'gable_%d' % sgn, 'wall', v, f, jit=0.004,
               seed=260 + sgn)
        # слуховое окно щипца: тёмное нутро и наличник из четырёх досок
        cz = Z1 + 0.30
        box(parts, 'gable_%d_hole' % sgn, 'dark', 0.0, sgn * (HY + 0.005),
            cz - 0.13, 0.34, 0.02, 0.26)
        for k, (dx, dz, sx, sz) in enumerate(((0.0, 0.145, 0.42, 0.05),
                                              (0.0, -0.145, 0.42, 0.05),
                                              (0.185, 0.0, 0.05, 0.34),
                                              (-0.185, 0.0, 0.05, 0.34))):
            box(parts, 'gable_%d_frame_%d' % (sgn, k), 'plank', dx,
                sgn * (HY + 0.02), cz + dz - sz / 2.0, sx, 0.05, sz,
                jit=0.003, seed=270 + k)


def build_frame(parts):
    """Обвязки, угловые столбы, стойки, ригель и раскосы 45°.

    Верхняя обвязка — СПЛОШНАЯ плита по всему плану (как `walls` у ратуши), а не
    четыре бруска по периметру: брусок, лежащий вровень с верхом стены, кладёт
    свою верхнюю грань в одну плоскость с верхом обмазки — это C8. Плита
    утоплена на 0.02 в стены и накрывает их целиком, поэтому верх стен
    автоотсев гасит, а совпадающих плоскостей не остаётся.
    """
    zb0, zb1 = Z0, Z0 + 0.10
    box(parts, 'frame_plate_top', 'beam', 0.0, 0.0, Z1 - 0.02, WALL_X, WALL_Y,
        0.08, jit=0.003, seed=190)
    for sgn in (1, -1):
        wy = '+y' if sgn > 0 else '-y'
        wx = '+x' if sgn > 0 else '-x'
        # fam задан явно: у `forge.stick` умолчание — семейство атласа 'trunk',
        # которого в палитре ратуши нет (на этом сборка в Blender упала)
        F.stick(parts, 'frame_sill_y%d' % sgn, wy, HY, -HX, HX, zb0, zb1,
                t=FRAME_T, out=FRAME_OUT, fam='timber',
                faces=('out', 'top', 'bot'))
        F.stick(parts, 'frame_sill_x%d' % sgn, wx, HX, -HY, HY, zb0, zb1,
                t=FRAME_T, out=FRAME_OUT, fam='timber',
                faces=('out', 'top', 'bot'))
    for sx_ in (1, -1):
        for sy_ in (1, -1):
            box(parts, 'frame_post_%d%d' % (sx_, sy_),
                'timber', sx_ * (HX + FRAME_OUT - 0.06),
                sy_ * (HY + FRAME_OUT - 0.06), Z0, 0.12, 0.12, WALL_H + 0.02)
    # стойки: панели длинной стены широкие, без них обмазка читается листом
    for sgn in (1, -1):
        for a in (-0.72, 0.20, 1.10):
            stick6(parts, 'frame_stud_x%d_%d' % (sgn, int(a * 100)),
                   '+x' if sgn > 0 else '-x', HX, a - 0.05, a + 0.05,
                   zb1, Z1, seed=270 + int(a * 100) + sgn)
        stick6(parts, 'frame_stud_y%d' % sgn, '+y' if sgn > 0 else '-y', HY,
               -0.62, -0.52, zb1, Z1, seed=275 + sgn)
    # ригель по фасаду на линии верха двери
    for a in (-0.42, 0.42):
        # ригель — ЗАМКНУТЫМ коробом: он стоит над проёмом, торцы видны
        stick6(parts, 'frame_rail_%d' % int(a * 100), '+y', HY, a - 0.30,
               a + 0.30, Z0 + 0.74, Z0 + 0.84, seed=290 + int(a * 100))
    # раскосы 45° в верхних угловых панелях фасада: доведены до стойки и обвязки
    for sgn in (1, -1):
        v, f = F.bar((sgn * 0.30, HY + FRAME_OUT - FRAME_T / 2.0, Z1 - 0.02),
                     (sgn * 0.70, HY + FRAME_OUT - FRAME_T / 2.0, Z1 - 0.42),
                     0.05, FRAME_T)
        F.part(parts, 'frame_brace_y%d' % sgn, 'timber', v, f, jit=0.003,
               seed=280 + sgn)


# --------------------------------------------------------------------------
# ЯРУС 3: ПРОЁМЫ
# --------------------------------------------------------------------------
def build_door(parts):
    """Дверь 0.36 x 0.80: КОСЯК, тёмное нутро, дощатое полотно, кольцо."""
    w, h = 0.36, 0.80
    zt = Z0 + h
    for sx_ in (1, -1):
        box(parts, 'door_jamb_%d' % sx_, 'beam', sx_ * (w / 2.0 + 0.03),
            HY + 0.02, Z0, 0.06, 0.12, h + 0.06, jit=0.003, seed=290 + sx_)
    box(parts, 'door_lintel', 'beam', 0.0, HY + 0.02, zt, w + 0.12, 0.12, 0.07,
        jit=0.003, seed=294)
    box(parts, 'door_hole', 'dark', 0.0, HY - 0.07, Z0, w + 0.02, 0.02, h)
    for k in range(3):
        # nocull: доски полотна стоят с зазором 5 мм, и отсечённая боковина
        # соседа светила изнанкой в этот зазор (замер xray: 56 px)
        box(parts, 'door_leaf_%d' % k, 'plank', -w / 2.0 + 0.06 + 0.12 * k,
            HY + 0.01, Z0 + 0.01, 0.115, 0.035, h - 0.03,
            jit=0.003, seed=300 + k, nocull=True)
    v, f = F.prism(F.ngon(0.0, 0.0, 0.045, 8), 0.0, 0.02, axis=2)
    v = [(x + 0.10, y + HY + 0.04, z + Z0 + 0.42) for x, y, z in v]
    F.part(parts, 'door_ring', 'iron', v, f)
    box(parts, 'door_step', 'stone', 0.0, HY + 0.03, 0.0, w + 0.30, 0.12, 0.07,
        jit=0.004, seed=310)


def build_window(parts, tag, wall, plane, a_center, z_center, size=0.28,
                 fw=0.05, out=0.05, depth=0.07):
    """Окно как КОЛЬЦО: стойки на всю высоту, планки между ними, стекло внутри."""
    half = size / 2.0
    O = half + fw
    o, s1, s2 = F.wall_faces(wall)
    sgn = 1.0 if wall in ('+y', '+x') else -1.0
    d_frame = out - depth / 2.0
    t = depth

    def place(name, a, z0, sa, sz, keep=None, d=None, fam='beam', jit=0.0, seed=0):
        dd = d_frame if d is None else d
        if wall in ('+y', '-y'):
            v, f = F.box(a, sgn * (plane + dd), z0, sa, t, sz, keep=keep)
        else:
            v, f = F.box(sgn * (plane + dd), a, z0, t, sa, sz, keep=keep)
        F.part(parts, name, fam, v, f, jit=jit, seed=seed)

    for sg in (1, -1):
        place('%s_fr_%d' % (tag, sg), a_center + sg * (half + fw / 2.0),
              z_center - O, fw, 2 * O, keep=None, seed=320 + sg)
    place(tag + '_fr_t', a_center, z_center + half, size + 0.01, fw - 0.004,
          keep=None, d=d_frame - 0.006)
    place(tag + '_fr_b', a_center, z_center - half - fw + 0.004, size + 0.01,
          fw - 0.004, keep=None, d=d_frame - 0.006)
    d_glass, d_mul = out - 0.032, out - 0.014
    if wall in ('+y', '-y'):
        v, f = F.box(a_center, sgn * (plane + d_glass), z_center - half,
                     size, 0.012, size, keep=(o,))
        F.part(parts, tag + '_glass', 'iron', v, f)
        v, f = F.box(a_center, sgn * (plane + d_mul), z_center - half,
                     0.026, 0.02, size, keep=(o, s1, s2))
        F.part(parts, tag + '_mul_v', 'beam', v, f)
        v, f = F.box(a_center, sgn * (plane + d_mul + 0.008), z_center - 0.013,
                     size - 0.008, 0.02, 0.026, keep=(o, '+z'))
        F.part(parts, tag + '_mul_h', 'beam', v, f)
    else:
        v, f = F.box(sgn * (plane + d_glass), a_center, z_center - half,
                     0.012, size, size, keep=(o,))
        F.part(parts, tag + '_glass', 'iron', v, f)
        v, f = F.box(sgn * (plane + d_mul), a_center, z_center - half,
                     0.02, 0.026, size, keep=(o, s1, s2))
        F.part(parts, tag + '_mul_v', 'beam', v, f)
        v, f = F.box(sgn * (plane + d_mul + 0.008), a_center, z_center - 0.013,
                     0.02, size - 0.008, 0.026, keep=(o, '+z'))
        F.part(parts, tag + '_mul_h', 'beam', v, f)
    # подоконник каменный
    w2 = 2 * O + 0.11
    if wall in ('+y', '-y'):
        v, f = F.box(a_center, sgn * (plane + 0.02), z_center - O - 0.045,
                     w2, 0.11, 0.05, keep=(o, '+z', '-z', s1, s2))
    else:
        v, f = F.box(sgn * (plane + 0.02), a_center, z_center - O - 0.045,
                     0.11, w2, 0.05, keep=(o, '+z', '-z', s1, s2))
    F.part(parts, tag + '_sill', 'stone', v, f, jit=0.003, seed=330)


def build_openings(parts):
    build_door(parts)
    zc = Z0 + 0.42 * WALL_H
    build_window(parts, 'win_xm1', '-x', HX, 1.00, zc)
    build_window(parts, 'win_x1', '+x', HX, 0.00, zc)
    build_window(parts, 'win_ym1', '-y', HY, 0.00, zc)


# --------------------------------------------------------------------------
# ЯРУС 4: КРОВЛЯ
# --------------------------------------------------------------------------
def z_front(x):
    """Плоскость переднего ската (+X) — она же продолжается за конёк."""
    return Z_RIDGE_S - (x - RIDGE_X) * TAN_F


def z_back(x):
    """Плоскость заднего ската (-X)."""
    return Z_RIDGE_S - (RIDGE_X - x) * TAN_B


def build_roof(parts):
    """Скаты плоскими плитами, торцевые заделки, конёк, слеги, заплаты.

    Передний скат НЕДОМОЩЕН: у карниза не хватает куска (от CUT_X до кромки),
    поэтому в проёме видны стропила и обрешётка. Кроют снизу вверх — недоложен
    именно низ ската.

    Скаты ЗАХОДЯТ друг за друга через конёк (передний до x = RIDGE_X + 0.04,
    задний до RIDGE_X - 0.06): стык «торец в торец» положил бы две торцевые
    грани в одну плоскость — это z-fighting (C8).
    """
    def slope_piece(name, poly, y0, y1, seed, fam='thatch'):
        v, f = F.prism(poly, y0, y1, axis=1)
        F.part(parts, name, fam, v, f, jit=0.0025, seed=seed)

    def prof(x0, x1, zfn):
        return [(x0, zfn(x0)), (x1, zfn(x1)),
                (x1, zfn(x1) + ROOF_T), (x0, zfn(x0) + ROOF_T)]

    # ВИДИМЫЙ скат (-X) недомощен у карниза: верх во всю длину, низ — до CUT_Y
    slope_piece('roof_back_up', prof(-CUT_X, RIDGE_X - 0.06, z_back),
                -ROOF_HALF_Y, ROOF_HALF_Y, 403)
    slope_piece('roof_back_low', prof(-Z_EAVE_X, -CUT_X, z_back),
                -ROOF_HALF_Y, CUT_Y, 402)
    # дальний скат (+X): целый
    slope_piece('roof_front', prof(RIDGE_X + 0.04, Z_EAVE_X, z_front),
                -ROOF_HALF_Y, ROOF_HALF_Y, 401)
    # конёк: три сегмента разной высоты (провисший гребень), с перехлёстом
    for k, (y0, y1, dz) in enumerate(((-ROOF_HALF_Y, -0.50, 0.0),
                                      (-0.58, 0.58, -0.035),
                                      (0.50, ROOF_HALF_Y, 0.01))):
        poly = [(-0.22, Z_RIDGE_S + ROOF_T - 0.07 + dz),
                (0.0, Z_RIDGE_S + ROOF_T + 0.10 + dz),
                (0.22, Z_RIDGE_S + ROOF_T - 0.07 + dz)]
        # nocull: низ гребня утоплен в скаты, и отсечённая грань открывала
        # нутро в виде снизу (замер xray: 86 px)
        v, f = F.prism(poly, y0, y1, axis=1)
        F.part(parts, 'ridge_cap_%d' % k, 'thatch2', v, f, jit=0.004,
               seed=410 + k, nocull=True)
    # прижимная жердь по гребню: у ратуши тёмное бревно поверх соломы
    # Жердь утоплена в гребень: отсев гасит её низ (он внутри гребня), и в
    # ЧЕТЫРЁХ КАНОННЫХ ВИДАХ изнанок нет (замер 1..2 px).  В виде снизу
    # (подъём -25°, в игре такого ракурса нет) её нутро видно — 318 px; это
    # записано в отчёте, а не спрятано.
    bar(parts, 'ridge_pole', 'timber',
        (RIDGE_X, -ROOF_HALF_Y + 0.03, 2.79),
        (RIDGE_X, ROOF_HALF_Y - 0.03, 2.79), 0.07, 0.07, seed=470)
    # прижимные слеги на скатах
    for k, x in enumerate((0.34, 0.78)):
        for sgn in (1, -1):
            xx = sgn * x
            bar(parts, 'roof_pole_%d%d' % (sgn, k), 'timber',
                (xx, -ROOF_HALF_Y + 0.02, z_soffit(xx) + ROOF_T - 0.02),
                (xx, ROOF_HALF_Y - 0.02, z_soffit(xx) + ROOF_T - 0.02),
                0.05, 0.05, seed=420 + k)
    # заплаты из старой соломы (плоскость в плоскость не кладём: утоплены)
    for k, (x0, x1, y0, y1, dz) in enumerate(((-0.52, -0.10, -1.10, -0.62, 0.02),
                                              (0.18, 0.60, 0.30, 0.86, 0.02),
                                              (-0.80, -0.44, 0.55, 1.00, 0.02))):
        poly = [(x0, z_soffit(x0) + ROOF_T - dz), (x1, z_soffit(x1) + ROOF_T - dz),
                (x1, z_soffit(x1) + ROOF_T + 0.02), (x0, z_soffit(x0) + ROOF_T + 0.02)]
        v, f = F.prism(poly, y0, y1, axis=1)
        F.part(parts, 'roof_patch_%d' % k, 'thatch2', v, f, jit=0.004,
               seed=430 + k)
    # лобовые доски по кромкам торцов (по обоим скатам).  Начинаются на 0.06
    # НИЖЕ кромки: кромка кровли задаёт габарит пятна, и доска не имеет права
    # его расширять (канон: габарит в пятне с запасом 0.03).
    for sgn in (1, -1):
        for x in (1, -1):
            sgnx = 1.0 if x > 0 else -1.0
            bar(parts, 'roof_barge_%d%d' % (sgn, x), 'plank',
                (sgnx * (Z_EAVE_X - 0.07), sgn * (ROOF_HALF_Y - 0.02),
                 z_soffit(Z_EAVE_X - 0.07) + ROOF_T * 0.5),
                (RIDGE_X, sgn * (ROOF_HALF_Y - 0.02), Z_RIDGE_S + ROOF_T * 0.5),
                0.04, 0.10, seed=440 + sgn * x)
    # стропила и обрешётка: их видно в недомощенном куске и снизу, из-под свеса
    for k in range(7):
        y = -HY + 0.07 + k * (WALL_Y - 0.14) / 6.0
        x0 = -(Z_EAVE_X - 0.06)
        bar(parts, 'rafter_%d' % k, 'beam',
            (x0, y, z_soffit(x0) - 0.09),
            (RIDGE_X, y, Z_RIDGE_S - 0.09), 0.06, 0.06, seed=450 + k)
    for k, x in enumerate((-0.24, -0.55, -0.86)):
        bar(parts, 'purlin_%d' % k, 'beam',
            (x, -HY + 0.04, z_soffit(x) - 0.06),
            (x, HY - 0.04, z_soffit(x) - 0.06), 0.05, 0.05, seed=460 + k)


# --------------------------------------------------------------------------
# ЯРУС 5: ДВОР СТРОЙКИ
# --------------------------------------------------------------------------
def build_yard(parts):
    """Штабель брёвен и вязанка соломы.  Стены не касаются: это не цоколь.

    Штабель лежит у глухой стены (-X) и доходит до x = -0.97, вязанка — на
    земле у фасада.  Обе вещи входят в основание (стоят на земле), поэтому
    пятно считается и по ним.
    """
    rng = random.Random(51)
    for row in range(2):
        for k in range(3):
            if row and k == 2:
                continue                        # верхний ряд короче: 5 брёвен
            cy = -1.10 + 0.30 * k + (0.15 if row else 0.0)
            cz = 0.058 + 0.104 * row
            v, f = F.prism(F.ngon(cy, cz, 0.055, 6, phase=0.36 * k + 0.2 * row),
                           -0.99, -0.65, axis=0)
            F.part(parts, 'yard_log_%d_%d' % (row, k), 'beam', v, f,
                   jit=0.004, seed=500 + row * 3 + k)
    # вязанка соломы на земле у торца, рядом с лункой цоколя
    for k, (dy, dz, sx) in enumerate(((0.0, 0.0, 0.30), (0.11, 0.02, 0.26),
                                      (-0.10, 0.03, 0.24))):
        box(parts, 'yard_straw_%d' % k, 'thatch', 0.68 + dz * 0.4, -1.20 + dy,
            0.0, sx, 0.22, 0.17 + dz, rz=math.radians(rng.uniform(-6, 6)),
            jit=0.005, seed=530 + k)
    # утоптанная земля перед входом (внутри пятна)
    box(parts, 'yard_dirt', 'dirt', 0.0, 1.30, 0.008, 0.90, 0.26, 0.015,
        jit=0.003, seed=540)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def compact(parts):
    """Убрать вершины, на которые не ссылается ни один фасет, и пустые детали.

    Нужно ПОСЛЕ автоотсева: он выбрасывает фасеты, а вершины оставляет. Деталь,
    у которой выброшены все фасеты, — это геометрия, которой нет: в движке она
    мусор в буфере, а на приёмке — «висячие вершины» (C9) и «деталь живёт
    отдельным телом» (C12).  У сданного дома жителя таких вершин было 108.
    """
    out = []
    for p in parts:
        used = sorted({i for f in p['faces'] for i in f})
        if len(used) < 3:
            continue
        remap = {old: k for k, old in enumerate(used)}
        p['verts'] = [p['verts'][i] for i in used]
        p['faces'] = [tuple(remap[i] for i in f) for f in p['faces']]
        out.append(p)
    return out


def build(variant=None):
    parts = []
    build_plinth(parts)
    build_walls(parts)
    build_gables(parts)
    build_frame(parts)
    build_openings(parts)
    build_roof(parts)
    build_yard(parts)
    F.ground(parts)
    # cover 0.02, а не 0.03: при 0.03 отсев выбрасывал грани, которые в стыке
    # открывались изнанкой (замер по четырём канонным видам: 0/9/0/22 px стало
    # 0/2/0/0).  Цена — 40 трис, они в бюджете класса.
    F.autocull(parts, cover=0.02)
    return compact(parts)


SPEC = dict(
    footprint=(2, 3),
    wall_x=WALL_Y,                 # сторона вдоль конька (ось Y модели)
    wall_y=WALL_X,                 # сторона поперёк скатов (ось X модели)
    wall_h=WALL_H,
    z_plinth=PLINTH_H,
    z_wall=Z1,
    pitch_deg=round(PITCH_F, 1),   # передний скат; задний круче (PITCH_B)
    pitch_deg_back=round(PITCH_B, 1),
    over_slope=round(OVER_SLOPE, 3),
    over_end=round(OVER_END, 3),
    ridge_z=round(Z_RIDGE_S + ROOF_T, 3),
    class_='building',
    canon=dict(h_b=(2.55, 3.05), roof_wall=(0.60, 0.95)),
)

if __name__ == '__main__':
    p = build()
    print(F.stats(p))
    for k, v in F.census(p).most_common(12):
        print('  %-20s %4d трис' % (k, v))
