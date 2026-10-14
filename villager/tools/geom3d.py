"""geom3d.py — примитивы низкополигональной ФИГУРЫ. Чистый Python, без Blender.

Деталь — dict(name, family, verts, faces):
    name    — имя для отчётов xray («нет изнанок у детали ...»);
    family  — семейство палитры атласа (skin / trunk / stone / salt / leather /
              leaf_autumn / iron): тон фасета выбирается ПО НОРМАЛИ в build.py;
    verts   — [(x, y, z), ...] в юнитах (1 юнит = 1 клетка карты, Z вверх,
              модель смотрит в +X, опора в (0,0,0));
    faces   — [(i, j, k[, l]), ...] с обходом НАРУЖУ.

Почему обход важен именно здесь. У постройки лишний фасет видно сразу, а у
человека мельче 2 px его не видно вообще — зато изнанка вылезает чёрной полосой
на кромке руки. Поэтому все лофты строятся так, чтобы нормали выходили наружу
БЕЗ пересчёта: кольца против часовой стрелки (вид сверху), сечения снизу вверх,
торцевая крышка — кольцо как есть, нижняя — в обратном порядке. Проверяется
тестом xray (видимые изнанки) и metrics (знаковый объём замкнутых деталей).
"""
import math

# --------------------------------------------------------------------------
# ВЕКТОРА
# --------------------------------------------------------------------------


def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def v_len(a):
    return math.sqrt(v_dot(a, a))


def v_norm(a):
    d = v_len(a) or 1.0
    return (a[0] / d, a[1] / d, a[2] / d)


def v_lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


# --------------------------------------------------------------------------
# МАТРИЦЫ 4x4 (строками) — жёсткие преобразования, det = +1
# --------------------------------------------------------------------------


def mat_identity():
    return ((1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0))


def mat_mul(A, B):
    return tuple(tuple(sum(A[i][k] * B[k][j] for k in range(4))
                       for j in range(4)) for i in range(4))


def mat_chain(*mats):
    out = mat_identity()
    for m in mats:
        out = mat_mul(out, m)
    return out


def mat_translate(t):
    return ((1.0, 0.0, 0.0, t[0]), (0.0, 1.0, 0.0, t[1]),
            (0.0, 0.0, 1.0, t[2]), (0.0, 0.0, 0.0, 1.0))


def mat_scale(s):
    if not isinstance(s, (tuple, list)):
        s = (s, s, s)
    return ((s[0], 0.0, 0.0, 0.0), (0.0, s[1], 0.0, 0.0),
            (0.0, 0.0, s[2], 0.0), (0.0, 0.0, 0.0, 1.0))


def mat_rot_x(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return ((1.0, 0.0, 0.0, 0.0), (0.0, c, -s, 0.0), (0.0, s, c, 0.0),
            (0.0, 0.0, 0.0, 1.0))


def mat_rot_y(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return ((c, 0.0, s, 0.0), (0.0, 1.0, 0.0, 0.0), (-s, 0.0, c, 0.0),
            (0.0, 0.0, 0.0, 1.0))


def mat_rot_z(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return ((c, -s, 0.0, 0.0), (s, c, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0))


def mat_apply(M, p):
    return (M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2] + M[0][3],
            M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2] + M[1][3],
            M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2] + M[2][3])


# --------------------------------------------------------------------------
# ДЕТАЛИ
# --------------------------------------------------------------------------


def part(name, family, verts, faces):
    return dict(name=name, family=family, verts=[tuple(map(float, v)) for v in verts],
                faces=[tuple(f) for f in faces])


def merge(parts, name=None, family=None):
    """Склеить детали в одну (вершины не свариваются: детали не пересекаются
    вершинами, и сварка тут только испортила бы нормали)."""
    verts, faces = [], []
    for p in parts:
        off = len(verts)
        verts.extend(p['verts'])
        faces.extend(tuple(off + i for i in f) for f in p['faces'])
    fam = family or (parts[0]['family'] if parts else 'skin')
    return part(name or (parts[0]['name'] if parts else 'merged'), fam, verts, faces)


def xform(p, M, name=None):
    return part(name or p['name'], p['family'],
                [mat_apply(M, v) for v in p['verts']], p['faces'])


def moved(p, t, name=None):
    return xform(p, mat_translate(t), name)


def mirror_y(p, name=None):
    """Зеркало через плоскость XZ (левая деталь -> правая).

    Обход граней при зеркале переворачивается, поэтому список индексов
    реверсируется — иначе правая рука окажется вывернутой наизнанку.
    """
    return part(name or p['name'], p['family'],
                [(v[0], -v[1], v[2]) for v in p['verts']],
                [tuple(reversed(f)) for f in p['faces']])


def distort(p, fn):
    """Поточечная правка формы: fn(i, (x,y,z)) -> (x,y,z). Для подола, платка."""
    return part(p['name'], p['family'],
                [fn(i, v) for i, v in enumerate(p['verts'])], p['faces'])


def bbox(p):
    xs = [v[0] for v in p['verts']]
    ys = [v[1] for v in p['verts']]
    zs = [v[2] for v in p['verts']]
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))


def size(p):
    (x0, x1), (y0, y1), (z0, z1) = bbox(p)
    return (x1 - x0, y1 - y0, z1 - z0)


def center(p):
    (x0, x1), (y0, y1), (z0, z1) = bbox(p)
    return ((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0)


def stats(parts):
    """Треугольники и вершины (НЕ грани: у 6-гранной трубы 6 граней и 20 трис)."""
    verts = sum(len(p['verts']) for p in parts)
    tris = sum(sum(len(f) - 2 for f in p['faces']) for p in parts)
    return dict(verts=verts, tris=tris, parts=len(parts))


# --------------------------------------------------------------------------
# ПРИМИТИВЫ
# --------------------------------------------------------------------------


def ring(n, z, rx, ry, cx=0.0, cy=0.0, phase=0.0, zs=None, warp=None):
    """Кольцо из n точек: эллипс rx x ry вокруг (cx, cy) на высоте z.

    zs(i)   — своя высота каждому углу (подол платья неровный, платок спереди
              выше, чем на затылке);
    warp(i) — (kx, ky) множители радиуса по углу: так голова получается
              яйцом, а не бочкой.
    """
    out = []
    for i in range(n):
        a = phase + 2.0 * math.pi * i / n
        kx, ky = (warp(i) if warp else (1.0, 1.0))
        zz = z if zs is None else zs(i)
        out.append((cx + rx * kx * math.cos(a), cy + ry * ky * math.sin(a), zz))
    return out


def loft(sections, caps=(True, True), name='loft', family='skin'):
    """Тело по сечениям: sections[0] — низ, sections[-1] — верх.

    Кольца обязаны быть против часовой стрелки (вид сверху) и иметь одинаковую
    длину. Обход боковых квадов и крышек выбран так, чтобы нормали смотрели
    наружу — пересчёт не нужен и не может «спасти» вывернутую деталь молча.
    """
    n = len(sections[0])
    verts = [v for s in sections for v in s]
    faces = []
    for k in range(len(sections) - 1):
        a, b = k * n, (k + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a + i, a + j, b + j, b + i))
    if caps[0]:
        faces.append(tuple(reversed(range(n))))
    if caps[1]:
        o = (len(sections) - 1) * n
        faces.append(tuple(o + i for i in range(n)))
    return part(name, family, verts, faces)


def tube(length, sections, n=6, phase=0.0, name='tube', family='skin', warp=None):
    """Труба вдоль локального +Z от 0 до length.

    sections — [(t, rx, ry, cx, cy), ...], t — доля длины (0..1). Радиусы можно
    задавать кортежем (rx0, rx1): тогда значение идёт по t линейно — так
    описывается сужение конечности без россыпи чисел.
    """
    rings = []
    for s in sections:
        t, rx, ry = s[0], s[1], s[2]
        cx = s[3] if len(s) > 3 else 0.0
        cy = s[4] if len(s) > 4 else 0.0
        rxx = rx[0] + (rx[1] - rx[0]) * t if isinstance(rx, (tuple, list)) else rx
        ryy = ry[0] + (ry[1] - ry[0]) * t if isinstance(ry, (tuple, list)) else ry
        rings.append(ring(n, t * length, rxx, ryy, cx, cy, phase, warp=warp))
    return loft(rings, name=name, family=family)


def box(name, family, lo, hi):
    """Короб по двум углам — для мелких деталей (узел платка, пряжка)."""
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5),
         (2, 3, 7, 6), (3, 0, 4, 7)]
    return part(name, family, v, f)


def frustum(name, family, z0, z1, r0, r1, n=6, cx=0.0, cy=0.0, phase=0.0,
            r0y=None, r1y=None):
    """Усечённая пирамида/призма вдоль Z — корзина, тулья, стакан."""
    r0y = r0 if r0y is None else r0y
    r1y = r1 if r1y is None else r1y
    a = ring(n, z0, r0, r0y, cx, cy, phase)
    b = ring(n, z1, r1, r1y, cx, cy, phase)
    return loft([a, b], name=name, family=family)


def strip_shell(name, family, rows_in, rows_out):
    """Полоса-оболочка по НЕСКОЛЬКИМ дугам (фартук: 3..4 ряда по высоте).

    rows_in[k], rows_out[k] — дуги одного ряда, снизу вверх. Строится как
    замкнутая «корка»: наружная поверхность, внутренняя, и четыре кромки.
    """
    rows = len(rows_in)
    n = len(rows_in[0])
    verts = []
    for k in range(rows):
        verts.extend(rows_in[k])
        verts.extend(rows_out[k])
    def ii(k, i):
        return k * 2 * n + i
    def oo(k, i):
        return k * 2 * n + n + i
    faces = []
    for k in range(rows - 1):
        for i in range(n - 1):
            # НАРУЖНАЯ поверхность — по внешним точкам, изнанка — по внутренним
            # с обратным обходом. Перепутать их = получить деталь наизнанку:
            # xray видит её как «видимые изнанки», а в спрайте это чёрная полоса.
            faces.append((oo(k, i), oo(k, i + 1), oo(k + 1, i + 1), oo(k + 1, i)))
            faces.append((ii(k + 1, i), ii(k + 1, i + 1), ii(k, i + 1), ii(k, i)))
    for i in range(n - 1):                                  # нижняя и верхняя кромки
        faces.append((ii(0, i), ii(0, i + 1), oo(0, i + 1), oo(0, i)))
        faces.append((oo(rows - 1, i), oo(rows - 1, i + 1), ii(rows - 1, i + 1),
                      ii(rows - 1, i)))
    for k in range(rows - 1):                                # боковые кромки
        faces.append((ii(k + 1, 0), ii(k, 0), oo(k, 0), oo(k + 1, 0)))
        faces.append((ii(k, n - 1), ii(k + 1, n - 1), oo(k + 1, n - 1), oo(k, n - 1)))
    return part(name, family, verts, faces)
