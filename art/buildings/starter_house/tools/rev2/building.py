"""building.py — СТАРТОВЫЙ ДОМ ЖИТЕЛЯ для mapgen2. Чистый Python, без bpy.

Стиль снят с РАТУШИ (`art/buildings/townhall/tools/townhall.py`) — это
единственная модель, которую заказчик назвал идеальной.  Оттуда взято ВСЁ,
что определяет стиль, и ничего не додумано:

  1. ПАЛИТРА — те же двенадцать материалов (`tools/palette.py`), те же hex.
     Никаких «тонов по нормали»: цвет один на всю плоскость.
  2. СВЕСЫ — передний скат свисает НИЖЕ верха стены (как у ратуши): карниз
     1.42 при стене 1.55.  Торцевой свес и свес по скату — те же 0.24 / 0.28
     в масштабе дома.
  3. КРОВЛЯ — НЕСКОЛЬКО ПЛОСКИХ ПЛОСКОСТЕЙ, а не пила из пластов: два квада
     на скат, торцевые заделки толщиной 0.17, провисший конёк из сегментов,
     прижимные слеги, заплаты из старой соломы.
  4. СТЕНЫ — простые короба с дрожью 0.018, каркас из брусьев, угловые столбы.
  5. ПРОЁМЫ — тёмное нутро, наличник из досок, ставни, кольцо на двери.

ЧТО ЗДЕСЬ ДРУГОЕ (то, о чём просил заказчик: «деревня на ранней стадии»)
  1. Кровля закрыта НЕ ПОЛНОСТЬЮ: на переднем скате снизу не хватает куска —
     видны стропила и обрешётка.  Дом кроют, работа не кончена.
  2. На фасаде одна панель БЕЗ ОБМАЗКИ — стоит голый плетень.
  3. Цоколь не досложен на углу: вынутые булыжники лежат рядом.
  4. Во дворе штабель брёвен и вязанка соломы.
  5. Ни одной обжитой мелочи: ни трубы, ни мха, ни бочки, ни поленницы.

ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ
  * трубы — печь не сложена (отсюда и высота ниже канонных 2.60: у ратуши
    конёк 2.82 при стене 1.55, у дома 2.47 при стене 1.55);
  * «сломанных» деталей — дом НЕ разваливается, он НЕ ДОСТРОЕН.  Это разные
    вещи, и заказчик на первой ревизии сказал именно это.

ЯРУСЫ: цоколь -> стены с каркасом -> проёмы -> кровля -> конёк -> двор.
"""
import math
import random

# --------------------------------------------------------------------------
# КОНВЕНЦИИ: 1 юнит = 1 клетка, пятно 3 x 2, дверь в +Y, опора в (0,0,0)
# --------------------------------------------------------------------------
# ПЯТНО 2 x 3: короткая сторона по X (2 клетки), длинная по Y (3 клетки).
# Так дом ВЫТЯНУТ ВГЛУБЬ, как ратуша (её силуэт 423 x 392 px, отношение 1.08),
# а не «квадратный»: при пятне 3 x 2 по X он выходил 336 x 319 (0.95) и читался
# приземистым.  Дверь остаётся в +Y — камера смотрит с -X/+Y и видит её.
# Оси стен: 2 x 3 клетки с ЗАЗОРОМ до кромок пятна (правило заказчика
# 2026-10-13): на пятне 2 клетки зазор 1/3 клетки даёт 1.0 - 2/3 = 0.333,
# значит полуось стены 0.667 -> 1.33 по X.  Кровля свисает в воздух, её
# силуэт в пятно не загоняется.
WALL_X, WALL_Y = 1.44, 2.58
HX, HY = WALL_X / 2.0, WALL_Y / 2.0
# Высоты стен и кровли подобраны ВМЕСТЕ: карниз 1.45 должен лечь НИЖЕ верха
# стены (как у ратуши: стена 1.55, карниз 1.42), но не ниже — иначе между
# верхом стены и низом кровли остаётся щель (0.025 при стене 1.72 и карнизе
# 1.745 — в торце было видно нутро чердака).
WALL_H = 1.60
# Надставка стены до низа кровли.  Верх стены обязан быть НЕ ВЫШЕ низа
# кровли у стены (z_soffit(HX) = 1.633): при 1.60+0.045 он пробивал кровлю и
# в торце торчала тёмная полоса.
WALL_LIP = 0.034

PLINTH_H = 0.24                    # булыжник: z = -0.19 -> 0.05 (как у ратуши)
WALL_Z0 = 0.0

# --- КРОВЛЯ: конёк ВДОЛЬ ДЛИННОЙ ОСИ (Y), скаты падают по +-X --------------
# Так у ратуши: её конёк идёт по длинной стороне, и дом читается вытянутым.
# Скаты разной крутизны (карнизы на одной высоте, конёк смещён к фасаду) —
# это и есть своя форма при той же школе.
EAVE_Z = WALL_H - 0.20             # карниз ниже верха стены (у ратуши 0.13)
Z_RIDGE = EAVE_Z + 0.85            # конёк выше карниза
ROOF_OVER_X = 0.28                 # свес по скату: карниз даёт тень на обмазку
ROOF_HALF_X = HX + ROOF_OVER_X     # 1.12 — кромка кровли по X
ROOF_OVER_Y = 0.13                 # свес по торцу (конёк выступает за стены)
ROOF_HALF_Y = HY + ROOF_OVER_Y     # 1.63 — кромка кровли по Y
RIDGE_X = -0.12                    # конёк смещён к фасаду: скаты разной длины
ROOF_TH = 0.13                     # толщина соломы (дом меньше ратуши)
TAN_F = (Z_RIDGE - EAVE_Z) / (ROOF_HALF_X + RIDGE_X)   # скат -X, круче
TAN_B = (Z_RIDGE - EAVE_Z) / (ROOF_HALF_X - RIDGE_X)   # скат +X, положе
PITCH_FRONT = math.atan(TAN_F)
PITCH_BACK = math.atan(TAN_B)

# Пропуск в соломе: на скате К КАМЕРЕ (-X, он крутой и виден), у карниза.
# Дом кроют СНИЗУ ВВЕРХ, поэтому недоложен именно низ ската.
GAP_X0, GAP_X1 = -ROOF_HALF_X, 0.04    # по X: от карниза вверх
GAP_Y0, GAP_Y1 = -0.86, 0.90           # по Y: не по всей длине, торцы закрыты

# --- что не достроено ------------------------------------------------------
# Пропуск в соломе переднего ската: снизу, у карниза.  Дом кроют СНИЗУ ВВЕРХ
# (так кладут солому), значит недоложен именно низ ската.
GAP_Y0, GAP_Y1 = 0.30, ROOF_HALF_Y   # на скате К КАМЕРЕ: недоложен низ
GAP_X0, GAP_X1 = -0.62, 0.54         # по X: не по всей длине, кусок у торца уже закрыт
WATTLE_X = -0.72                     # панель фасада без обмазки (центр по X)
WATTLE_W = 0.54
PLINTH_GAP = 0.54                    # с какого |x| не досложен цоколь у фасада

SPEC = dict(
    footprint=(3, 2),
    wall_x=WALL_X, wall_y=WALL_Y, wall_h=WALL_H,
    z_plinth=PLINTH_H, z_wall=WALL_H,
    pitch_deg=round(math.degrees(PITCH_FRONT), 2),
    pitch_back_deg=round(math.degrees(PITCH_BACK), 2),
    over_slope=round(ROOF_OVER_X, 4),
    over_end=round(ROOF_OVER_Y, 4),
    tris=(300, 1500),
    note=('кровля не закрыта снизу переднего ската; трубы нет — печь не '
          'сложена, поэтому дом ниже канонных 2.60; пропорции кровли — '
          'ратушные (пологая длинная крыша, уклон 33)'),
    canon=dict(h_b=(1.95, 2.40), wall_h=(1.55, 1.85), pitch=(32.0, 55.0),
               over_slope=(0.11, 0.31), over_end=(0.04, 0.13),
               roof_wall=(0.45, 1.35), tris=(300, 1500)),
)


# --------------------------------------------------------------------------
# ПРИМИТИВЫ (та же арифметика, что в townhall/tools/thpipe.py)
# --------------------------------------------------------------------------
def _rot(p, cx, cy, cz, rz, rx, ry):
    x, y, z = p[0] - cx, p[1] - cy, p[2] - cz
    if rz:
        c, s = math.cos(rz), math.sin(rz)
        x, y = x * c - y * s, x * s + y * c
    if rx:
        c, s = math.cos(rx), math.sin(rx)
        y, z = y * c - z * s, y * s + z * c
    if ry:
        c, s = math.cos(ry), math.sin(ry)
        x, z = x * c + z * s, -x * s + z * c
    return (x + cx, y + cy, z + cz)


def box(cx, cy, z0, sx, sy, sz, rz=0.0, rx=0.0, ry=0.0, keep=None):
    """Короб; (cx, cy, z0) — центр ОСНОВАНИЯ.  Обход граней — наружу."""
    x0, x1 = cx - sx / 2.0, cx + sx / 2.0
    y0, y1 = cy - sy / 2.0, cy + sy / 2.0
    z1 = z0 + sz
    base = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    named = [('+z', (4, 5, 6, 7)), ('-z', (0, 3, 2, 1)),
             ('+y', (2, 3, 7, 6)), ('-y', (0, 1, 5, 4)),
             ('+x', (1, 2, 6, 5)), ('-x', (3, 0, 4, 7))]
    faces = [f for n, f in named if keep is None or n in keep]
    if rz or rx or ry:
        base = [_rot(p, cx, cy, z0, rz, rx, ry) for p in base]
        vol = _volume(base, faces)
        if vol < 0:                       # поворот зеркалит обход — выправить
            base = [base[0], base[3], base[2], base[1],
                    base[4], base[7], base[6], base[5]]
    return base, faces


def _volume(verts, faces):
    vol = 0.0
    for fc in faces:
        for k in range(1, len(fc) - 1):
            a, b, c = verts[fc[0]], verts[fc[k]], verts[fc[k + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                    - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return vol


def prism_x(poly_yz, x0, x1, keep=None):
    """Призма вдоль X по контуру в YZ; обход выправляется знаком площади."""
    if x1 < x0:
        x0, x1 = x1, x0
    poly = list(poly_yz)
    area = 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1]
                     - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))
    if area < 0.0:
        poly = poly[::-1]
    n = len(poly)
    verts = [(x0, y, z) for y, z in poly] + [(x1, y, z) for y, z in poly]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    if keep is not None:
        out = []
        if 'side' in keep:
            out += faces[:n]
        if '-x' in keep:
            out.append(faces[-2])
        if '+x' in keep:
            out.append(faces[-1])
        faces = out
    return verts, faces


def prism_y(poly_xz, y0, y1, keep=None):
    """Призма вдоль Y по контуру в плоскости XZ (конёк вдоль Y).

    Обход контура выправляется по знаку площади, поэтому фасеты смотрят
    НАРУЖУ: у кровли это верх скатов, низ карнизов и оба торца.  Тот же
    приём, что `prism_x` у щипца.
    """
    if y1 < y0:
        y0, y1 = y1, y0
    poly = list(poly_xz)
    area = 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1]
                     - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))
    if area < 0.0:
        poly = poly[::-1]
    n = len(poly)
    verts = [(x, y0, z) for x, z in poly] + [(x, y1, z) for x, z in poly]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    if keep is not None:
        out = []
        if 'side' in keep:
            out += faces[:n]
        if '-y' in keep:
            out.append(faces[-2])
        if '+y' in keep:
            out.append(faces[-1])
        faces = out
    return verts, faces


def plate(x0, x1, y0, y1, z0, z1):
    """Плоская плита-квад по четырём углам (для скатов кровли).

    Обход задаётся так, чтобы нормаль смотрела НАРУЖУ ската: у переднего
    (к камере, -Y) — вниз-вперёд, у заднего — вверх-назад.  Четыре вершины
    лежат в одной плоскости, поэтому фасет остаётся крупным и плоским.
    """
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1)]
    return v, [(0, 1, 2, 3)]


def bar(p0, p1, sx, sy, caps=(0, 1)):
    """Брусок из p0 в p1 (p0/p1 — центры торцов), сечение sx (вдоль u) x sy."""
    ax = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    ln = math.sqrt(ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2)
    w = (ax[0] / ln, ax[1] / ln, ax[2] / ln)
    ref = (0.0, 0.0, 1.0) if abs(w[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = (w[1] * ref[2] - w[2] * ref[1], w[2] * ref[0] - w[0] * ref[2],
         w[0] * ref[1] - w[1] * ref[0])
    ul = math.sqrt(sum(q * q for q in u)) or 1.0
    u = tuple(q / ul for q in u)
    v = (w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2],
         w[0] * u[1] - w[1] * u[0])
    hx, hy, hz = sx / 2.0, sy / 2.0, ln / 2.0
    cx = (p0[0] + p1[0]) / 2.0
    cy = (p0[1] + p1[1]) / 2.0
    cz = (p0[2] + p1[2]) / 2.0
    verts = []
    for sz in (-1, 1):
        for gx, gy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            verts.append((cx + u[0] * hx * gx + v[0] * hy * gy + w[0] * hz * sz,
                          cy + u[1] * hx * gx + v[1] * hy * gy + w[1] * hz * sz,
                          cz + u[2] * hx * gx + v[2] * hy * gy + w[2] * hz * sz))
    faces = [(4, 5, 6, 7), (0, 3, 2, 1), (2, 3, 7, 6), (0, 1, 5, 4),
             (1, 2, 6, 5), (3, 0, 4, 7)]
    keep = []
    if 0 in caps:
        keep.append(0)
    if 1 in caps:
        keep.append(1)
    keep += [2, 3, 4, 5]
    return verts, [faces[i] for i in sorted(set(keep))]


def jitter(verts, amount, seed):
    if not amount:
        return verts
    rng = random.Random(seed)
    return [(p[0] + rng.uniform(-amount, amount),
             p[1] + rng.uniform(-amount, amount),
             p[2] + rng.uniform(-amount, amount)) for p in verts]


def add(parts, name, mat, verts, faces, jit=0.0, seed=0, solid=False):
    parts.append(dict(name=name, family=mat,
                      verts=jitter(verts, jit, seed) if jit else verts,
                      faces=faces, solid=solid))
    return parts


def tris_of(parts):
    return sum(sum(len(f) - 2 for f in p['faces']) for p in parts)


# --------------------------------------------------------------------------
# ЯРУС 1: ЦОКОЛЬ — ряд валунов, как у ратуши; на фасаде не досложен
# --------------------------------------------------------------------------
def build_plinth(parts, rng):
    # Блоки НЕ выступают за полупятно: 0.60 + 0.40 = 1.00 по X (полупятно 1.0)
    # и 1.276 + 0.20 = 1.48 по Y (полупятно 1.5).
    xs = (-0.32, 0.0, 0.32)
    for i in range(len(xs)):
        cx = xs[i] + rng.uniform(-0.03, 0.03)
        for sy, wall in ((1, '+y'), (-1, '-y')):
            if wall == '+y' and cx > PLINTH_GAP:
                continue                      # камни с фасада ещё не положены
            # НИЗ ВАЛУНА НА ЗЕМЛЕ (z0 = 0.02, высота 0.26): иначе `ground()`
            # поднимает весь дом на глубину заделки, и кровля уезжает на 0.2
            # выше расчётной — самая дорогая ошибка этой сборки.
            v, f = box(cx, sy * (HY + 0.03), 0.02, 0.36, 0.18, 0.22,
                       rz=rng.uniform(-0.05, 0.05))
            add(parts, 'plinth_%d_%d' % (i, sy), 'stone', v, f, 0.014,
                300 + i * 3 + (sy > 0))
    for j, cy in enumerate((-0.86, 0.0, 0.86)):
        for sx in (1, -1):
            v, f = box(sx * (HX + 0.03), cy, 0.02, 0.18, 0.70, 0.22,
                       rz=rng.uniform(-0.05, 0.05))
            add(parts, 'plinth_x%d_%d' % (sx, j), 'stone', v, f, 0.014, 330 + j)
    v, f = box(0.0, 0.0, 0.02, WALL_X + 0.06, WALL_Y + 0.05, 0.20)
    add(parts, 'plinth_fill', 'stone2', v, f, 0.010, 350)
    v, f = box(0.0, 0.0, 0.20, WALL_X + 0.10, WALL_Y + 0.09, 0.05)
    add(parts, 'plinth_top', 'stone2', v, f, 0.006, 351)
    # вынутые булыжники у недосложенного угла — лежат рядом на земле
    for i, (x, y) in enumerate(((0.40, HY + 0.15), (0.56, HY + 0.11))):
        v, f = box(x, y, 0.0, 0.34, 0.26, 0.20,
                   rz=rng.uniform(-0.4, 0.4))
        add(parts, 'stone_loose%d' % i, 'stone', v, f, 0.012, 360 + i)


# --------------------------------------------------------------------------
# ЯРУС 2: СТЕНЫ И ПЛЕТЕНЬ
# --------------------------------------------------------------------------
def build_walls(parts):
    ax0, ax1 = WATTLE_X - WATTLE_W / 2.0, WATTLE_X + WATTLE_W / 2.0
    wz0, wz1 = 0.16, WALL_H - 0.22
    for sy in (1, -1):
        for x0, x1, tag in ((-HX, ax0, 'a'), (ax1, HX, 'b')):
            v, f = box((x0 + x1) / 2.0, sy * HY / 2.0, WALL_Z0, x1 - x0, HY,
                       WALL_H + WALL_LIP)
            add(parts, 'wall_y%d_%s' % (sy, tag), 'wall', v, f, 0.016, 400 + (tag == 'b'))
        for z0, z1, tag in ((WALL_Z0, wz0, 'low'), (wz1, WALL_H + WALL_LIP, 'high')):
            v, f = box((ax0 + ax1) / 2.0, sy * HY / 2.0, z0, ax1 - ax0, HY,
                       z1 - z0)
            add(parts, 'wall_y%d_%s' % (sy, tag), 'wall', v, f, 0.016, 410 + (tag == 'high'))
    for sx in (1, -1):
        v, f = box(sx * HX / 2.0, 0.0, WALL_Z0, HX, WALL_Y, WALL_H + WALL_LIP)
        add(parts, 'wall_x%d' % sx, 'wall', v, f, 0.016, 420 + (sx > 0))
    # ЩИПЕЦ — пятиугольник в плоскости XZ, выдавленный по Y (конёк вдоль Y).
    # Низ по верху стены, верх — по НИЗУ кровли (не по коньку: иначе под свесом
    # остаётся щель).  Раньше щипец вырезался `prism_x` (призмой вдоль X) — он
    # и улетал в небо отдельным треугольником.
    # Контур щипца: НИЗ по верху стены (WALL_H), ВЕРХ по низу кровли — иначе
    # получается плоский пятиугольник высотой 0.02 и щипца просто не видно
    # (так и было: в кадре 180 сквозь торец смотрело нутро чердака).
    # Щипец идёт НАРУЖУ до кромки кровли: если его наружная плоскость остаётся
    # внутри кровельной оболочки, `autocull` считает её закрытой и выбрасывает —
    # в торце открывался чердак (видно на повороте 180).
    # Контур: низ по верху стены, верх по НИЗУ кровли.  Толщина 0.12 — стена,
    # а не лист, и она ЗАКРЫВАЕТ торец дома выше обвязки: без этого через торец
    # видно нутро (в кадре 180 смотрело прямо на изнанку дальней стены).
    # Низ щипца — ПО НИЗУ КРОВЛИ У СТЕНЫ (z_soffit(HX) = 1.633 при стене
    # 1.625): если низ положить по верху стены, щипец уходит под кровлю и
    # снаружи остаётся незакрытая полоса торца.
    # Низ щипца — по ВЕРХУ СТЕНЫ (WALL_H), а не по низу кровли: разница всего
    # 0.008, и контур вырождался в плоскую фигуру нулевой высоты — щипца просто
    # не было, и в торце открывался чердак.  0.03 юнита щипца уходит под кровлю,
    # это нормально: кровля накрывает стену.
    gprof = [(HX, WALL_H), (HX, z_soffit(HX) + 0.01),
             (RIDGE_X, z_soffit(RIDGE_X)),
             (-HX, z_soffit(-HX) + 0.01), (-HX, WALL_H)]
    for sy in (1, -1):
        # Фасеты НЕ режем: наружная плоскость щипца лежит ВНУТРИ габарита
        # кровли, и любой срез/отсев выбрасывал её — в торце открывался чердак.
        v, f = prism_y(gprof, sy * HY, sy * (HY + 0.12))
        add(parts, 'gable%d' % sy, 'wall', v, f, 0.010, 430 + (sy > 0),
            solid=True)


def build_wattle(parts, rng):
    """Голый плетень на месте обмазки: колья и прутья.

    Прутья — ТОЛСТЫЕ и на всю панель (0.045): тонкая мелочь в спрайт не
    доедет и превратится в «мусорные фасеты» (гейт детализации валится).
    """
    y = HY + 0.02
    for i in range(4):
        ax = WATTLE_X - WATTLE_W / 2.0 + WATTLE_W * (i + 0.5) / 4.0
        v, f = box(ax, y - 0.03, 0.18, 0.07, 0.06, WALL_H - 0.46)
        add(parts, 'wattle_post%d' % i, 'timber', v, f, 0.008, 440 + i)
    for i in range(6):
        z = 0.28 + (WALL_H - 0.66) * i / 5.0
        v, f = box(WATTLE_X, y - 0.012, z, WATTLE_W + 0.06, 0.055, 0.055)
        add(parts, 'wattle_rod%d' % i, 'timber', v, f, 0.006, 450 + i)


# --------------------------------------------------------------------------
# ЯРУС 2b: КАРКАС — угловые столбы и обвязки (как у ратуши)
# --------------------------------------------------------------------------
def build_frame(parts, rng):
    h = WALL_H
    for sx in (1, -1):
        for sy in (1, -1):
            v, f = box(sx * HX, sy * HY, WALL_Z0, 0.19, 0.19, h)
            add(parts, 'corner_%d%d' % (sx, sy), 'timber', v, f, 0.010,
                500 + (sx > 0) * 2 + (sy > 0))
    for sy in (1, -1):
        v, f = box(0.0, sy * HY, 0.05, WALL_X, 0.14, 0.14)
        add(parts, 'plate_b%d' % sy, 'beam', v, f, 0.008, 510 + (sy > 0))
        v, f = box(0.0, sy * HY, h - 0.16, WALL_X, 0.16, 0.16)
        add(parts, 'plate_t%d' % sy, 'beam', v, f, 0.008, 512 + (sy > 0))
    for sx in (1, -1):
        v, f = box(sx * HX, 0.0, 0.05, 0.14, WALL_Y, 0.14)
        add(parts, 'plate_bx%d' % sx, 'beam', v, f, 0.008, 514 + (sx > 0))
        v, f = box(sx * HX, 0.0, h - 0.16, 0.16, WALL_Y, 0.16)
        add(parts, 'plate_tx%d' % sx, 'beam', v, f, 0.008, 516 + (sx > 0))
    # подкосы у входа — тот же приём, что у ратуши
    for sx in (1, -1):
        v, f = box(sx * 1.10, HY, 0.98, 0.09, 0.09, 0.40,
                   ry=math.radians(26 * sx))
        add(parts, 'brace%d' % sx, 'timber', v, f, 0.008, 520 + (sx > 0))


# --------------------------------------------------------------------------
# ЯРУС 3: ПРОЁМЫ — дверь и окна (тёмное нутро + наличник + ставни)
# --------------------------------------------------------------------------
DOOR_X = 0.58
WIN_FRONT_X = -0.30
WIN_SIDE_Y = 0.32


def build_door(parts):
    y0 = HY
    # наличник
    v, f = box(DOOR_X, y0 + 0.06, WALL_Z0, 0.78, 0.14, 1.22)
    add(parts, 'door_frame', 'timber', v, f, 0.008, 600)
    # тёмное нутро
    v, f = box(DOOR_X, y0 + 0.02, WALL_Z0, 0.62, 0.10, 1.10)
    add(parts, 'door_hole', 'dark', v, f, 0.004, 601)
    # полотно: три доски и две набивки (как у ратуши)
    for dx in (-0.19, 0.0, 0.19):
        v, f = box(DOOR_X + dx, y0 + 0.10, WALL_Z0 + 0.03, 0.17, 0.06, 1.02)
        add(parts, 'door_leaf%d' % int(dx * 100), 'plank', v, f, 0.007,
            602 + int(dx * 100))
    for z in (0.44, 0.92):
        v, f = box(DOOR_X, y0 + 0.10, z, 0.60, 0.05, 0.12)
        add(parts, 'door_batten%d' % int(z * 100), 'plank', v, f, 0.006,
            610 + int(z * 100))
    v, f = box(DOOR_X - 0.22, y0 + 0.16, 0.60, 0.06, 0.05, 0.06)
    add(parts, 'door_ring', 'iron', v, f, 0.0, 615)


def build_window(parts, cx, cy, side, tag, with_shutters=False):
    """Окно: тёмное нутро, наличник, ставни.  `side` — нормаль по Y (+1/-1)."""
    y0 = side * HY
    v, f = box(cx, y0 + side * 0.02, 0.10, 0.50, 0.11, 0.76)
    add(parts, tag + '_hole', 'dark', v, f, 0.004, 620 + int(cx * 10) % 7)
    v, f = box(cx, y0 + side * 0.07, 0.10, 0.54, 0.07, 0.80)
    add(parts, tag + '_case', 'beam', v, f, 0.007, 630 + int(cx * 10) % 7)
    # Ставни — ТОЛЬКО на фасадном окне (у ратуши так же), и они мельче
    # (@0.16): широкие створки вылезали за пятно и читались щитами.
    if with_shutters:
        for sgn in (1, -1):
            v, f = box(cx + sgn * 0.34, y0 + side * 0.08, 0.16, 0.16, 0.06, 0.60,
                       rz=math.radians(-side * sgn * 6.0))
            add(parts, tag + '_shut%d' % sgn, 'plank', v, f, 0.008,
                640 + int(cx * 10) % 7 + (sgn > 0))


# --------------------------------------------------------------------------
# ЯРУС 4: КРОВЛЯ — как у ратуши: несколько ПЛОСКИХ плоскостей
# --------------------------------------------------------------------------
def z_soffit(x):
    """НИЗ кровли: обе плоскости идут ОТ КОНЬКА ВНИЗ к своим карнизам.

    Конёк — ВЕРШИНА (максимум), скаты падают по +-X.  Обратный отсчёт (от
    карниза вверх) давал в коньке впадину, и кровля читалась «домиком наоборот».
    """
    if x >= RIDGE_X:
        return Z_RIDGE - (x - RIDGE_X) * TAN_B
    return Z_RIDGE - (RIDGE_X - x) * TAN_F


def z_ridge_top():
    return Z_RIDGE + ROOF_TH


def build_roof(parts, rng):
    """КРОВЛЯ: два ската призмами вдоль Y, пропуск в соломе, конёк, стропила.

    Конёк идёт ВДОЛЬ Y (длинная ось дома, как у ратуши), скаты падают по +-X.
    Каждый скат — ЗАМКНУТАЯ ПРИЗМА (`prism_y`) с четырёхточечным контуром:
    передняя кромка, конёк, задняя кромка.  Никаких квадов, собранных на глаз.

    Пропуск в соломе — на скате К КАМЕРЕ (-X): там видно стропила и обрешётку.
    Дом кроют снизу вверх, поэтому недоложен именно низ ската у карниза.
    """
    # --- СКАТ К КАМЕРЕ (-X) ----------------------------------------------
    # Пропуск в соломе — ПОЛОСА по Y от GAP_Y0 до GAP_Y1 у самого карниза:
    # дом кроют снизу вверх, поэтому недоложен низ ската.  Выше пропуска и по
    # бокам от него солома уложена до конька — плиты замкнутые (prism_y).
    for tag, y0, y1, x_in in (('near_b', GAP_Y1, ROOF_HALF_Y, -ROOF_HALF_X),
                              ('near_a', -ROOF_HALF_Y, GAP_Y0, -ROOF_HALF_X)):
        prof = [(x_in, z_soffit(x_in) - 0.02),
                (RIDGE_X, z_soffit(RIDGE_X) - 0.02),
                (RIDGE_X, z_soffit(RIDGE_X) + ROOF_TH),
                (x_in, z_soffit(x_in) + ROOF_TH * 0.55)]
        v, f = prism_y(prof, y0, y1)
        add(parts, 'roof_' + tag, 'thatch', v, f, 0.014, 700 + (tag == 'near_b'))
    # плита НАД пропуском: от кромки пропуска до конька
    x_in = GAP_X1
    prof = [(x_in, z_soffit(x_in) - 0.02),
            (RIDGE_X, z_soffit(RIDGE_X) - 0.02),
            (RIDGE_X, z_soffit(RIDGE_X) + ROOF_TH),
            (x_in, z_soffit(x_in) + ROOF_TH)]
    v, f = prism_y(prof, GAP_Y0, GAP_Y1)
    add(parts, 'roof_near_mid', 'thatch', v, f, 0.014, 702)

    # --- ДАЛЬНИЙ скат (+X): закрыт целиком -------------------------------
    prof = [(ROOF_HALF_X, z_soffit(ROOF_HALF_X) - 0.02),
            (RIDGE_X, z_soffit(RIDGE_X) - 0.02),
            (RIDGE_X, z_soffit(RIDGE_X) + ROOF_TH),
            (ROOF_HALF_X, z_soffit(ROOF_HALF_X) + ROOF_TH * 0.55)]
    v, f = prism_y(prof, -ROOF_HALF_Y, ROOF_HALF_Y)
    add(parts, 'roof_far', 'thatch', v, f, 0.014, 710)

    # --- КОНЁК вдоль Y: слега из сегментов, чуть провисшая ---------------
    seg = 8
    for i in range(seg):
        t0 = -ROOF_HALF_Y + 2 * ROOF_HALF_Y * i / seg
        t1 = -ROOF_HALF_Y + 2 * ROOF_HALF_Y * (i + 1) / seg
        sag = 0.03 * math.sin(math.pi * (i + 0.5) / seg)
        v, f = box(RIDGE_X, (t0 + t1) / 2.0, Z_RIDGE - 0.05 - sag,
                   0.26, (t1 - t0) * 1.03, 0.13)
        add(parts, 'ridge%d' % i, 'thatch2', v, f, 0.008, 730 + i)

    # --- ЧЕРДАЧНЫЙ НАСТИЛ: закрывает вид в нутро через пропуск в соломе ----
    # Он же — потолок дома: балки и накат по ним, как в любой избе.  Без него
    # через пропуск было видно внутренность (тёмное пятно в кадре).
    for i in range(5):
        y = -HY + 0.20 + i * (WALL_Y - 0.40) / 4.0
        v, f = box(0.0, y, WALL_H + WALL_LIP - 0.06, WALL_X - 0.16, 0.10, 0.10)
        add(parts, 'joist%d' % i, 'beam', v, f, 0.006, 790 + i)
    v, f = box(0.0, 0.0, WALL_H + WALL_LIP + 0.04, WALL_X - 0.14,
               WALL_Y - 0.20, 0.07)
    add(parts, 'attic_floor', 'plank', v, f, 0.008, 795)

    # --- прижимные слеги: по две на скат, лежат на соломе ----------------
    for sx, ang in ((-1, math.atan(TAN_F)), (1, math.atan(TAN_B))):
        for t in (0.42, 0.74):
            x = RIDGE_X + sx * t * (ROOF_HALF_X - abs(RIDGE_X))
            zc = z_soffit(x) + ROOF_TH + 0.018
            # слега ЧУТЬ КОРОЧЕ кромки кровли (0.94 против 1.0): с вылетом за
            # кромку она читалась отдельной планкой в воздухе
            v, f = box(x, 0.0, zc, 0.085, 2 * ROOF_HALF_Y * 0.94, 0.055,
                       ry=sx * ang)
            add(parts, 'batten%d_%d' % (sx, int(t * 100)), 'timber', v, f,
                0.005, 740 + int(t * 100) + (sx > 0))

    # --- СТРОПИЛА И ОБРЕШЁТКА в пропуске: дом ещё кроют ------------------
    x_a = -ROOF_HALF_X - 0.02
    x_b = GAP_X1 + 0.04
    for i in range(7):
        y = -HY + 0.12 + i * (WALL_Y - 0.24) / 6.0
        v, f = bar((x_a, y, z_soffit(x_a) - 0.052),
                   (x_b, y, z_soffit(x_b) - 0.052), 0.075, 0.072)
        add(parts, 'rafter%d' % i, 'timber', v, f, 0.004, 760 + i)
    for k in range(3):
        x = -ROOF_HALF_X + 0.14 + (GAP_X1 + ROOF_HALF_X - 0.22) * k / 2.0
        v, f = box(x, 0.0, z_soffit(x) - 0.034, 0.05, WALL_Y + 0.06, 0.09)
        add(parts, 'lath%d' % k, 'plank', v, f, 0.004, 770 + k)


def build_yard(parts, rng):
    # штабель брёвен у тыла
    for row in range(2):
        n = 3
        for i in range(n):
            x = -HX + 0.46 + i * 0.28 + row * 0.13
            y = -HY - 0.13 - row * 0.12
            r = 0.070 - row * 0.004
            # ряд кладётся НА ЗЕМЛЮ: низ бревна на нуле, второй ряд сверху
            v, f = bar((x - 0.22, y, r + row * 0.128),
                       (x + 0.22, y, r + row * 0.128), r * 2, r * 2)
            add(parts, 'log_%d_%d' % (row, i), 'beam', v, f, 0.006,
                800 + row * 8 + i)
    # вязанка соломы на земле
    v, f = box(0.30, HY + 0.10, 0.0, 0.42, 0.26, 0.20, rz=math.radians(9.0))
    add(parts, 'straw', 'thatch', v, f, 0.014, 830)
    v, f = box(0.30, HY + 0.10, 0.0, 0.11, 0.29, 0.22, rz=math.radians(9.0))
    add(parts, 'straw_tie', 'timber', v, f, 0.006, 831)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None, seed=11):
    rng = random.Random(seed)
    parts = []
    build_plinth(parts, rng)
    build_walls(parts)
    build_wattle(parts, rng)
    build_frame(parts, rng)
    build_door(parts)
    build_window(parts, WIN_FRONT_X, HY, 1, 'win_f', with_shutters=True)
    build_window(parts, -HX, WIN_SIDE_Y, 1, 'win_s')
    build_roof(parts, rng)
    build_yard(parts, rng)
    ground(parts)
    autocull(parts)
    return parts


def ground(parts):
    """Опора в (0,0,0): дрожь не должна топить дом в землю."""
    lo = min(v[2] for p in parts for v in p['verts'])
    if lo < 0.0:
        for p in parts:
            p['verts'] = [(v[0], v[1], v[2] - lo) for v in p['verts']]
    return -lo if lo < 0.0 else 0.0


def _tri(pts):
    return [(0, 1, 2)] if len(pts) == 3 else [(0, 1, 2, 3)]


def _face_normal(verts, f):
    """Нормаль фасета по обходу — как её увидит Blender."""
    p = [verts[i] for i in f]
    e1 = [p[1][i] - p[0][i] for i in range(3)]
    e2 = [p[2][i] - p[0][i] for i in range(3)]
    n = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
         e1[0] * e2[1] - e1[1] * e2[0])
    d = math.sqrt(sum(t * t for t in n)) or 1.0
    return tuple(t / d for t in n)


def autocull(parts):
    """Убрать фасеты, ЦЕЛИКОМ утопленные в закрытом соседе.

    Контракт (тот же, что у `forge.autocull`): фасет выбрасывается, только
    если ВСЕ его пробные точки (центр и углы, поджатые к центру) лежат внутри
    габарита ЗАМКНУТОЙ детали-соседа.

    Раньше тест был «центр внутри габарита ЛЮБОГО соседа» — из-за этого у
    щипца выбрасывалась наружная грань (её центр попадал в габарит стропила),
    и в торце открывалось нутро чердака.
    """
    boxes = []
    for p in parts:
        v = p['verts']
        boxes.append(([min(q[i] for q in v) for i in range(3)],
                      [max(q[i] for q in v) for i in range(3)]))
    # ЗАМКНУТОСТЬ берётся из метки детали, а не из числа фасетов: у щипца
    # призма с пятью боковинами и двумя торцами, и по числу он «замкнут», но
    # проверять соседей им нельзя — кровля нависает над ним.
    solid = [bool(p.get('solid')) or len(p['faces']) == 6 for p in parts]
    for pi, p in enumerate(parts):
        if p.get('nocull') or len(p['faces']) < 3:
            continue
        v = p['verts']
        keep = []
        for f in p['faces']:
            pts = [v[i] for i in f]
            cen = [sum(q[k] for q in pts) / len(pts) for k in range(3)]
            probes = [cen] + [[cen[k] + (q[k] - cen[k]) * 0.80 for k in range(3)]
                              for q in pts]
            hidden = True
            for q in probes:
                inside = False
                for si, (lo, hi) in enumerate(boxes):
                    if si == pi or not solid[si]:
                        continue
                    if all(lo[k] + 0.002 <= q[k] <= hi[k] - 0.002
                           for k in range(3)):
                        inside = True
                        break
                if not inside:
                    hidden = False
                    break
            if not hidden:
                keep.append(f)
        # ни одной грани остаться не может: пустая деталь — дыра в меше
        p['faces'] = keep if keep else p['faces']
    return parts


def stats(parts):
    return dict(verts=sum(len(p['verts']) for p in parts), tris=tris_of(parts),
                parts=len(parts))


if __name__ == '__main__':
    p = build()
    print(stats(p))
    xs = [v[0] for q in p for v in q['verts']]
    ys = [v[1] for q in p for v in q['verts']]
    zs = [v[2] for q in p for v in q['verts']]
    print('габарит X %.3f..%.3f  Y %.3f..%.3f  Z %.3f..%.3f'
          % (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))
    print('RIDGE_X %.4f  Z_RIDGE %.4f  EAVE_Z %.4f' % (RIDGE_X, Z_RIDGE, EAVE_Z))
