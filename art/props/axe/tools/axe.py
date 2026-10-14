"""Топор жителя — геометрия в конвенциях пайплайна (townhall/tools/thpipe.py).

Стиль снят с атласа `mapgen2/assets/sprites/atlas.png` (деревья, камни):
  * деталь — это 4-20 КРУПНЫХ плоских фасетов, а не гладкая поверхность;
  * тона на фасетах идут ступенькой в три тона (свет / средний / тень), причём
    ступенька не совпадает с чистой физикой — у эталонных стволов два тона,
    у валунов три-четыре;
  * тёмный контур ~2.5 px на 96 ppu и мягкое пятно контактной тени — общие
    для всего атласа, поэтому берутся из пост-обработки (compose), а не тут.

Ориентация модели (каноническая, как у хижины: z = 0 — земля):
  * рукоять — вдоль +Z, комель стоит на земле;
  * лезвие — в +Y, обух — в -Y;
  * камера пайплайна видит лезвие плоской щекой влево, обух вправо.
Так топор удобно поворачивать в руку жителя любым поворотом вокруг Z.

Палитра снята пикселями атласа:
  дерево стволов  #553321 свет · #452D1C сред · #32200F тень
  валуны          #787F85 свет · #6C7377 сред · #44484A тень
Базовые цвета материалов ТЕМНЕЕ цели: солнце и небо сцены поднимают тон.
Точные значения подбирает tools/calib_render.py + tools/calib_solve.py
(файл palette_cal.json); формула LIFT — запасной вариант, если калибровки нет.
"""
import json
import math
import os

import bmesh
import bpy
from mathutils import Vector

import color as C
import thpipe as P

HERE = os.path.dirname(os.path.abspath(__file__))
CAL_JSON = os.path.join(HERE, 'palette_cal.json')

# Запасная оценка подъёма тона (калибровка даёт точные числа).
# Замер по пробам: фасет, повёрнутый к камере, отдаёт ~0.53 линейного
# значения альбедо, отсюда 1/0.53.
LIFT = 1.90

# Цели — цвета эталона (что должно получиться в спрайте), не материалы.
# Таблица лежит в palette.py: её читает и пост-обработка, где нет Blender.
from palette import FAMILY, TARGET, TARGET_STONE, target_of   # noqa: E402

# Свет и камера пайплайна — для раскладки фасетов по тонам.
SUN_FROM = Vector(P.SUN_DIR).normalized()          # откуда светит солнце
VIEW_FROM = Vector((-math.cos(P.EL) * math.cos(P.AZ),
                    math.cos(P.EL) * math.sin(P.AZ),
                    math.sin(P.EL))).normalized()  # направление на камеру
AMBIENT_W = 0.15                                   # доля неба в тоне фасета
# Пороги тонов: (светлый, средний). Разные у дерева и головы, потому что у
# рукояти самая светлая видимая грань ловит 0.59 солнца, а у головы верх
# смотрит прямо в небо и ловит 1.03: общий порог отправил бы верх и щёку
# в один тон, и верх выгорал бы добела.
TONE_THRESHOLD = dict(wood=(0.50, 0.30), iron=(0.75, 0.28),
                      stone=(0.75, 0.28), leather=(0.50, 0.30))

PAL = {}


def _role(key):
    """'wood_mid' -> ('wood', 1). Порядок тонов: 0 свет, 1 средний, 2 тень."""
    for fam, keys in FAMILY.items():
        if key in keys:
            return fam, keys.index(key)
    return key, 0


def _base(key):
    """Базовый цвет (ЛИНЕЙНЫЙ hex): из калибровки, иначе по формуле LIFT."""
    fam, tone = _role(key)
    try:
        return int(str(_calibration()[fam][str(tone)]).lstrip('#'), 16)
    except Exception:
        return C.scaled(target_of(key), LIFT)


_CAL = None


def _calibration():
    global _CAL
    if _CAL is None:
        try:
            with open(CAL_JSON) as f:
                _CAL = json.load(f)
        except Exception:
            _CAL = {}
    return _CAL


def palette():
    if PAL:
        return PAL
    for key in list(TARGET) + list(TARGET_STONE):
        rough, spec = (0.9, 0.04) if key.startswith('stone') else (0.82, 0.06)
        PAL[key] = P.make_material(key, _base(key), rough=rough, spec=spec)
    return PAL


def reset_palette():
    PAL.clear()


def M(key):
    return palette()[key]


# --------------------------------------------------------------------------
# ПРИМИТИВЫ
# --------------------------------------------------------------------------
def loft(bm, rings, closed=True, cap_a=True, cap_b=True):
    """Тело по кольцам: rings[i] — точки одного сечения (равной длины).

    Рёбра между соседними кольцами — четырёхугольники, торцы — n-угольники.
    Так собираются и рукоять (кольца в плоскости XY), и лезвие (кольца в XZ):
    все грани выходят плоскими, как фасеты эталона.
    """
    layers = []
    for ring in rings:
        layers.append([bm.verts.new(p) for p in ring])
    bm.verts.ensure_lookup_table()

    n = len(layers[0])
    for a, b in zip(layers, layers[1:]):
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            quad = []
            for v in (a[i], a[j], b[j], b[i]):
                if v not in quad:
                    quad.append(v)
            if len(quad) >= 3:
                try:
                    bm.faces.new(quad)
                except ValueError:
                    pass
    for layer, on in ((layers[0], cap_a), (layers[-1], cap_b)):
        if on and len(set(layer)) >= 3:
            try:
                bm.faces.new(layer)
            except ValueError:
                pass
    return bm


def ring4(y, t, z_lo, z_hi):
    """Сечение головы в плоскости XZ: прямоугольник (толщина 2t, высота)."""
    return [(t, y, z_lo), (t, y, z_hi), (-t, y, z_hi), (-t, y, z_lo)]


def blade(bm, stations):
    """Голова лофтом по станциям вдоль +Y.

    Станция — (y, полутолщина, z_lo, z_hi). Боковые грани — плоские
    четырёхугольники, а падение толщины к кромке даёт фаску: она ложится
    отдельным фасетом и ловит свой тон, как грань у эталонных валунов.
    """
    loft(bm, [ring4(*st) for st in stations])
    return bm


def hexring(z, rx, ry, yoff=0.0, xoff=0.0, rot=math.radians(30.0), n=6):
    """Кольцо сечения рукояти: n-угольник, повёрнутый фасетом к камере."""
    pts = []
    for k in range(n):
        a = rot + 2.0 * math.pi * k / n
        pts.append((xoff + rx * math.cos(a), yoff + ry * math.sin(a), z))
    return pts


# --------------------------------------------------------------------------
# ГОЛОВА
# --------------------------------------------------------------------------
# Станции: (y, полутолщина, z_lo, z_hi). y = 0 — ось рукояти.
# Обух сзади, проушина на оси, кромка впереди; к кромке сечение растёт по
# высоте (0.058 -> 0.096) и падает по толщине (0.046 -> 0.004) — отсюда и
# «шея», и клин, без которых топор читается молотком.
# Толщина в проушинной части (0.025-0.029) больше рукояти (0.024): иначе
# черенок проглядывает сквозь щёку там, где голова начинает сужаться к
# лезвию. Спуск к кромке идёт уже после плеча, y = 0.086.
HEAD_STATIONS = [
    (-0.075, 0.0270, 0.342, 0.400),   # обух, задняя площадка
    (-0.030, 0.0320, 0.330, 0.412),   # проушина, на оси рукояти
    (0.020, 0.0330, 0.324, 0.418),
    (0.070, 0.0310, 0.310, 0.436),   # плечо
    (0.115, 0.0200, 0.294, 0.450),   # начало фаски
    (0.146, 0.0025, 0.286, 0.456),   # режущая кромка
]

# Каменный топор: толще, грубее, кромка шире — как расколотый валун.
STONE_STATIONS = [
    (-0.070, 0.0300, 0.348, 0.398),
    (-0.026, 0.0360, 0.334, 0.410),
    (0.024, 0.0370, 0.328, 0.416),
    (0.072, 0.0350, 0.314, 0.430),
    (0.110, 0.0280, 0.300, 0.444),
    (0.140, 0.0130, 0.290, 0.452),
]


# --------------------------------------------------------------------------
# РУКОЯТЬ
# --------------------------------------------------------------------------
# (z, rx, ry, сдвиг по Y) — комель, грип, середина, плечо в проушине, верх.
HANDLE = [
    (0.000, 0.0240, 0.0280, 0.0000),
    (0.014, 0.0280, 0.0320, 0.0000),   # раструб комля
    (0.048, 0.0232, 0.0272, 0.0012),
    (0.120, 0.0212, 0.0252, 0.0026),
    (0.200, 0.0216, 0.0256, 0.0038),
    (0.280, 0.0242, 0.0284, 0.0050),
    (0.345, 0.0286, 0.0330, 0.0060),   # плечо в проушине
    (0.405, 0.0278, 0.0322, 0.0066),
    (0.448, 0.0215, 0.0262, 0.0070),   # верх над проушиной
]

HANDLE_LONG = [
    (0.000, 0.0244, 0.0284, 0.0000),
    (0.016, 0.0284, 0.0324, 0.0000),
    (0.056, 0.0234, 0.0274, 0.0014),
    (0.150, 0.0212, 0.0252, 0.0032),
    (0.260, 0.0216, 0.0256, 0.0048),
    (0.360, 0.0242, 0.0284, 0.0062),
    (0.435, 0.0286, 0.0330, 0.0074),
    (0.500, 0.0278, 0.0322, 0.0082),
    (0.545, 0.0215, 0.0262, 0.0086),
]


def handle(bm, rings=HANDLE, n=6):
    loft(bm, [hexring(z, rx, ry, yo, n=n) for z, rx, ry, yo in rings])
    return bm


# --------------------------------------------------------------------------
# ОПЛЁТКА И ОБВЯЗКА
# --------------------------------------------------------------------------
def band(bm, z0, z1, rx, ry, yoff=0.0, rot=math.radians(30.0), n=6, taper=0.86):
    """Кольцо оплётки вокруг рукояти: короткая призма чуть шире рукояти."""
    a = hexring(z0, rx, ry, yoff, rot=rot, n=n)
    b = hexring(z0 + (z1 - z0) * 0.5, rx * 1.06, ry * 1.06, yoff, rot=rot, n=n)
    c = hexring(z1, rx * taper, ry * taper, yoff, rot=rot, n=n)
    return loft(bm, [a, b, c])


def wrap(bm, rings, count=3, z0=0.092, step=0.033, height=0.018):
    """Ремень на грип: витки с промежутками. Тёмная деталь поверх светлой,
    силуэт не меняет — как тёмные обвязки у эталонных стволов."""
    for i in range(count):
        a = z0 + i * step
        rx, ry, yo = _lerp_ring(rings, a)
        band(bm, a, a + height, rx * 1.14, ry * 1.14, yoff=yo)
    return bm


def _station_at(stations, y):
    """Интерполяция сечения головы по y -> (полутолщина, z_lo, z_hi)."""
    prev = stations[0]
    for cur in stations:
        if y <= cur[0]:
            if cur[0] == prev[0]:
                return cur[1], cur[2], cur[3]
            k = (y - prev[0]) / (cur[0] - prev[0])
            return (prev[1] + (cur[1] - prev[1]) * k,
                    prev[2] + (cur[2] - prev[2]) * k,
                    prev[3] + (cur[3] - prev[3]) * k)
        prev = cur
    return stations[-1][1], stations[-1][2], stations[-1][3]


def lashing(bm, stations, count=2, ys=(-0.020, 0.028), over=0.007, pad=0.006,
            half_y=0.011):
    """Обвязка каменной головы: два ремня вокруг проушины, поверх головы.

    Ремень — короб чуть больше сечения головы в этом месте: он выходит со
    всех четырёх сторон и читается полосой, перехватывающей голову.
    """
    for i in range(count):
        y = ys[i % len(ys)]
        t, z_lo, z_hi = _station_at(stations, y)
        pts = [(y - half_y, z_lo - pad), (y + half_y, z_lo - pad),
               (y + half_y, z_hi + pad), (y - half_y, z_hi + pad)]
        try:
            va = [bm.verts.new((-(t + over), a, b)) for a, b in pts]
            vb = [bm.verts.new((t + over, a, b)) for a, b in pts]
            bm.verts.ensure_lookup_table()
            for k in range(4):
                j = (k + 1) % 4
                bm.faces.new([va[k], va[j], vb[j], vb[k]])
            bm.faces.new(va)
            bm.faces.new(list(reversed(vb)))
        except ValueError:
            pass
    return bm


def _lerp_ring(rings, z):
    """Линейная интерполяция (rx, ry, yoff) рукояти на высоте z."""
    prev = rings[0]
    for cur in rings:
        if z <= cur[0]:
            if cur[0] == prev[0]:
                return cur[1], cur[2], cur[3]
            t = (z - prev[0]) / (cur[0] - prev[0])
            return (prev[1] + (cur[1] - prev[1]) * t,
                    prev[2] + (cur[2] - prev[2]) * t,
                    prev[3] + (cur[3] - prev[3]) * t)
        prev = cur
    return rings[-1][1], rings[-1][2], rings[-1][3]


# --------------------------------------------------------------------------
# ТОНА ФАСЕТОВ
# --------------------------------------------------------------------------
def face_brightness(n):
    """Ожидаемая яркость фасета: солнце + доля неба."""
    return max(0.0, n.dot(SUN_FROM)) + AMBIENT_W


def visible_weight(poly):
    """Вклад фасета в спрайт: площадь на экране."""
    return poly.area * max(0.0, poly.normal.dot(VIEW_FROM))


def split_tones(ob, family, keys_override=None):
    """Разложить фасеты по трём тонам: свет / средний / тень.

    Граница — по ожидаемой яркости фасета (сколько солнца он ловит), а не по
    числу фасетов: тон должен зависеть от того, куда смотрит грань, как у
    эталона. Пороги подобраны по видимым фасетам модели: у рукояти светлой
    выходит грань, повёрнутая к камере, у головы — верх и фаска, тёмной —
    узкая площадка кромки. Плоские фасеты дают ступеньку без градиентов.
    """
    keys = keys_override or FAMILY[family]
    names = [m.name for m in ob.data.materials]
    for k in keys:
        if M(k).name not in names:
            ob.data.materials.append(M(k))
            names.append(M(k).name)
    idx = [names.index(M(k).name) for k in keys]

    light, mid = TONE_THRESHOLD[family]
    for p in ob.data.polygons:
        b = face_brightness(p.normal)
        tone = 0 if b >= light else (1 if b >= mid else 2)
        p.material_index = idx[tone]
    return ob


def tone_census(objs):
    """Сколько фасетов и площади пришлось на каждый тон — для отчёта."""
    out = {}
    for ob in objs:
        mats = [m.name for m in ob.data.materials]
        for p in ob.data.polygons:
            name = mats[p.material_index]
            d = out.setdefault(name, [0, 0.0])
            d[0] += 1
            d[1] += p.area
    return out


def bucket_normals(ob, family, keys_override=None):
    """Представительная нормаль каждого тона: самый крупный ВИДИМЫЙ фасет.

    Нужна калибровке: по ней рисуется проба, и по ней же видно, какой тон
    какую нормаль получает в спрайте. Невидимые фасеты (смотрящие от камеры)
    пропускаются — проба по такой нормали вышла бы чёрной.
    """
    keys = keys_override or FAMILY[family]
    names = [m.name for m in ob.data.materials]
    idx = [names.index(M(k).name) for k in keys]
    best = {}
    for p in ob.data.polygons:
        if p.material_index not in idx:
            continue
        w = visible_weight(p)
        if w <= 1e-9:
            continue
        tone = idx.index(p.material_index)
        if tone not in best or w > best[tone][1]:
            best[tone] = (p.normal.copy(), w)
    return best


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
VARIANTS = ('a', 'b', 'c')

HEAD_FAMILY = {'a': 'iron', 'b': 'stone', 'c': 'iron'}

# Голова ставится на верхний конец рукояти: у длинного варианта она выше
# ровно на разницу длины рукоятей, иначе черенок торчит над головой.
HEAD_LIFT = dict(a=0.0, b=0.0, c=HANDLE_LONG[-1][0] - HANDLE[-1][0])


def build(variant='a', jitter=0.0009, seed=7):
    """Собрать топор. Возвращает список объектов сцены."""
    palette()
    objs = []

    lift = HEAD_LIFT[variant]
    base = STONE_STATIONS if variant == 'b' else HEAD_STATIONS
    stations = [(y, t, z0 + lift, z1 + lift) for y, t, z0, z1 in base]
    rings = HANDLE_LONG if variant == 'c' else HANDLE

    # --- рукоять ---
    bm = bmesh.new()
    handle(bm, rings)
    # Кольца-выемки на грипе: у a три витка, у b и c — два (как у c).
    if variant in ('a', 'b', 'c'):
        wrap(bm, rings, count=3 if variant == 'a' else 2)
    if jitter:
        _jitter(bm, jitter, seed)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = P.new_obj_from_bm(bm, 'handle', M('wood_mid'))
    split_tones(ob, 'wood')
    objs.append(ob)

    # --- голова ---
    bm = bmesh.new()
    blade(bm, stations)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    fam = HEAD_FAMILY[variant]
    ob = P.new_obj_from_bm(bm, 'head', M(FAMILY[fam][1]))
    split_tones(ob, fam)
    objs.append(ob)

    # --- обвязка каменной головы ---
    if variant == 'b':
        bm = bmesh.new()
        lashing(bm, stations, count=2)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        ob = P.new_obj_from_bm(bm, 'lashing', M('leather'))
        split_tones(ob, 'leather')
        objs.append(ob)

    return objs


def _jitter(bm, amount, seed):
    """Неровность: деталь срублена, а не выточена. Двигаем вершины вдоль луча
    от оси — фасет остаётся плоским, ломается только силуэт."""
    import random
    rnd = random.Random(seed)
    for v in bm.verts:
        if math.hypot(v.co.x, v.co.y) < 1e-6:
            continue
        k = 1.0 + rnd.uniform(-amount, amount) * 12.0
        v.co.x *= k
        v.co.y *= k
    return bm


def tris_verts(objs):
    tris = verts = 0
    for o in objs:
        verts += len(o.data.vertices)
        for p in o.data.polygons:
            tris += len(p.vertices) - 2
    return tris, verts
