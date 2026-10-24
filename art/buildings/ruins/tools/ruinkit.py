"""ruinkit.py — ОБЩИЕ ДЕТАЛИ РУИН: рваная стена, упавшая кровля, обломки, уголь.

Задача заказчика (2026-10-23, п.11): для каждого типа постройки — разрушенный
вариант, чтобы «крыша упала/просела, часть стропил и досок треснула и лежит на
земле; стены частично разрушены (рваная кромка сверху, проломы), но силуэт
узнаваем; обломки разбросаны ТОЛЬКО по пятну постройки; цветом показано
запустение/пожар».

Здесь лежит то, что повторяется у всех пяти типов.  Набор нарочно маленький:
у каждой руины своя геометрия (`ruin_<тип>.py`), а не «одна руина на всех».

ГЛАВНЫЕ ПРИЁМЫ
--------------
1. **Рваная кромка — это НЕСКОЛЬКО ПРИЗМ, а не вырезанная стена.**  Стена
   делится на куски по 0.35..0.5 юнита; у каждого своя высота и свой наклон
   верхней кромки.  Куски перекрываются на 0.004 — иначе боковины соседей
   ложатся в одну плоскость (z-fighting), а `autocull` может снять обе и
   оставить дыру.  Пролом — это пропущенные куски; край пролома всегда
   обуглен (`char`), как и должно быть после пожара.
2. **Всё лежащее лежит.**  У каждой доски, бревна и обломка низ на земле
   (z = 0) или на том, на чём он лежит (бревно, стена).  Панель кровли
   опирается на два края: на остаток стены и на землю/обломок — висящих
   панелей нет, это отдельно считает `xray.py probe` (секция зазоров).
3. **Никаких новых объёмов «на глаз»**: числа берутся из генератора целой
   постройки (`SPEC`, `HX/HY`, `WALL_H`, `Z_RIDGE`), а не подбираются.
4. **Только уголь и пепел новых цветов** (`ruin_palette.py`).  Приглушённость
   даётся не новым серым, а тем, что часть деталей красится `char`/`ash`, а
   солома и доски остаются своими — выгоревшими пятнами, а не целиком.

Оси — как у целых построек: X вправо, Y на камеру (+Y — перед), Z вверх.
"""
import math
import random

import forge as F


# --------------------------------------------------------------------------
# ДОБАВИТЬ ДЕТАЛЬ
# --------------------------------------------------------------------------
def add(parts, name, fam, vf, jit=0.0, seed=0, zjit=False, nocull=False):
    """Добавить деталь; дрожь по умолчанию НЕ трогает Z у наземных деталей."""
    verts, faces = vf
    if jit:
        verts = F.jitter(verts, jit, seed,
                         axis=None if zjit else (1, 1, 0))
    F.part(parts, name, fam, verts, faces, nocull=nocull)


def slab(parts, name, fam, x0, x1, y0, y1, z0, z1, jit=0.0, seed=0,
         nocull=False):
    """Осевой короб по двум углам (частая деталь: доска, брусок, настил)."""
    v, f = F.box((x0 + x1) / 2.0, (y0 + y1) / 2.0, z0,
                 abs(x1 - x0), abs(y1 - y0), abs(z1 - z0))
    add(parts, name, fam, (v, f), jit=jit, seed=seed, nocull=nocull)


def panel(parts, name, fam, quad, t, jit=0.0, seed=0):
    """Плоская плита по четырём точкам (кровля, щит, доска под наклоном).

    `quad` — 4 точки ПРОТИВ ЧАСОВОЙ, если смотреть с наружной стороны; толщина
    `t` откладывается по нормали в обе стороны.  Так задаётся наклонная
    панель, которую `box` не умеет: упавшая кровля лежит не по осям.
    """
    p = [tuple(map(float, q)) for q in quad]
    u = (p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2])
    v = (p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2])
    n = F._norm((u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                 u[0] * v[1] - u[1] * v[0]))
    # Кровля и доски лежат «лицом вверх».  Если четыре точки заданы по
    # часовой, нормаль смотрит в землю — и знаковый объём отрицательный.
    # Разворачиваем обход здесь, а не в каждом вызове: ошибиться в порядке
    # точек легко, а признак «панель смотрит вверх» однозначен.
    if n[2] < 0.0:
        p = p[::-1]
        n = (-n[0], -n[1], -n[2])
    h = t / 2.0
    top = [(q[0] + n[0] * h, q[1] + n[1] * h, q[2] + n[2] * h) for q in p]
    bot = [(q[0] - n[0] * h, q[1] - n[1] * h, q[2] - n[2] * h) for q in p]
    verts = bot + top
    # Тот же обход, что у F.box: низ 0..3, верх 4..7, боковины (i, j, j+4, i+4).
    faces = [(4, 5, 6, 7), (3, 2, 1, 0),
             (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    # nocull: панель — ТОНКАЯ плита, и автоотсев снимает у неё верх или низ,
    # если рядом лежит доска (зазор < cover).  Тогда с нижнего ракурса в
    # панель светит изнанка (замер: 35 836 px у упавшей кровли).
    add(parts, name, fam, (verts, faces), jit=jit, seed=seed, nocull=True)


def beam(parts, name, fam, p0, p1, w, h, jit=0.0, seed=0, caps=(0, 1),
         nocull=False):
    """Брусок между двумя точками (стропило, жердь, обломок).

    `nocull` — для бруса, воткнутого в стену: его торец закрыт стеной, но
    автоотсев снимает грань по лучу, а с косого ракурса в открытый торец
    светит изнанка (замер: стропило 42 px).  Шесть граней дешевле дыры.
    """
    v, f = F.bar(p0, p1, w, h, caps=caps)
    add(parts, name, fam, (v, f), jit=jit, seed=seed, nocull=nocull)


# --------------------------------------------------------------------------
# КАМЕНЬ И ЗЕМЛЯ
# --------------------------------------------------------------------------
def stone(parts, name, fam, cx, cy, z0, r, h, seed, n=5):
    """Валун: два неровных кольца, верхняя и нижняя грани.  Никогда не парит."""
    rng = random.Random(seed)
    bot, top = [], []
    for k in range(n):
        a = 2.0 * math.pi * k / n + rng.uniform(-0.18, 0.18)
        rb = r * rng.uniform(0.82, 1.10)
        bot.append((cx + rb * math.cos(a), cy + rb * math.sin(a), z0))
        rt = rb * rng.uniform(0.55, 0.82)
        top.append((cx + rt * math.cos(a + 0.12), cy + rt * math.sin(a + 0.12),
                    z0 + h * rng.uniform(0.80, 1.10)))
    verts = bot + top
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    add(parts, name, fam, (verts, faces), jit=0.003, seed=seed + 1)


ASH_Z = 0.006


def ash_patch(parts, name, cx, cy, rx, ry, seed, z=ASH_Z):
    """Пятно пепла на земле: плоский неровный многоугольник.

    Толщина 0.006 и верх на z+0.006: пятно лежит НА земле, а не в её
    плоскости, поэтому z-fighting с землёй невозможен.  Контур неровный —
    пожар не рисует кругов.
    """
    rng = random.Random(seed)
    n = 7
    poly = []
    for k in range(n):
        a = 2.0 * math.pi * k / n + rng.uniform(-0.14, 0.14)
        r = rng.uniform(0.72, 1.0)
        poly.append((cx + rx * r * math.cos(a), cy + ry * r * math.sin(a)))
    v, f = F.prism(poly, z, z + 0.006, axis=2)
    add(parts, name, 'ash', (v, f), jit=0.0)


def rubble(parts, name, cx, cy, r, seed, fam='stone'):
    """Кучка мелкого камня: три обломка вокруг точки."""
    rng = random.Random(seed)
    for k in range(3):
        a = rng.uniform(0.0, 2.0 * math.pi)
        d = rng.uniform(0.0, r)
        stone(parts, '%s_%d' % (name, k), fam,
              cx + d * math.cos(a), cy + d * math.sin(a), 0.0,
              rng.uniform(0.035, 0.075), rng.uniform(0.04, 0.09),
              seed * 7 + k, n=5)


# --------------------------------------------------------------------------
# РВАНАЯ СТЕНА
# --------------------------------------------------------------------------
def broken_wall(parts, name, axis, plane, u0, u1, z0, ztop, t, seed,
                holes=(), frac=None, fam='wall', char=(), char_all=False,
                step=0.30, core=0.18):
    """Стена с рваной верхней кромкой и проломами — ОДНОЙ призмой на кусок.

    Почему не «стена из плиток».  Первый прогон собирал стену из кусков по
    0.44: у соседей совпадали боковины (z-fighting), а автоотсев снимал одну
    из пары и с косого ракурса в стену светила изнанка (замер: 273 px на
    wall_left_0).  Здесь стена — цельная призма, у которой верхняя кромка
    задана ЛОМАНОЙ; пролом — это разрыв между призмами, а не пропущенная
    плитка.  Внутренних совпадающих плоскостей у такой стены нет вовсе.

    axis  — 'x': стена вдоль X, толщина по Y, `plane` = центр Y;
            'y': стена вдоль Y, толщина по X, `plane` = центр X.
    holes — список (u_center, width): разрывы до земли (проломы).
    frac  — доли высоты для точек верхней кромки, по кругу; из них строится
            ломаная, поэтому кромка рваная, но силуэт не «пила».
    char  — индексы КУСКОВ (между проломами), крашенных углём.
    """
    rng = random.Random(seed)
    if frac is None:
        frac = (1.0, 0.62, 0.86, 0.38, 0.74, 0.52, 0.92, 0.44)
    # Разрывы -> сплошные куски.
    cuts = sorted((max(u0, hc - hw / 2.0), min(u1, hc + hw / 2.0))
                  for hc, hw in holes)
    segs, cur = [], u0
    for a, b in cuts:
        if a - cur > 0.06:
            segs.append((cur, a))
        cur = max(cur, b)
    if u1 - cur > 0.06:
        segs.append((cur, u1))
    if not segs and holes:
        segs = [(u0, u1)]

    for si, (a, b) in enumerate(segs):
        n = max(3, int(round(abs(b - a) / step)))
        us = [a + (b - a) * i / n for i in range(n + 1)]
        hs = []
        for i in range(n + 1):
            f = frac[(si * 3 + i) % len(frac)]
            h = ztop * max(0.22, f) + rng.uniform(-0.035, 0.035)
            # глубокие зазубрины на внутренних точках (не на краях пролома)
            if 0 < i < n and (i + si) % 5 == 3:
                h = z0 + core * rng.uniform(0.5, 1.2)
            hs.append(max(z0 + 0.10, min(ztop + 0.05, h)))
        poly = [(us[0], z0), (us[-1], z0)]
        poly += [(us[i], hs[i]) for i in range(n, -1, -1)]
        tt = t + rng.uniform(-0.006, 0.006)
        zfam = 'char' if (char_all or si in char) else fam
        if axis == 'x':
            v, f = F.prism(poly, plane - tt / 2.0, plane + tt / 2.0, axis=1)
        else:
            v, f = F.prism(poly, plane - tt / 2.0, plane + tt / 2.0, axis=0)
        # nocull: стена — ЗАМКНУТАЯ призма; автоотсев снимает её низ (он на
        # цоколе) и иногда наружную грань у пролома, и тогда с косого ракурса
        # в стену светит изнанка (замер: 77 px).  Пара лишних фасетов дешевле.
        add(parts, '%s_%d' % (name, si), zfam, (v, f), jit=0.002,
            seed=seed * 13 + si, nocull=True)


def char_top(parts, name, axis, plane, u0, u1, z, t, seed):
    """Чёрная обугленная полоса по верху уцелевшей кромки (2..3 куска)."""
    rng = random.Random(seed)
    n = max(2, int(round(abs(u1 - u0) / 0.5)))
    for i in range(n):
        a = u0 + (u1 - u0) * i / n
        b = u0 + (u1 - u0) * (i + 1) / n
        zz = z + rng.uniform(-0.018, 0.018)
        if axis == 'x':
            poly = [(a, zz), (b, zz), (b, zz + 0.035), (a, zz + 0.035)]
            v, f = F.prism(poly, plane - t / 2.0, plane + t / 2.0, axis=1)
        else:
            poly = [(a, zz), (b, zz), (b, zz + 0.035), (a, zz + 0.035)]
            v, f = F.prism(poly, plane - t / 2.0, plane + t / 2.0, axis=0)
        add(parts, '%s_%d' % (name, i), 'char', (v, f), jit=0.002,
            seed=seed + i)


def broken_post(parts, name, x, y, z0, h, t, seed, fam='timber',
                lean=(0.0, 0.0), char=False):
    """Столб с «отломанным» верхом: наклонный брусок, торец не по оси.

    Верх срезан наклонно (бар заканчивается не горизонтально), а на самом
    верху лежит угольная нашлёпка — так столб читается сломанным, а не
    спиленным.
    """
    h = max(0.16, h)
    p0 = (x, y, z0)
    p1 = (x + lean[0], y + lean[1], z0 + h)
    beam(parts, name, 'char' if char else fam, p0, p1, t, t, seed=seed)
    # угольная кромка на срезе — плоский огрызок, утопленный в столб
    slab(parts, name + '_burn', 'char',
         x + lean[0] - t * 0.34, x + lean[0] + t * 0.34,
         y + lean[1] - t * 0.34, y + lean[1] + t * 0.34,
         z0 + h - 0.02, z0 + h + 0.012, nocull=True)


# --------------------------------------------------------------------------
# УПАВШАЯ КРОВЛЯ
# --------------------------------------------------------------------------
def fallen_beam(parts, name, p0, p1, w, seed, fam='beam', h=None, z0=0.0,
                nocull=False):
    """Бревно/брус, лежащее на полу: низ на z0 (0 — земля, у дома — цоколь)."""
    h = w if h is None else h
    beam(parts, name, fam,
         (p0[0], p0[1], z0 + h / 2.0), (p1[0], p1[1], z0 + h / 2.0), w, h,
         seed=seed, nocull=nocull)


def fallen_plank(parts, name, cx, cy, ln, w, ang, seed, fam='plank',
                 z=0.0, thick=0.035, tilt=0.0):
    """Доска на земле под углом `ang` в плане; `tilt` — приподнятый конец."""
    c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    dx, dy = c * ln / 2.0, s * ln / 2.0
    p0 = (cx - dx, cy - dy, z + thick / 2.0 + math.sin(math.radians(tilt)) * ln / 2.0)
    p1 = (cx + dx, cy + dy, z + thick / 2.0 - math.sin(math.radians(tilt)) * ln / 2.0)
    beam(parts, name, fam, p0, p1, w, thick, seed=seed)


def roof_panel(parts, name, quad, t, fam='thatch', jit=0.003, seed=0):
    """Кусок кровли (солома/тёс) по четырём точкам."""
    panel(parts, name, fam, quad, t, jit=jit, seed=seed)


def shingle(parts, name, cx, cy, w, ln, ang, seed, fam='thatch2', z=0.008,
            thick=0.018, tilt=0.0):
    """Щепка/пласт соломы на земле (мелкий обломок кровли)."""
    c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    dx, dy = c * w / 2.0, s * w / 2.0
    ex, ey = -s * ln / 2.0, c * ln / 2.0
    quad = [(cx - dx - ex, cy - dy - ey, z + thick / 2.0),
            (cx + dx - ex, cy + dy - ey, z + thick / 2.0 + tilt),
            (cx + dx + ex, cy + dy + ey, z + thick / 2.0),
            (cx - dx + ex, cy - dy + ey, z + thick / 2.0 - tilt)]
    panel(parts, name, fam, quad, thick, jit=0.002, seed=seed)


def char_pile(parts, name, cx, cy, r, seed, n=4, z0=0.0):
    """Кучка углей: короткие чёрные обломки крест-накрест, все на полу."""
    rng = random.Random(seed)
    for k in range(n):
        a = rng.uniform(0, 360)
        ln = rng.uniform(r * 0.8, r * 1.6)
        ox = rng.uniform(-r * 0.35, r * 0.35)
        oy = rng.uniform(-r * 0.35, r * 0.35)
        c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
        # Ось обломка — на высоте полусечения: иначе нижний угол уходит под
        # землю, `F.ground` поднимает ВСЮ модель, и опорные камни перестают
        # быть контактом (ground уезжает).
        w = rng.uniform(0.035, 0.06)
        p0 = (cx + ox - c * ln / 2.0, cy + oy - s * ln / 2.0,
              z0 + w / 2.0 + rng.uniform(0.0, 0.02))
        p1 = (cx + ox + c * ln / 2.0, cy + oy + s * ln / 2.0, z0 + w / 2.0)
        beam(parts, '%s_%d' % (name, k), 'char', p0, p1, w, w,
             seed=seed + k)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def compact(parts):
    """Убрать вершины без граней и детали без граней (после autocull).

    Без этого `gate.py` видит «висячие вершины» (C9) и «деталь живёт отдельным
    телом» (C12) — ровно то, на чём в 2026-10-14 провалился дом жителя.
    """
    out = []
    for p in parts:
        if not p['faces']:
            continue
        used = sorted({i for f in p['faces'] for i in f})
        if len(used) < 3:
            continue
        if len(used) != len(p['verts']):
            remap = {old: new for new, old in enumerate(used)}
            p['verts'] = [p['verts'][i] for i in used]
            p['faces'] = [tuple(remap[i] for i in f) for f in p['faces']]
        out.append(p)
    parts[:] = out
    return parts


def finish(parts, cover=0.025):
    """Общий конец сборки: опора на землю, отсев, чистка, проверка зон."""
    import ruin_palette as V
    F.ground(parts)
    F.autocull(parts, cover=cover)
    compact(parts)
    for p in parts:
        if p['family'] not in V.ZONES:
            raise KeyError('деталь %r: зоны %r нет в ruin_palette.ZONES'
                           % (p['name'], p['family']))
    return parts


def footprint_parts(parts):
    xs = [v[0] for p in parts for v in p['verts']]
    ys = [v[1] for p in parts for v in p['verts']]
    zs = [v[2] for p in parts for v in p['verts']]
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))


def contact(parts, tol=0.025):
    """Габарит точек контакта с землёй — то, из чего считается `ground`.

    Конвенция та же, что у упаковщиков соседей: X = -x, Y = y, поворот вокруг
    Z применяется до перевода в карту.
    """
    xs, ys = [], []
    for p in parts:
        lo = min(v[2] for v in p['verts'])
        if lo > tol:
            continue
        for v in p['verts']:
            if v[2] > lo + 0.05:
                continue
            xs.append(-v[0])
            ys.append(v[1])
    return [round(min(xs), 3), round(max(xs), 3), round(min(ys), 3),
            round(max(ys), 3)]
