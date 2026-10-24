"""warcamp.py — ВОЕННЫЙ ЛАГЕРЬ для 4tox/mapgen2: точка сбора дружины.

Это НЕ постройка: у лагеря нет стен, щипца, кровли и цоколя.  Посреди площадки
5 x 5 клеток стоит небольшая (2 x 2 клетки) точка сбора, вокруг которой в игре
встанут воины:

    * знамя дружины на каменном основании — вертикаль силуэта;
    * стойка с копьями и двумя круглыми щитами;
    * боевой котёл-литавра на треноге;
    * костёр с котлом на треноге — кухня лагеря;
    * ящик припаса и кадка.

Так лагерь читается как МЕСТО СБОРА, а не как ещё один дом: шатров и палаток
нет намеренно — они заняли бы всю площадку, а она нужна воинам.  Заказчик:
«самих воинов туда пихать не надо, надо сделать только 3д модель».

МАСШТАБ.  В игре постройка ставится крупностью `mul = siteMul(5) = 0.7973`
(`mapgen2/js/buildings.js`): 1 клетка карты = 1 / mul = 1.2542 юнита модели.
Поэтому модель 2 x 2 клетки в юнитах — 2.5084 x 2.5084, а пустая площадка
5 x 5 — 6.2709 x 6.2709.  Центр модели — центр площадки, низ на z = 0.
Габарит модели НЕ выходит за её 2 x 2: остальное место площадки остаётся
прозрачным, туда игра поставит воинов.

ПАЛИТРА — 12 плоских красок ратуши, дословно (`tools/village.py`): ни одного
нового цвета.  Стиль — 4tox-lowpoly-3d: плоские фасеты, низкий полигонаж,
канонная изометрия 96 ppu, контур и (у построек игры) без тени.

Оси: X — вправо, Y — на камеру (+Y — «перед»), Z — вверх.  Повороты — четыре
по 90°, как у всех построек.
"""
import math
import random

import forge as F
import village as V

# --------------------------------------------------------------------------
# КАНОННЫЕ РАЗМЕРЫ ЭТОЙ МОДЕЛИ
# --------------------------------------------------------------------------
CELLS = (2, 2)                       # сколько клеток занимает САМА модель
SITE = (5, 5)                        # площадка, на которой она стоит
BASE_MARGIN = 1.0 / 3.0
MARGIN_K = 0.92
MUL = round((1.0 - 2.0 * BASE_MARGIN / max(SITE)) * MARGIN_K, 4)   # 0.7973
CELL = 1.0 / MUL                     # 1.2542 юнита модели на клетку карты
MODEL = CELLS[0] * CELL              # 2.5084 — сторона пятна модели
HALF = MODEL / 2.0                   # 1.2542 — половина пятна

# Площадка: низкий утоптанный круг.  Верх приподнят на PATCH_Z, наземные
# предметы утоплены в него на SINK — так у них нет нижней грани, лежащей
# ровно в плоскости площадки (иначе z-fighting).
PATCH_Z = 0.055
SINK = 0.008
BASE_Z = PATCH_Z - SINK              # 0.047 — низ наземных предметов

SPEC = dict(
    footprint=(round(MODEL, 3), round(MODEL, 3)),   # пятно САМОЙ модели, 2x2
    site=SITE,                                     # площадка в игре, 5x5
    cells=CELLS,
    mul=MUL,
    cell=round(CELL, 4),
    wall_h=1.12,                      # верх треноги (в отчёте — опора)
    z_plinth=PATCH_Z,                 # верх площадки
    z_wall=1.12,
    ridge_z=None,                     # кровли нет
    pitch_deg=None,
    over_slope=0.0,
    over_end=0.0,
    class_='yard',
    # Канон двора: баннер — вертикаль силуэта, поэтому высота до 2.6, а не
    # «высота навеса» 1.4..2.1.  Остальное — как у лагеря лесоруба.
    canon=dict(h_b=(1.50, 2.60), min_detail=0.02, tris=(300, 1500)),
)


# --------------------------------------------------------------------------
# ПРИМИТИВЫ
# --------------------------------------------------------------------------
def move(verts, dx, dy, dz=0.0):
    return [(v[0] + dx, v[1] + dy, v[2] + dz) for v in verts]


def rot_z(verts, deg, px=0.0, py=0.0):
    """Поворот вокруг вертикальной оси через (px, py)."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [(px + (v[0] - px) * c - (v[1] - py) * s,
             py + (v[0] - px) * s + (v[1] - py) * c, v[2]) for v in verts]


def rot_x(verts, deg, py=0.0, pz=0.0):
    """Поворот вокруг оси X: щиты, наконечники, прислонённые вещи."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [(v[0], py + (v[1] - py) * c - (v[2] - pz) * s,
             pz + (v[1] - py) * s + (v[2] - pz) * c) for v in verts]


def add(parts, name, family, vf, jit=0.0, seed=0, zjit=True, nocull=False):
    """Добавить деталь.  Дрожь по умолчанию в XY: низ наземной детали не
    уезжает под землю (иначе `ground()` поднимет ВСЮ модель)."""
    verts, faces = vf
    if jit:
        verts = F.jitter(verts, jit, seed,
                         axis=None if zjit else (1, 1, 0))
    F.part(parts, name, family, verts, faces, nocull=nocull)


def lathe(cx, cy, rings, n=8, phase=0.0):
    """Тело вращения по кольцам [(z, rx, ry), ...], снизу вверх.

    Верх и низ закрыты: у каждой детали есть низ, а полая труба в кадре
    светит изнанкой (`references/yard.md`, правило 1).
    """
    verts = []
    for z, rx, ry in rings:
        for k in range(n):
            a = phase + 2.0 * math.pi * k / n
            verts.append((cx + rx * math.cos(a), cy + ry * math.sin(a), z))
    m = len(rings)
    faces = []
    for i in range(m - 1):
        for k in range(n):
            a = i * n + k
            b = i * n + (k + 1) % n
            c = (i + 1) * n + (k + 1) % n
            d = (i + 1) * n + k
            faces.append((a, b, c, d))
    faces.append(tuple(range(n - 1, -1, -1)))                 # низ
    faces.append(tuple(range((m - 1) * n, m * n)))            # верх
    return verts, faces


def rod(p0, p1, r, n=6, phase=0.0):
    """Круглая в сечении палка (древко, жердь, рукоять) между двумя точками."""
    ax = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    ln = math.sqrt(sum(c * c for c in ax))
    w = tuple(c / ln for c in ax)
    ref = (0.0, 0.0, 1.0) if abs(w[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = F._norm((ref[1] * w[2] - ref[2] * w[1],
                 ref[2] * w[0] - ref[0] * w[2],
                 ref[0] * w[1] - ref[1] * w[0]))
    v = (w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2],
         w[0] * u[1] - w[1] * u[0])
    verts = []
    for p in (p0, p1):
        for k in range(n):
            a = phase + 2.0 * math.pi * k / n
            verts.append((p[0] + u[0] * r * math.cos(a) + v[0] * r * math.sin(a),
                          p[1] + u[1] * r * math.cos(a) + v[1] * r * math.sin(a),
                          p[2] + u[2] * r * math.cos(a) + v[2] * r * math.sin(a)))
    faces = []
    for k in range(n):
        a = k
        b = (k + 1) % n
        c = n + (k + 1) % n
        d = n + k
        faces.append((a, b, c, d))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    return verts, faces


def disc_y(cx, cy, cz, r, t, n=8, phase=0.0):
    """Круглая пластина в плоскости XZ, толщиной по Y (щит, лицо барабана)."""
    poly = [(cx + r * math.cos(phase + 2.0 * math.pi * k / n),
             cz + r * math.sin(phase + 2.0 * math.pi * k / n)) for k in range(n)]
    return F.prism(poly, cy - t / 2.0, cy + t / 2.0, axis=1)


def pyramid(cx, cy, z0, z1, r, n=4, phase=math.pi / 4.0):
    """Пирамида/наконечник: низ — n-угольник, верх — точка."""
    verts = [(cx + r * math.cos(phase + 2.0 * math.pi * k / n),
              cy + r * math.sin(phase + 2.0 * math.pi * k / n), z0)
             for k in range(n)]
    apex = len(verts)
    verts.append((cx, cy, z1))
    faces = [tuple(range(n - 1, -1, -1))]
    for k in range(n):
        faces.append((k, (k + 1) % n, apex))
    return verts, faces


def rock(cx, cy, z0, r, h, seed, n=6, fam='stone'):
    """Валун: два неровных кольца и верхняя грань.  Нижняя грань есть всегда."""
    rng = random.Random(seed)
    bot, top = [], []
    for k in range(n):
        a = 2.0 * math.pi * k / n + rng.uniform(-0.12, 0.12)
        rb = r * rng.uniform(0.82, 1.10)
        bot.append((cx + rb * math.cos(a), cy + rb * math.sin(a), z0))
        rt = rb * rng.uniform(0.55, 0.82)
        top.append((cx + rt * math.cos(a + 0.10), cy + rt * math.sin(a + 0.10),
                    z0 + h * rng.uniform(0.80, 1.10)))
    verts = bot + top
    faces = []
    for k in range(n):
        faces.append((k, (k + 1) % n, n + (k + 1) % n, n + k))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    return verts, faces


def blade(x, y, z0, h, w, d, lean_x=0.0, lean_y=0.0):
    """Травинка: треугольная пирамидка с наклоном верхушки."""
    b = [(x - w / 2.0, y - d / 2.0, z0), (x + w / 2.0, y - d / 2.0, z0),
         (x, y + d / 2.0, z0)]
    apex = (x + lean_x, y + lean_y, z0 + h)
    verts = b + [apex]
    faces = [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)]
    return verts, faces


def leaf_head(cx, cy, cz, h, w, t, tilt=0.0):
    """Наконечник копья: плоский лист в плоскости XZ, толщина по Y."""
    poly = [(cx, cz), (cx + w / 2.0, cz + h * 0.26),
            (cx + w * 0.30, cz + h * 0.68), (cx, cz + h),
            (cx - w * 0.30, cz + h * 0.68), (cx - w / 2.0, cz + h * 0.26)]
    verts, faces = F.prism(poly, cy - t / 2.0, cy + t / 2.0, axis=1)
    if tilt:
        verts = rot_x(verts, tilt, py=cy, pz=cz)
    return verts, faces


# --------------------------------------------------------------------------
# 1. ПЛОЩАДКА: утоптанная земля, валуны по краю, трава
# --------------------------------------------------------------------------
def build_ground(parts, rng):
    """Низкая площадка 2 x 2 клетки.  Её нижнее кольцо и есть наземный контур:
    регулярный 12-угольник с вершинами на осях даёт bbox 2.5084 на всех
    четырёх поворотах, поэтому спрайт не «дышит» (`references/yard.md`, §2)."""
    n = 12
    bot, top = [], []
    for k in range(n):
        a = 2.0 * math.pi * k / n
        bot.append((HALF * math.cos(a), HALF * math.sin(a), 0.0))
        rt = 1.185 + 0.018 * ((k * 5) % 3)        # верх чуть неровный
        top.append((rt * math.cos(a + 0.02),
                    rt * math.sin(a + 0.02), PATCH_Z))
    verts = bot + top
    faces = []
    for k in range(n):
        faces.append((k, (k + 1) % n, n + (k + 1) % n, n + k))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    add(parts, 'ground_patch', 'dirt', (verts, faces))

    # Три низких камня у кромки: площадка не выглядит циркулем.  Их немного
    # намеренно — каждый камень дробит крупный фасет земли, а стиль-гейт
    # считает мелочь; три штуки проходят с запасом.
    for k, ang in enumerate((28.0, 148.0, 268.0)):
        a = math.radians(ang)
        v, f = rock(1.175 * math.cos(a), 1.175 * math.sin(a), 0.0,
                    rng.uniform(0.060, 0.078), rng.uniform(0.050, 0.070),
                    3150 + k, n=5)
        add(parts, 'edge_stone_%d' % k,
            'stone' if k % 2 == 0 else 'stone2', (v, f), jit=0.003,
            seed=3160 + k, zjit=False)


# --------------------------------------------------------------------------
# 2. ЗНАМЯ: вертикаль силуэта, лицом по диагонали (читается на 0 и 90)
# --------------------------------------------------------------------------
BANNER = (-0.50, -0.55)
BANNER_TOP = 2.38
BANNER_ROT = 180.0


def build_banner(parts, rng):
    bx, by = BANNER

    # Каменное основание: плита и два валуна.  Столб уходит в плиту, а не
    # начинается над ней — стык «по касательной» в кадре читается щелью.
    v, f = F.box(bx, by, BASE_Z, 0.40, 0.38, 0.115,
                 rz=math.radians(8.0),
                 keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    add(parts, 'banner_base', 'stone2', (v, f), jit=0.004, seed=3300,
        zjit=False)

    # Столб: 6 граней, от плиты до верхушки.
    v, f = lathe(bx, by, [(0.145, 0.047, 0.047), (BANNER_TOP, 0.041, 0.041)],
                 n=6, phase=math.pi / 6.0)
    add(parts, 'banner_pole', 'timber', (v, f), jit=0.002, seed=3320)

    # Перекладина и полотнище — ВДОЛЬ ОСИ X.  Это не «лицом на камеру»:
    # камера изометрическая, её экранное «вправо» — это (-X, -Y).  Плоскость
    # вдоль оси даёт на поворотах 0 и 90 одинаковые 0.707 ширины, а плоскость
    # под 45° на 0 видна целиком, на 90 — РЕБРОМ.  Игра берёт FACE_ROT = 90,
    # и на первом прогоне знамя там исчезало.  Проверено живым рендером.
    u = (math.cos(math.radians(BANNER_ROT)), math.sin(math.radians(BANNER_ROT)))
    z_bar = 1.995
    v, f = F.bar((bx - u[0] * 0.06, by - u[1] * 0.06, z_bar),
                 (bx + u[0] * 0.72, by + u[1] * 0.72, z_bar),
                 0.055, 0.052, caps=(0, 1))
    add(parts, 'banner_crossbar', 'beam', (v, f), jit=0.002, seed=3330)

    # Полотнище: 5-угольник с вырезом снизу, толщина 0.028.  Цвет — светлая
    # солома ратуши (thatch), эмблема — тёмный каркас (timber).  Зелёная
    # плоскость (moss) на солнце уходила из палитры деревни на Δ29, и
    # стиль-гейт падал на поворотах 180/270; светлая солома даёт 100 %.
    poly = [(0.01, 1.985), (0.73, 1.985), (0.73, 1.34),
            (0.37, 1.155), (0.01, 1.34)]
    v, f = F.prism(poly, -0.014, 0.014, axis=1)
    v = rot_z(v, BANNER_ROT)
    v = move(v, bx, by)
    add(parts, 'banner_cloth', 'thatch', (v, f), jit=0.0)

    # Эмблема — ромб, проходящий сквозь полотнище: видна с ОБЕИХ сторон,
    # поэтому не исчезает на поворотах 180/270.
    poly = [(0.37, 1.45), (0.485, 1.625), (0.37, 1.80), (0.255, 1.625)]
    v, f = F.prism(poly, -0.021, 0.021, axis=1)
    v = rot_z(v, BANNER_ROT)
    v = move(v, bx, by)
    add(parts, 'banner_emblem', 'timber', (v, f), jit=0.0)

    # Обмотка перекладины и навершие-наконечник.
    v, f = lathe(bx, by, [(z_bar - 0.055, 0.056, 0.056),
                          (z_bar + 0.055, 0.056, 0.056)],
                 n=6, phase=math.pi / 6.0)
    add(parts, 'banner_lashing', 'dark', (v, f), jit=0.0)
    v, f = pyramid(bx, by, BANNER_TOP - 0.01, BANNER_TOP + 0.145, 0.042, n=4)
    add(parts, 'banner_finial', 'iron', (v, f), jit=0.0)


# --------------------------------------------------------------------------
# 3. СТОЙКА С КОПЬЯМИ И ЩИТАМИ
# --------------------------------------------------------------------------
RACK_X = (0.30, 1.02)
RACK_Y = -0.60
RACK_TOP = 1.10


def build_rack(parts, rng):
    # Стойки слегка завалены назад: стойка «на линейке» в кадре скучна.
    for i, x in enumerate(RACK_X):
        v, f = F.bar((x, RACK_Y + 0.05, BASE_Z), (x, RACK_Y - 0.04, RACK_TOP),
                     0.078, 0.078, caps=(0, 1))
        add(parts, 'rack_post_%d' % i, 'timber', (v, f), jit=0.003,
            seed=3400 + i, zjit=False)

    # Верхняя и нижняя перекладины.  Верхняя держит копья, нижняя — щиты.
    for i, (z, y, t) in enumerate(((1.06, RACK_Y - 0.035, 0.065),
                                   (0.34, RACK_Y + 0.005, 0.050))):
        v, f = F.bar((RACK_X[0] - 0.05, y, z), (RACK_X[1] + 0.05, y, z),
                     t, t, caps=(0, 1))
        # Верхняя перекладина: её низ виден с нижних ракурсов, а копья
        # проходят сквозь неё.  Автоотсев снимал низ и смотрел изнанкой на
        # -15° (568 px); 4 лишних треугольника дешевле дыры.
        add(parts, 'rack_bar_%d' % i, 'beam', (v, f), jit=0.002,
            seed=3410 + i, nocull=True)

    # Три копья.  Комель на земле перед стойкой, древко проходит сквозь
    # верхнюю перекладину — не «висит рядом» (правило стыка).
    for i, x in enumerate((0.42, 0.64, 0.86)):
        y0, y1 = -0.365, -0.795
        v, f = rod((x, y0, BASE_Z), (x, y1, 1.50), 0.027, n=6)
        add(parts, 'spear_shaft_%d' % i, 'plank', (v, f), jit=0.002,
            seed=3420 + i, zjit=False)
        # Наконечник наклонён вместе с древком (11°): иначе лист смотрит
        # вверх, а древко — назад, и стык разваливается.
        tilt = math.degrees(math.atan2(y1 - y0, 1.50 - BASE_Z))
        v, f = leaf_head(x, y1, 1.485, 0.225, 0.082, 0.022,
                         tilt=-tilt + (i - 1) * 7.0)
        add(parts, 'spear_head_%d' % i, 'iron', (v, f), jit=0.0)

    # Два щита висят на верхней перекладине лицом на камеру (+Y).  Так они
    # не спорят с копьями за землю и читаются кругом на повороте 0.
    for i, (x, r, zc) in enumerate(((0.42, 0.215, 0.690),
                                    (0.86, 0.195, 0.665))):
        # Задняя пластина — обод, передняя — лицо, бляха — железо.
        v, f = disc_y(x, RACK_Y + 0.105, zc, r, 0.030, n=8,
                      phase=math.pi / 8.0)
        add(parts, 'shield_rim_%d' % i, 'timber', (v, f), jit=0.0)
        v, f = disc_y(x, RACK_Y + 0.125, zc, r * 0.88, 0.026, n=8,
                      phase=math.pi / 8.0)
        add(parts, 'shield_face_%d' % i, 'thatch', (v, f), jit=0.0)
        v, f = disc_y(x, RACK_Y + 0.145, zc, r * 0.28, 0.030, n=6)
        add(parts, 'shield_boss_%d' % i, 'iron', (v, f), jit=0.0)
        # Ремень от щита к перекладине: щит ВИСИТ, а не парит.
        v, f = F.bar((x, RACK_Y + 0.115, zc + r * 0.86),
                     (x, RACK_Y - 0.02, 1.06), 0.026, 0.026, caps=(0, 1))
        add(parts, 'shield_strap_%d' % i, 'dark', (v, f), jit=0.0)


# --------------------------------------------------------------------------
# 4. ПОЛЕННИЦА У КОСТРА: три полена, торцы к камере
# --------------------------------------------------------------------------
WOODPILE = (0.80, 0.55)


def build_woodpile(parts, rng):
    """Три полена пирамидкой у костра.

    Снятый щит читался сковородой (тонкий кол превращался в ручку), барабан —
    бочонком.  Поленница — тот же «лагерь», но крупнее по фасету и честнее:
    светлые торцы к камере, тёмные бока, три тела разной высоты.
    """
    cx, cy = WOODPILE
    r, ln = 0.072, 0.48
    y0, y1 = cy - ln / 2.0, cy + ln / 2.0
    rows = ((cx - 0.076, BASE_Z + r, 'plank'),
            (cx + 0.076, BASE_Z + r, 'beam'),
            (cx, BASE_Z + r * 2.8, 'timber'))
    for i, (x, z, fam) in enumerate(rows):
        # Своя фаза каждому бревну: одинаковые шестигранники кладут боковины
        # в одну плоскость, и xray ловит пару wood_log_1 <-> wood_log_2.
        v, f = rod((x, y0, z), (x, y1, z), r, n=6,
                   phase=math.pi / 6.0 + i * 0.19)
        # nocull: бревно замкнутое, а торцы — его собственные крышки.  Отдельные
        # светлые диски на торцах давали 3 мелких фасета, и стиль-гейт на 90°
        # падал по «мусору» (42 %); торец и так читается по нормали.
        add(parts, 'wood_log_%d' % i, fam, (v, f), jit=0.003,
            seed=3800 + i, zjit=False, nocull=True)


# --------------------------------------------------------------------------
# 5. КОСТЁР С КОТЛОМ НА ТРЕНОГЕ — кухня лагеря
# --------------------------------------------------------------------------
FIRE = (-0.28, 0.42)
FIRE_APEX = 1.12


def build_fire(parts, rng):
    cx, cy = FIRE

    # Зола и угли.
    v, f = lathe(cx, cy, [(BASE_Z, 0.295, 0.295), (0.065, 0.285, 0.285)],
                 n=10, phase=math.pi / 10.0)
    add(parts, 'fire_ash', 'dark', (v, f), jit=0.0)

    # Камни очага: десять валунов, у каждого своя фаза и размер.
    for k in range(6):
        a = math.radians(8.0 + 60.0 * k + rng.uniform(-4.0, 4.0))
        rr = rng.uniform(0.365, 0.405)
        v, f = rock(cx + rr * math.cos(a), cy + rr * math.sin(a), BASE_Z,
                    rng.uniform(0.070, 0.095), rng.uniform(0.095, 0.145),
                    3600 + k, n=5)
        add(parts, 'fire_stone_%d' % k,
            'stone' if k % 2 == 0 else 'stone2', (v, f), jit=0.004,
            seed=3610 + k, zjit=False)

    # Четыре полена крест-накрест: два обугленных (dark), два светлых.
    for k, (ang, fam) in enumerate(((12.0, 'timber'), (68.0, 'dark'),
                                    (128.0, 'timber'))):
        a = math.radians(ang)
        dx, dy = math.cos(a) * 0.26, math.sin(a) * 0.26
        v, f = rod((cx - dx, cy - dy, 0.105), (cx + dx, cy + dy, 0.105),
                   0.042, n=6, phase=0.3 * k)
        add(parts, 'fire_log_%d' % k, fam, (v, f), jit=0.003,
            seed=3620 + k, zjit=False)

    # Тренога.
    for k in range(3):
        a = math.radians(30.0 + 120.0 * k)
        fx, fy = cx + 0.52 * math.cos(a), cy + 0.52 * math.sin(a)
        v, f = F.bar((fx, fy, BASE_Z), (cx, cy, FIRE_APEX), 0.045, 0.043,
                     caps=(0, 1))
        add(parts, 'fire_tripod_%d' % k, 'timber', (v, f), jit=0.003,
            seed=3640 + k, zjit=False)
    v, f = lathe(cx, cy, [(FIRE_APEX - 0.065, 0.060, 0.060),
                          (FIRE_APEX + 0.035, 0.052, 0.052)],
                 n=6, phase=math.pi / 6.0)
    add(parts, 'fire_lashing', 'dark', (v, f), jit=0.0)

    # Котёл: чаша, обод, тёмное нутро, дужка и цепь до узла треноги.
    v, f = lathe(cx, cy, [(0.52, 0.105, 0.105), (0.575, 0.178, 0.178),
                          (0.685, 0.175, 0.175), (0.715, 0.188, 0.188)],
                 n=8, phase=math.pi / 8.0)
    add(parts, 'cauldron', 'iron', (v, f), jit=0.002, seed=3650)
    v, f = lathe(cx, cy, [(0.712, 0.158, 0.158), (0.728, 0.158, 0.158)],
                 n=8, phase=math.pi / 8.0)
    add(parts, 'cauldron_soup', 'dark', (v, f), jit=0.0)
    for k, sx in enumerate((-1.0, 1.0)):
        v, f = F.bar((cx + sx * 0.150, cy, 0.715),
                     (cx + sx * 0.040, cy, 0.815), 0.028, 0.028, caps=(0, 1))
        add(parts, 'cauldron_bail_%d' % k, 'iron', (v, f), jit=0.0)
    v, f = rod((cx, cy, 0.805), (cx, cy, FIRE_APEX - 0.025), 0.018, n=5)
    add(parts, 'cauldron_chain', 'iron', (v, f), jit=0.0)


# --------------------------------------------------------------------------
# 6. ПРИПАС: ЯЩИК И КАДКА
# --------------------------------------------------------------------------
CRATE = (-1.02, 0.12)
BARREL = (-1.02, 0.62)


def build_supplies(parts, rng):
    cx, cy = CRATE
    # Ящик: корпус, утопленная крышка, обвязка на передней грани.
    v, f = F.box(cx, cy, BASE_Z, 0.34, 0.30, 0.27,
                 keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    add(parts, 'crate_body', 'plank', (v, f), jit=0.004, seed=3700,
        zjit=False)
    v, f = F.box(cx, cy, BASE_Z + 0.265, 0.36, 0.32, 0.042,
                 keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    add(parts, 'crate_lid', 'beam', (v, f), jit=0.003, seed=3701,
        zjit=False)
    # Кадка: три кольца с пузом, две железные стяжки, светлая крышка.
    bx, by = BARREL
    v, f = lathe(bx, by, [(BASE_Z, 0.100, 0.100), (0.115, 0.132, 0.132),
                          (0.205, 0.145, 0.145), (0.315, 0.104, 0.104)],
                 n=8, phase=math.pi / 8.0)
    add(parts, 'barrel_body', 'beam', (v, f), jit=0.003, seed=3740,
        zjit=False)
    for k, z in enumerate((0.090, 0.235)):
        v, f = lathe(bx, by, [(z, 0.149, 0.149), (z + 0.024, 0.149, 0.149)],
                     n=6, phase=math.pi / 6.0)
        add(parts, 'barrel_hoop_%d' % k, 'iron', (v, f), jit=0.0)
    v, f = lathe(bx, by, [(0.310, 0.098, 0.098), (0.327, 0.094, 0.094)],
                 n=8, phase=math.pi / 8.0)
    add(parts, 'barrel_lid', 'plank', (v, f), jit=0.0)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def prune_unused(parts):
    """Убрать вершины, оставшиеся без граней после автоотсева.

    `autocull` выбрасывает фасеты, но не вершины; в экспорт попадали «висячие»
    вершины (6 штук: 5 у камня у кромки и 1 у камня под знаменем), и приёмка
    C9 честно падала.  После чистки каждая деталь uses only its face vertices.
    """
    out = []
    for p in parts:
        used = sorted({i for f in p['faces'] for i in f})
        if not used:
            continue
        if len(used) != len(p['verts']):
            remap = {old: new for new, old in enumerate(used)}
            p['verts'] = [p['verts'][i] for i in used]
            p['faces'] = [tuple(remap[i] for i in f) for f in p['faces']]
        out.append(p)
    return out


def build(variant=None):
    """Собрать лагерь.  Возвращает список деталей (name/family/verts/faces)."""
    rng = random.Random(22)
    parts = []
    build_ground(parts, rng)
    build_banner(parts, rng)
    build_rack(parts, rng)
    build_woodpile(parts, rng)
    build_fire(parts, rng)
    build_supplies(parts, rng)
    F.ground(parts)
    F.autocull(parts)
    parts = prune_unused(parts)
    # Опечатка в имени зоны иначе доедет до Blender и молча покрасит деталь
    # чужим материалом.  Здесь падаем сразу и говорим, какая деталь виновата.
    for p in parts:
        if p['family'] not in V.ZONES:
            raise KeyError('деталь %r: зоны %r нет в village.ZONES'
                           % (p['name'], p['family']))
    return parts


if __name__ == '__main__':
    p = build()
    print('SPEC footprint=%s site=%s mul=%s cell=%s'
          % (SPEC['footprint'], SPEC['site'], SPEC['mul'], SPEC['cell']))
    print(F.stats(p))
    for k, v in F.census(p).most_common(16):
        print('  %-18s %4d трис' % (k, v))
