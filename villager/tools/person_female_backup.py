"""person.py — анатомия жительницы: чистый Python, без Blender.

Это ФОРМА, а не картинка: ни bpy, ни numpy — только числа, кольца и лофты.
Поэтому форму можно измерить (metrics.py), просветить на изнанки со всех
ракурсов (xray.py) и повторить до последнего пикселя.

Конвенции канона (4tox-lowpoly-3d, references/style-canon.md):
    1 юнит = 1 клетка карты; Z вверх; модель СМОТРИТ В +X (js/hero.js: повороты
    0/90/180/270 вокруг Z дают +X/+Y/-X/-Y); опора — земля между ступнями, то
    есть (0,0,0); низ фигуры на z = 0.

МАСШТАБ. Рост 1.00 юнита. Это не произвол: у героя-лесоруба силуэт 88 px при
96 ppu, но вертикальная ось проекта сжата косинусом подъёма (UP.z = 0.8165),
поэтому 1 юнит = 78.4 px — значит герой ровно ~1.0 юнита, как и записано в
каноне домов («человек 1.0, дверь 0.72 — по плечо»). Первая версия фигуры была
0.82 и рядом с дверью выглядела подростком.

ПРОПОРЦИИ. 5 голов (голова с платком — 20% роста), плечи на 0.745, кисть на
уровне 0.38 роста. Герой — чиби на 3.3 головы; жительница чуть стройнее него,
но того же языка: крупная голова, широкие плечи, толстые сапоги. Рядом с
деревьями и дверьми они должны читаться одной породой.

Почему скелет, а не «поза деталей». Кость — это матрица, геометрия кости
строится в её локальных координатах вдоль +Z. Тогда idle/walk/work — ОДНА
модель в разных позах (poses.py), а не три модели: топология не меняется, и
кадры анимации не могут разъехаться по форме.

Почему левая сторона и зеркало. Кость правой стороны строится по тем же
формулам с +Y, а потом геометрия зеркалится через G.mirror_y (он же
реверсирует обход). Так исключены две классические ошибки: «правая нога
уехала влево» и «правая рука вывернута наизнанку».
"""
import math

import geom3d as G

# ==========================================================================
# SPEC — пропорции. Единственное место, где числа фигуры.
# ==========================================================================
SPEC = dict(
    H=1.000,
    Z_ANKLE=0.095,
    Z_KNEE=0.300,
    Z_HIP=0.530,
    Z_WAIST=0.618,
    Z_CHEST=0.730,
    Z_SHLD=0.745,
    Z_NECK=0.775,
    Z_CHIN=0.800,
    Z_BROW=0.880,
    Z_TOP=0.955,
    Z_KERCH=1.000,
    HIP_X=0.034,
    SHLD_X=0.078,
    THIGH_L=0.230,
    SHIN_L=0.205,
    UPARM_L=0.155,
    FORE_L=0.140,
    HAND_L=0.062,
    HEM=0.330,
    N_DRESS=6,      # 6 граней платья: фасет шире — метрика детализации гейта
    N_LIMB=5,       # 5 граней руки/ноги: на 4 px ширины 6-гранник уже «мыло»
    N_HEAD=8,
    Z_NOSE=0.866,
    NOSE_OUT=0.041,  # длина носа; ВИДИМЫЙ выступ ~0.020 = 2 px при 96 ppu
)
# Профиль платья снизу вверх: (z, rx, ry). Общий для платья, фартука и пояса,
# чтобы фартук не «отклеивался» от платья ни на одном ярусе.
# Секций ровно столько, чтобы фасеты подола были КРУПНЫМИ: метрика детализации
# гейта требует >=30% площади в пятнах от 3%, а на дробном профиле кадр
# work_0_90 в 4x давал ровно 30% и падал (одна секция лишняя — и фасет мельче).
DRESS_PROF = ((0.330, 0.132, 0.103), (0.365, 0.124, 0.098), (0.505, 0.096, 0.077),
              (0.618, 0.082, 0.064), (0.675, 0.090, 0.069), (0.730, 0.100, 0.074),
              (0.745, 0.101, 0.072), (0.775, 0.046, 0.044))

# Поза покоя: руки чуть в стороны и вперёд, локти мягко согнуты. Ноль по всем
# углам дал бы «солдатика» — фигуры, которой в игре не бывает.
POSE_REST = dict(
    bob=0.0, lean=0.0, side=0.0, twist=0.0, chest=0.0,
    head_pitch=0.0, head_turn=0.0, head_tilt=0.0,
    hip_l=0.0, knee_l=0.0, ankle_l=0.0, out_l=1.5,
    hip_r=0.0, knee_r=0.0, ankle_r=0.0, out_r=1.5,
    sh_l=5.0, armout_l=10.5, el_l=14.0, foreout_l=-4.0, hand_l=0.0,
    sh_r=5.0, armout_r=10.5, el_r=14.0, foreout_r=-4.0, hand_r=0.0,
    skirt_dx=0.0, skirt_dy=0.0,
)


def pose_of(**kw):
    p = dict(SPEC)
    p.update(POSE_REST)
    p.update(kw)
    return p


# ==========================================================================
# СКЕЛЕТ
# ==========================================================================
# B — базовая развёртка кости: локальный +Z смотрит ВНИЗ (в землю), +X остаётся
# «вперёд». Одна и та же геометрия «вдоль +Z» годится и руке, и ноге.
B = G.mat_rot_x(180.0)


def _swing(pitch):
    """Качание кости вперёд: положительный угол — конец идёт в +X."""
    return G.mat_rot_y(-pitch)


def _out(deg):
    """Отведение в сторону: положительный угол — в +Y (левая сторона)."""
    return G.mat_rot_x(deg)


def skeleton(p):
    M = {}
    M['pelvis'] = G.mat_chain(G.mat_translate((0.0, 0.0, p['Z_HIP'] + p['bob'])),
                              G.mat_rot_z(p['twist']),
                              G.mat_rot_y(p['lean']),
                              G.mat_rot_x(p['side']))
    M['chest'] = G.mat_chain(M['pelvis'],
                             G.mat_translate((0.0, 0.0, p['Z_CHEST'] - p['Z_HIP'])),
                             G.mat_rot_y(p['chest']))
    for s in ('l', 'r'):
        A = G.mat_chain(M['pelvis'],
                        G.mat_translate((0.0, p['HIP_X'], 0.0)),
                        _out(p['out_' + s]),
                        _swing(p['hip_' + s]))
        M['thigh_' + s] = G.mat_mul(A, B)
        K = G.mat_chain(A, G.mat_translate((0.0, 0.0, -p['THIGH_L'])),
                        G.mat_rot_y(p['knee_' + s]))        # колено гнётся назад
        M['shin_' + s] = G.mat_mul(K, B)
        M['foot_' + s] = G.mat_chain(K, G.mat_translate((0.0, 0.0, -p['SHIN_L'])),
                                     G.mat_rot_y(p['ankle_' + s]))
    for s in ('l', 'r'):
        A = G.mat_chain(M['chest'],
                        G.mat_translate((0.0, p['SHLD_X'], p['Z_SHLD'] - p['Z_CHEST'])),
                        _out(p['armout_' + s]),
                        _swing(p['sh_' + s]))
        M['uparm_' + s] = G.mat_mul(A, B)
        E = G.mat_chain(A, G.mat_translate((0.0, 0.0, -p['UPARM_L'])),
                        _out(p['foreout_' + s]),
                        _swing(p['el_' + s]))               # локоть гнётся вперёд
        M['fore_' + s] = G.mat_mul(E, B)
        M['hand_' + s] = G.mat_chain(E, G.mat_translate((0.0, 0.0, -p['FORE_L'])),
                                     _swing(p['hand_' + s]), B)
    M['neck'] = G.mat_chain(M['chest'],
                            G.mat_translate((0.0, 0.0, p['Z_NECK'] - p['Z_CHEST'])))
    M['head'] = G.mat_chain(M['neck'],
                            G.mat_translate((0.0, 0.0, p['Z_CHIN'] - p['Z_NECK'])),
                            G.mat_rot_y(-p['head_pitch']),
                            G.mat_rot_z(p['head_turn']),
                            G.mat_rot_x(p['head_tilt']))
    return M


# ==========================================================================
# ПЛАТЬЕ, ФАРТУК, ПОЯС
# ==========================================================================
def dress_radius(z):
    """Полуоси платья на высоте z — по ним садятся фартук и пояс."""
    if z <= DRESS_PROF[0][0]:
        return DRESS_PROF[0][1], DRESS_PROF[0][2]
    for i in range(len(DRESS_PROF) - 1):
        z0, rx0, ry0 = DRESS_PROF[i]
        z1, rx1, ry1 = DRESS_PROF[i + 1]
        if z0 <= z <= z1:
            t = (z - z0) / (z1 - z0)
            return rx0 + (rx1 - rx0) * t, ry0 + (ry1 - ry0) * t
    return DRESS_PROF[-1][1], DRESS_PROF[-1][2]


def build_dress(p, M):
    """Платье одним лофтом: подол -> талия -> грудь -> плечи -> ворот.

    Подол неровный (0.005 юнита: ручная работа, а не станочная деталь), а ниже
    талии сечение уезжает за позой (skirt_dx/dy) — так подол отстаёт на шаге и
    колено его не пробивает.
    """
    n, zc = p['N_DRESS'], p['Z_HIP']

    def sway(z):
        t = max(0.0, (p['Z_WAIST'] - z) / (p['Z_WAIST'] - p['HEM']))
        return p['skirt_dx'] * t, p['skirt_dy'] * t

    secs = []
    for k, (z, rx, ry) in enumerate(DRESS_PROF):
        dx, dy = sway(z)
        if k == 0:
            secs.append(G.ring(n, 0.0, rx, ry, cx=dx, cy=dy,
                               zs=lambda i: p['HEM'] + 0.005 * math.cos(
                                   2.0 * math.pi * i / n + 0.7) - zc))
        else:
            secs.append(G.ring(n, z - zc, rx, ry, cx=dx, cy=dy))
    return [G.xform(G.loft(secs, name='dress', family='stone'), M['pelvis'])]


def build_apron(p, M):
    """Фартук: полоса-оболочка по переду платья, 4 фасета в ряд.

    Плоская пластина в изометрии читалась бы волосинкой, поэтому фартук —
    ПОВЕРХНОСТЬ платья: дуга 150 градусов, на 0.008 наружу.
    """
    cols, rows = 4, 3
    z0, z1 = 0.420, 0.648
    a0, a1 = -math.radians(75.0), math.radians(75.0)
    rows_in, rows_out = [], []
    for k in range(rows):
        t = k / (rows - 1.0)
        z = z0 + (z1 - z0) * t
        rx, ry = dress_radius(z)
        sw = max(0.0, (p['Z_WAIST'] - z) / (p['Z_WAIST'] - p['HEM']))
        dx, dy = p['skirt_dx'] * sw, p['skirt_dy'] * sw
        ri, ro = [], []
        for i in range(cols):
            a = a0 + (a1 - a0) * i / (cols - 1.0)
            ca, sa = math.cos(a), math.sin(a)
            ri.append((dx + rx * ca * 0.92, dy + ry * sa * 0.92, z - p['Z_HIP']))
            ro.append((dx + (rx + 0.008) * ca, dy + (ry + 0.008) * sa, z - p['Z_HIP']))
        rows_in.append(ri)
        rows_out.append(ro)
    return [G.xform(G.strip_shell('apron', 'leaf_autumn', rows_in, rows_out),
                    M['pelvis'])]


def build_belt(p, M):
    """Пояс: замкнутое кольцо поверх платья + пряжка.

    Кольцо замкнутое (с крышками): у открытой полосы с кромки видна изнанка, а
    это первое, что ловит xray и что вылезает чёрной полосой в спрайте.
    """
    z0, z1 = p['Z_WAIST'] - 0.008, p['Z_WAIST'] + 0.020
    r0x, r0y = dress_radius(z0)
    r1x, r1y = dress_radius(z1)
    secs = [G.ring(6, z0 - p['Z_HIP'], r0x + 0.005, r0y + 0.005),
            G.ring(6, z1 - p['Z_HIP'], r1x + 0.005, r1y + 0.005)]
    belt = G.loft(secs, name='belt', family='leather')
    return [G.xform(belt, M['pelvis'])]


# ==========================================================================
# НОГИ И ОБУВЬ
# ==========================================================================
def build_leg(p, M, s):
    n, ph = p['N_LIMB'], math.pi / p['N_LIMB']
    thigh = G.tube(p['THIGH_L'], [(0.0, 0.046, 0.048), (1.0, 0.031, 0.033)],
                   n=n, phase=ph, name='thigh_' + s, family='skin')
    shin = G.tube(p['SHIN_L'], [(-0.028, 0.036, 0.039), (0.55, 0.029, 0.031),
                                (1.0, 0.020, 0.023)],
                  n=n, phase=ph, name='shin_' + s, family='skin')
    # НИКАКИХ доп. смещений: M['shin_*'] уже стоит НА КОЛЕНЕ (грабли: двойное
    # смещение подняло голень на 0.187 юнита и ботинок оказался в воздухе).
    return [G.xform(thigh, M['thigh_' + s]), G.xform(shin, M['shin_' + s])]


def build_boot(p, M, s):
    """Сапог: 5-гранная колодка, носок выдвинут вперёд.

    Носок — это 2..4 px по X; именно они читаются как «ступня», а не «обрубок».
    Строится от подошвы вверх (обход колец снизу вверх — нормали наружу).
    """
    n, ph, za = p['N_LIMB'], math.pi / p['N_LIMB'], p['Z_ANKLE']
    secs = [G.ring(n, -za, 0.029, 0.034, cx=0.021, phase=ph),
            G.ring(n, 0.050 - za, 0.033, 0.035, cx=0.012, phase=ph),
            G.ring(n, 0.090 - za, 0.031, 0.031, cx=0.001, phase=ph)]
    return [G.xform(G.loft(secs, name='boot_' + s, family='leather'), M['foot_' + s])]


# ==========================================================================
# РУКИ
# ==========================================================================
def build_arm(p, M, s):
    """Рука: плечо, предплечье+кисть, рукав, большой палец.

    Локоть и запястье НЕ разрезаны на отдельные детали: на 4 px ширины стык
    читается зазором, а не суставом. Кисть — продолжение предплечья, поэтому
    третий лофт кончается сплющенным сечением «ладонь».
    """
    n, ph = p['N_LIMB'], math.pi / p['N_LIMB']
    up = G.tube(p['UPARM_L'], [(0.0, 0.030, 0.031), (1.0, 0.025, 0.026)],
                n=n, phase=ph, name='uparm_' + s, family='skin')
    L = p['FORE_L'] + p['HAND_L']
    fore = G.tube(L, [(-0.030, 0.025, 0.027),
                      (p['FORE_L'] / L, 0.019, 0.020), (1.0, 0.018, 0.015)],
                  n=n, phase=ph, name='forearm_' + s, family='skin')
    sleeve = G.frustum('sleeve_' + s, 'stone', -0.015, 0.086, 0.037, 0.031,
                       n=n, phase=ph)
    thumb = G.frustum('thumb_' + s, 'skin', 0.0, 0.032, 0.014, 0.008, n=4,
                      cx=0.014, cy=0.014)
    thumb = G.xform(thumb, G.mat_chain(
        G.mat_translate((0.0, 0.0, p['FORE_L'] + 0.010)), G.mat_rot_y(-35.0)))
    return [G.xform(up, M['uparm_' + s]), G.xform(fore, M['fore_' + s]),
            G.xform(sleeve, M['uparm_' + s]), G.xform(thumb, M['fore_' + s])]


# ==========================================================================
# ГОЛОВА, ШЕЯ, ПЛАТОК
# ==========================================================================
def _egg(n):
    """Сечение головы яйцом: спереди уже, на затылке шире."""
    def w(i):
        k = 1.0 - 0.09 * math.cos(2.0 * math.pi * i / n)
        return (k, k)
    return w


def build_neck(p, M):
    """Шея строится в системе груди, поэтому наклон корпуса её не отрывает."""
    z0 = p['Z_SHLD'] - 0.020
    secs = [(0.0, 0.034, 0.035), (1.0, 0.027, 0.029)]
    t = G.tube(p['Z_CHIN'] + 0.026 - z0, secs, n=p['N_LIMB'],
               phase=math.pi / p['N_LIMB'], name='neck', family='skin')
    return [G.xform(t, G.mat_chain(M['chest'],
                                   G.mat_translate((0.0, 0.0, z0 - p['Z_CHEST']))))]


# Профиль черепа: по нему считается и голова, и внутренний край платка.
HEAD_PROF = ((0.800, 0.033, 0.036), (0.826, 0.058, 0.064), (0.880, 0.070, 0.077),
             (0.955, 0.038, 0.042))


def head_radius(z):
    """Полуоси черепа на высоте z (линейно между сечениями)."""
    if z <= HEAD_PROF[0][0]:
        return HEAD_PROF[0][1], HEAD_PROF[0][2]
    for i in range(len(HEAD_PROF) - 1):
        z0, rx0, ry0 = HEAD_PROF[i]
        z1, rx1, ry1 = HEAD_PROF[i + 1]
        if z0 <= z <= z1:
            t = (z - z0) / (z1 - z0)
            return rx0 + (rx1 - rx0) * t, ry0 + (ry1 - ry0) * t
    return HEAD_PROF[-1][1], HEAD_PROF[-1][2]


def build_head(p, M):
    """Голова: четыре сечения. Темя под платком нужно не «на будущее»: без него
    срез головы встаёт почти в одну плоскость со складкой платка, и лоб
    покрывается дерущимися пикселями (проверено xray)."""
    n, w, zc = p['N_HEAD'], _egg(p['N_HEAD']), p['Z_CHIN']
    secs = [G.ring(n, 0.0, 0.033, 0.036),
            G.ring(n, 0.026, 0.058, 0.064, cy=0.002, warp=w),
            G.ring(n, p['Z_BROW'] - zc, 0.070, 0.077, cy=0.003, warp=w),
            G.ring(n, p['Z_TOP'] - zc, 0.038, 0.042, cy=0.004, warp=w)]
    head = G.xform(G.loft(secs, name='head', family='skin'), M['head'])
    # Нос торчит в +X (лицо смотрит в +X!), а не в +Y: оси перепутать здесь —
    # значит получить «нос в щеке», который видно только в профиль.
    # Основание УТОПЛЕНО на 0.018 внутрь: если поставить его на саму щёку, его
    # задняя грань ложится почти в плоскость грани черепа и всё лицо
    # покрывается дерущимися пикселями (ловится xray и глазами).
    zn = p['Z_NOSE'] - zc
    x0 = 0.034                                   # основание утоплено в лицо
    x1 = x0 + p['NOSE_OUT']
    nose = G.part('nose', 'skin',
                  [(x0, -0.010, zn - 0.020), (x0, 0.010, zn - 0.020),
                   (x0, 0.010, zn + 0.022), (x0, -0.010, zn + 0.022),
                   (x1, -0.006, zn - 0.006), (x1, 0.006, zn - 0.006)],
                  [(3, 2, 1, 0), (0, 1, 5, 4), (1, 2, 5), (2, 3, 5), (3, 0, 4, 5)])
    return [head, G.xform(nose, M['head'])]


def build_kerchief(p, M):
    """Платок: купол по черепу, узел и две косынки.

    Низ платка идёт по РАЗНОЙ высоте: спереди выше брови (лицо открыто), по
    бокам до уха, сзади на затылок. Купол ПОВТОРЯЕТ череп (радиус +0.006), а не
    сидит коробкой: первая версия была 8-гранной призмой выше головы, и голова
    читалась ведром.
    """
    n, w, zc = p['N_HEAD'], _egg(p['N_HEAD']), p['Z_CHIN']

    def z_low(i):
        # МИРОВАЯ высота: ring_at сам переводит её в систему головы.
        front = math.cos(2.0 * math.pi * i / n)          # +1 спереди, -1 сзади
        return 0.884 + 0.054 * front

    def z_mid(i):
        return 0.940 + 0.012 * math.cos(2.0 * math.pi * i / n)

    def w_low(i):
        # Передние грани нижнего кольца выпуклее на 16%: козырёк платка над
        # бровью. Стоит НОЛЬ треугольников (это тот же лофт) и даёт 1.2 px
        # кромки — то, что отличает «повязанный платок» от «среза цилиндра».
        kx, ky = w(i)
        k = 1.0 + 0.16 * max(0.0, math.cos(2.0 * math.pi * i / n))
        return (kx * k, ky * k)

    def ring_at(rad_fn, z_fn):
        """Кольцо с ПОТОЧЕЧНЫМ радиусом и высотой: так подворачивается край."""
        pts = []
        for i in range(n):
            a = 2.0 * math.pi * i / n
            rx, ry = rad_fn(i)
            pts.append((rx * math.cos(a), 0.003 + ry * math.sin(a), z_fn(i) - zc))
        return pts

    def inner_rad(i):
        # Внутренний край ЗАВЁРНУТ В ГОЛОВУ на 14%: на 7% он проходил в 1.7 px
        # от черепа и на косых ракурсах (не игровых) давал «мусор» из дерущихся
        # пикселей. На игровом подъёме 35.26° это скрыто, но модель обязана
        # читаться и сбоку.
        rx, ry = head_radius(z_low(i))
        kx, ky = w(i)
        return (rx * 0.86 * kx, ry * 0.86 * ky)

    def outer_rad(i):
        kx, ky = w_low(i)
        return (0.074 * kx, 0.081 * ky)

    def mid_rad(i):
        kx, ky = w(i)
        return (0.072 * kx, 0.079 * ky)

    def top_rad(i):
        kx, ky = w(i)
        return (0.030 * kx, 0.034 * ky)

    secs = [ring_at(inner_rad, z_low),
            ring_at(outer_rad, z_low),
            ring_at(mid_rad, z_mid),
            ring_at(top_rad, lambda i: p['Z_KERCH'])]
    # Нижней крышки НЕТ: она утоплена в голову, там её закрывает череп.
    ker = G.xform(G.loft(secs, caps=(False, True), name='kerchief',
                         family='leaf_autumn'), M['head'])
    # Узел справа-сзади: в повороте 0 он уходит за голову, в 90/270 выходит на
    # профиль — так платок читается во всех четырёх ракурсах.
    knot = G.box('kerchief_knot', 'leaf_autumn', (-0.030, -0.088, 0.846 - zc),
                 (0.018, -0.048, 0.892 - zc))
    tails = []
    for i, (dy, dz, sx) in enumerate(((0.006, 0.000, 0.019), (0.024, -0.018, 0.016))):
        # Косынки СВЕШИВАЮТСЯ: разворот на 180 вокруг X переводит локальный +Z
        # вниз (обход при этом сохраняется — это поворот, а не отражение).
        t = G.frustum('kerchief_tail_%d' % i, 'leaf_autumn', 0.0, 0.068, sx, 0.005,
                      n=4, cx=-0.004, cy=-0.052 + dy)
        t = G.xform(t, G.mat_chain(G.mat_translate((0.0, 0.0, 0.850 - zc + dz)),
                                   G.mat_rot_x(180.0), G.mat_rot_y(-14.0)))
        tails.append(t)
    return [ker] + [G.xform(t, M['head']) for t in tails] + [G.xform(knot, M['head'])]


# ==========================================================================
# КОРЗИНА
# ==========================================================================
def build_basket(p, M):
    """Корзина висит на левой кисти: строится в системе кисти, поэтому на шаге
    и в работе она едет за рукой, а не остаётся в воздухе."""
    body = G.frustum('basket', 'trunk', 0.020, 0.092, 0.036, 0.050, n=6,
                     cx=0.018, cy=-0.026)
    rim = G.frustum('basket_rim', 'leaf_autumn', 0.086, 0.102, 0.053, 0.053, n=6,
                    cx=0.018, cy=-0.026)
    han = [G.box('basket_handle', 'trunk', (0.008, -0.031, 0.096),
                 (0.028, -0.021, 0.128))]
    return [G.xform(x, M['hand_l']) for x in ([body, rim] + han)]


# ==========================================================================
# СБОРКА
# ==========================================================================
def build(variant='a', pose=None, basket=True):
    p = pose_of(**(pose or {}))
    M = skeleton(p)
    parts = []
    parts += build_dress(p, M)
    parts += build_apron(p, M)
    parts += build_belt(p, M)
    for s in ('l', 'r'):
        leg = build_leg(p, M, s) + build_boot(p, M, s) + build_arm(p, M, s)
        parts += leg if s == 'l' else [G.mirror_y(x) for x in leg]
    parts += build_neck(p, M)
    parts += build_head(p, M)
    parts += build_kerchief(p, M)
    if basket:
        parts += build_basket(p, M)
    return ground_lock(parts)


def ground_lock(parts, target=0.0):
    """Опустить фигуру так, чтобы ПОДОШВЫ коснулись z = target.

    Опора обязана быть в (0,0,0): кадр, тень и логика игры считают, что ноги
    стоят на земле. Считается по САПОГАМ, а не по самой низкой точке фигуры:
    в глубоком наклоне ниже всех оказывается кисть, и привязка «по минимуму»
    ставила на землю руку, поднимая ступни — фигура висела над собственной
    тенью (16 кадров анимации работы падали на этом в стиль-гейте).
    """
    boots = [p for p in parts if p['name'].startswith('boot')]
    src = boots or parts
    zmin = min(v[2] for part in src for v in part['verts'])
    if abs(zmin - target) < 1e-9:
        return parts
    dz = target - zmin
    return [G.moved(part, (0.0, 0.0, dz)) for part in parts]
