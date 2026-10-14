"""Лопата жителя — геометрия в конвенциях пайплайна (townhall/tools/thpipe.py).

Стиль снят с атласа `mapgen2/assets/sprites/atlas.png` (деревья, валуны) и с
соседа по классу — топора (`axe/tools/axe.py`): у инструмента те же 4-20
КРУПНЫХ плоских фасетов, три тона ступенькой (свет / средний / тень), тёмная
обводка ~2 px на 96 ppu и мягкое пятно контактной тени. Обводку и тень рисует
пост-обработка (compose_shovel.py), а не меш.

Ориентация модели (канон: z = 0 — земля, опора в (0,0,0)):
  * рукоять — вдоль +Z, торец вверху;
  * ШТЫК (полотно) стоит на земле кромкой, его плоскость — YZ, толщина по X;
    широкая щека смотрит в -X, то есть в камеру при повороте 0°;
  * ширина штыка идёт по +Y/-Y: +Y уходит влево-вверх кадра, -Y — вправо-вниз.
Так лопату удобно вкладывать в руку жителя любым поворотом вокруг Z, а силуэт
читается при всех четырёх поворотах (в отличие от плоскости «в камеру», которая
на 90° повороте превратилась бы в палку).

Анатомия (снизу вверх): кромка -> полотно штыка -> наступ (широкий уступ
поверх полотна) -> тулейка (конус, куда входит рукоять) -> рукоять с обмоткой.

Палитра снята пикселями атласа (tools/palette.py); базовые цвета материалов
ТЕМНЕЕ цели — солнце и небо сцены поднимают тон, поэтому их считает калибровка
(tools/calib_render.py + tools/calib_solve.py -> tools/palette_cal.json).
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

# Запасная оценка подъёма тона, если калибровки ещё нет (замер по пробам
# топора: фасет, повёрнутый к камере, отдаёт ~0.53 линейного альбедо).
LIFT = 1.90

# Цели — цвета эталона (что должно получиться в спрайте), не материалы.
from palette import FAMILY, TARGET, TARGET_STONE, target_of   # noqa: E402

# Свет и камера пайплайна — для раскладки фасетов по тонам.
SUN_FROM = Vector(P.SUN_DIR).normalized()          # направление НА солнце
VIEW_FROM = Vector((-math.cos(P.EL) * math.cos(P.AZ),
                    math.cos(P.EL) * math.sin(P.AZ),
                    math.sin(P.EL))).normalized()  # направление на камеру
AMBIENT_W = 0.15                                   # доля неба в тоне фасета
# Пороги тонов: (светлый, средний). Разные у дерева и головы: у рукояти самая
# светлая видимая грань ловит 0.59 солнца, а верх наступа смотрит прямо в небо
# и ловит 1.05 — общий порог отправил бы верх и щёку в один тон.
TONE_THRESHOLD = dict(wood=(0.50, 0.30), iron=(0.75, 0.28),
                      stone=(0.75, 0.28), leather=(0.50, 0.30))

# Все материалы лопаты носят свой префикс: сцена живёт в ОДНОЙ сессии Blender
# вместе с чужими объектами, и путать палитры нельзя.
MAT_PREFIX = 'shovel_'

PAL = {}


def _role(key):
    """'wood_mid' -> ('wood', 1). Порядок тонов: 0 свет, 1 средний, 2 тень."""
    for fam, keys in FAMILY.items():
        if key in keys:
            return fam, keys.index(key)
    return key, 0


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


def _base(key):
    """Базовый цвет (ЛИНЕЙНЫЙ hex): из калибровки, иначе по формуле LIFT."""
    fam, tone = _role(key)
    try:
        return int(str(_calibration()[fam][str(tone)]).lstrip('#'), 16)
    except Exception:
        return C.scaled(target_of(key), LIFT)


def palette():
    """Материалы палитры. Кэш ПРОВЕРЯЕТСЯ на живость.

    Грабли: в headless-сборке `thpipe.clear_scene()` (read_factory_settings)
    сносит материалы из файла, а кэш модуля остаётся — и следующий кадр падает
    на `ReferenceError: StructRNA of type Material has been removed`. У топора
    это лечится явным `reset_palette()` после каждого `clear_scene()`; здесь
    кэш сам себя пересобирает, потому что тем же кодом пользуется живая сессия
    Blender, где сцену чистить нельзя.
    """
    global PAL
    if PAL:
        try:
            if not all(m.name in bpy.data.materials for m in PAL.values()):
                PAL = {}
        except ReferenceError:
            PAL = {}
    if not PAL:
        for key in list(TARGET) + list(TARGET_STONE):
            rough, spec = (0.9, 0.04) if key.startswith('stone') else (0.82, 0.06)
            PAL[key] = P.make_material(MAT_PREFIX + key, _base(key),
                                       rough=rough, spec=spec)
    return PAL


def reset_palette():
    PAL.clear()


def M(key):
    return palette()[key]


def reload_calibration():
    """Перечитать palette_cal.json (после шага калибровки, без перезапуска)."""
    global _CAL
    _CAL = None
    reset_palette()


# --------------------------------------------------------------------------
# ПРИМИТИВЫ
# --------------------------------------------------------------------------
def loft(bm, rings, closed=True, cap_a=True, cap_b=True):
    """Тело по кольцам: rings[i] — точки одного сечения (равной длины).

    Рёбра между соседними кольцами — четырёхугольники, торцы — n-угольники.
    Так собираются и рукоять (кольца в плоскости XY), и штык (кольца в YZ):
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


def blade_ring(z, t, w):
    """Сечение штыка в плоскости YZ: толщина 2t по X, ширина 2w по Y."""
    return [(t, -w, z), (t, w, z), (-t, w, z), (-t, -w, z)]


def blade(bm, stations):
    """Полотно штыка лофтом по станциям вдоль Z.

    Станция — (z, полутолщина, полуширина). Кромка внизу: там полотно тоньше
    всего (0.002), поэтому торец выходит отдельным тёмным фасетом — та самая
    линия режущей кромки, как площадка лезвия у топора.
    """
    loft(bm, [blade_ring(*st) for st in stations])
    return bm


def hexring(z, rx, ry, yoff=0.0, xoff=0.0, rot=math.radians(30.0), n=6):
    """Кольцо сечения рукояти: n-угольник, повёрнутый фасетом к камере."""
    pts = []
    for k in range(n):
        a = rot + 2.0 * math.pi * k / n
        pts.append((xoff + rx * math.cos(a), yoff + ry * math.sin(a), z))
    return pts


def box(bm, x0, x1, y0, y1, z0, z1):
    """Короб по двум углам — наступ и прочие «срубленные» детали."""
    v = [bm.verts.new(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                   (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    bm.verts.ensure_lookup_table()
    for face in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                 (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        try:
            bm.faces.new([v[i] for i in face])
        except ValueError:
            pass
    return bm


# --------------------------------------------------------------------------
# РАЗМЕРЫ: штык, наступ, тулейка, рукоять
# --------------------------------------------------------------------------
# Станции штыка: (z, полутолщина, полуширина). Кромка 0.17 юнита шириной на
# земле, дальше полотно расширяется до 0.198 в плечах и снова сходится к
# наступу. Ширина задана по Y — в кадре это диагональ силуэта, а высота
# полотна чуть больше ширины: так штык читается лопатой, а не веслом.
#
# Толщина ДЕРЖИТСЯ постоянной (0.0090..0.0104) по всей высоте, а спуск к
# кромке собран в нижние 0.034 юнита: иначе в профиль полотно выходит длинным
# клином-иглой вместо пластины с заточкой (видно на renders/pview.png, вид
# `side`). Наклон заточки 0.26 даёт фасету нормаль, которая ловит 0.77 солнца,
# то есть СВЕТЛЫЙ тон — заточенная кромка читается светлой полосой, а не срезом.
BLADE = [
    (0.000, 0.0018, 0.086),   # режущая кромка: тонкая площадка на земле
    (0.034, 0.0090, 0.094),   # конец заточки: дальше толщина почти не растёт
    (0.070, 0.0094, 0.097),
    (0.120, 0.0098, 0.099),   # плечи полотна
    (0.176, 0.0102, 0.095),
    (0.230, 0.0104, 0.086),   # верх полотна, под наступом
]

# Наступ: широкий уступ поверх полотна, в него входит тулейка. Даёт светлый
# фасет сверху и тёмную тень под собой — ступень тона, как у валунов атласа.
COLLAR = dict(x=0.0145, y=0.0840, z0=0.230, z1=0.266)

# Тулейка: шестигранный конус вокруг рукояти, самое узкое место у наступа.
SOCKET = [
    (0.266, 0.0195),
    (0.298, 0.0300),          # раструб пояса
    (0.336, 0.0215),
]

# Рукоять: (z, rx, ry, сдвиг по Y) — от скрытого в штыке комля до торца.
# Сдвиг по Y — «срублено, а не выточено»: ствол лопаты чуть ведёт в сторону.
# Низ рукояти СТРОГАН под тулейку: он тоньше полотна (0.0085 < 0.0104) и
# наступа, иначе черенок проглядывает сквозь щёку — как у топора в проушине.
HANDLE = [
    (0.200, 0.0085, 0.0085, 0.0000),   # спрятан в полотне
    (0.268, 0.0098, 0.0098, 0.0000),   # спрятан в наступе и тулейке
    (0.336, 0.0205, 0.0205, 0.0000),   # выходит из тулейки
    (0.400, 0.0200, 0.0200, 0.0010),
    (0.478, 0.0196, 0.0196, 0.0020),
    (0.548, 0.0202, 0.0202, 0.0028),
    (0.592, 0.0216, 0.0216, 0.0032),   # утолщение к торцу
    (0.622, 0.0206, 0.0206, 0.0034),   # торец
]

# Длинная рукоять «шаговой» лопаты: тот же штык, рукоять выше на 0.09.
HANDLE_LONG = [
    (0.200, 0.0085, 0.0085, 0.0000),
    (0.268, 0.0098, 0.0098, 0.0000),
    (0.336, 0.0205, 0.0205, 0.0000),
    (0.428, 0.0200, 0.0200, 0.0012),
    (0.528, 0.0196, 0.0196, 0.0024),
    (0.614, 0.0202, 0.0202, 0.0032),
    (0.676, 0.0218, 0.0218, 0.0037),
    (0.712, 0.0208, 0.0208, 0.0039),
]

# Обмотка грипа: две тёмные полосы у торца (рука ложится на них). Силуэт они
# не меняют — как тёмные обвязки на стволах эталона.
GRIP = dict(zs=(0.498, 0.552), height=0.024, over=1.14)
GRIP_LONG = dict(zs=(0.584, 0.638), height=0.024, over=1.14)


def handle(bm, rings, n=6):
    loft(bm, [hexring(z, rx, ry, yo, n=n) for z, rx, ry, yo in rings])
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


def band(bm, z0, z1, rx, ry, yoff=0.0, rot=math.radians(30.0), n=6, taper=0.88):
    """Кольцо обмотки: короткая призма чуть шире рукояти."""
    a = hexring(z0, rx, ry, yoff, rot=rot, n=n)
    b = hexring(z0 + (z1 - z0) * 0.5, rx * 1.06, ry * 1.06, yoff, rot=rot, n=n)
    c = hexring(z1, rx * taper, ry * taper, yoff, rot=rot, n=n)
    return loft(bm, [a, b, c])


def grip(bm, rings, zs=(0.462, 0.516), height=0.024, over=1.14):
    """Обмотка рукояти: витки с промежутками, тёмная деталь поверх светлой."""
    for z0 in zs:
        rx, ry, yo = _lerp_ring(rings, z0)
        band(bm, z0, z0 + height, rx * over, ry * over, yoff=yo)
    return bm


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
    числу фасетов: у полотна светлой выходит верхняя грань наступа, средней —
    щека, повёрнутая к камере, тёмной — кромка и поднутрения.
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

    Нужна калибровке: по ней рисуется плоская проба и видно, какой тон какую
    нормаль получает в спрайте. Невидимые фасеты (смотрящие от камеры)
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

# Чем покрашен штык: 'a' и 'c' — железо, 'b' — деревянная лопата.
BLADE_FAMILY = {'a': 'iron', 'b': 'wood', 'c': 'iron'}

# Кто в модели какой семьи (нужно калибровке: у каждой семьи свои тона).
OBJECT_FAMILY = {
    'shovel_blade': None,       # по варианту
    'shovel_collar': None,      # по варианту — наступ это часть штыка
    'shovel_socket': 'iron',    # тулейка всегда кованая
    'shovel_handle': 'wood',
    'shovel_grip': 'leather',
}


def families(variant='a'):
    fam = dict(OBJECT_FAMILY)
    fam['shovel_blade'] = BLADE_FAMILY[variant]
    fam['shovel_collar'] = BLADE_FAMILY[variant]
    return fam


def build(variant='a', jitter=0.0006, seed=7):
    """Собрать лопату. Возвращает список объектов сцены."""
    palette()
    objs = []
    fam = BLADE_FAMILY[variant]
    rings = HANDLE_LONG if variant == 'c' else HANDLE
    wrap = GRIP_LONG if variant == 'c' else GRIP

    # --- полотно штыка ---
    bm = bmesh.new()
    blade(bm, BLADE)
    if jitter:
        _jitter(bm, jitter, seed)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = P.new_obj_from_bm(bm, 'shovel_blade', M(FAMILY[fam][1]))
    split_tones(ob, fam)
    objs.append(ob)

    # --- наступ ---
    bm = bmesh.new()
    box(bm, -COLLAR['x'], COLLAR['x'], -COLLAR['y'], COLLAR['y'],
        COLLAR['z0'], COLLAR['z1'])
    if jitter:
        _jitter(bm, jitter, seed + 1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = P.new_obj_from_bm(bm, 'shovel_collar', M(FAMILY[fam][1]))
    split_tones(ob, fam)
    objs.append(ob)

    # --- тулейка ---
    bm = bmesh.new()
    loft(bm, [hexring(z, r, r) for z, r in SOCKET])
    if jitter:
        _jitter(bm, jitter, seed + 2)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = P.new_obj_from_bm(bm, 'shovel_socket', M(FAMILY['iron'][1]))
    split_tones(ob, 'iron')
    objs.append(ob)

    # --- рукоять ---
    bm = bmesh.new()
    handle(bm, rings)
    if jitter:
        _jitter(bm, jitter, seed + 3)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = P.new_obj_from_bm(bm, 'shovel_handle', M('wood_mid'))
    split_tones(ob, 'wood')
    objs.append(ob)

    # --- обмотка грипа ---
    bm = bmesh.new()
    grip(bm, rings, **wrap)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = P.new_obj_from_bm(bm, 'shovel_grip', M('leather'))
    split_tones(ob, 'leather')
    objs.append(ob)

    return objs


def _jitter(bm, amount, seed):
    """Неровность: штык откован, рукоять срублена, а не выточена.

    Вершины двигаются вдоль луча от оси Z — фасет остаётся почти плоским,
    ломается только силуэт, а низ модели (кромка на земле) не дёргается:
    z не трогаем вовсе.
    """
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


def size_units(variant='a'):
    """Высота модели: торец рукояти над землёй."""
    return (HANDLE_LONG if variant == 'c' else HANDLE)[-1][0]
