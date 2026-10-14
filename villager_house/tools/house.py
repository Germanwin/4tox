"""house.py — геометрия ДОМА ЖИТЕЛЯ для mapgen2. Чистый Python, без Blender.

Конвенции пайплайна (townhall/tools/thpipe.py, geom.py):
    1 юнит модели = 1 клетка карты; пятно 3 x 2 (X — длинная сторона);
    начало координат — центр пятна; z = 0 — земля; дверь смотрит в +Y.
    Камера смотрит С -X/+Y: при повороте 0 видно фасад (+Y) и торец (-X).

Эталон — собранная ратуша (`townhall/out/th_a_0.png`): обмазанный плетень под
двускатной соломой, каркас, каменный цоколь, мох, глубокий свес кровли.

ЯРУСЫ (канон `4tox-house-3d/references/house-canon.md` §3):
    цоколь -> стены с каркасом -> проёмы -> кровля -> труба -> двор.
Каждая деталь — dict(name, family, verts, faces). Семейство — зона палитры
атласа (`tools/palette.py`), тон фасета считается ПО НОРМАЛИ уже в Blender
(`tools/build.py::assign_tones`), поэтому цвета здесь не задаются.

ТРИ ПРАВИЛА, НА КОТОРЫХ СТОИТ ЭТА РЕВИЗИЯ (каждое — вылеченные грабли):

1. ГЕОМЕТРИЯ — В НОМИНАЛЕ, НАКЛОН СТЕНЫ — ОТДЕЛЬНО.  Стена «растёт» вверх
   (низ уже верха на 1.2 град), но верх стены = номинальный прямоугольник
   2.76 x 1.64.  Раньше наклон применялся к коробке стен, её верх становился
   ШИРЕ номинала на 2.4%, и верхняя обвязка с углом стены пробивали скат
   кровли (щели по карнизу).  Теперь всё, что стоит на стене и выше (обвязка,
   щипец, кровля), считается по номиналу, а наклон к стене прижимает только
   то, что к ней прибито: `lean()` — тот же закон, что у коробки стен.

2. У КАЖДОГО ФАСЕТА ЯВНЫЙ СМЫСЛ.  Брусок (`bar`) знает, С КАКИХ СТОРОН его
   видно (`see`), и сам выбрасывает невидимые боковины; у коробок `keep`
   назван именами граней.  Раньше в `bar` имена `keep` были смещены на две
   позиции: у раскосов выбрасывалась НАРУЖНАЯ грань, и в кадре раскос читался
   волосяной линией, а лобовая доска — вывернутой наизнанку.

3. СТЫКИ СХОДЯТСЯ, А НЕ ВИСЯТ.  Раскос доводится до стойки/обвязки с заходом
   внутрь (`over`), ригель идёт от стойки до стойки, рама окна — кольцо
   (стойки на всю высоту, планки МЕЖДУ ними), стекло утоплено в раму.
   Висящая в воздухе деталь в изометрии читается ошибкой (канон, §10).
"""
import math
import random

# --------------------------------------------------------------------------
# КОНВЕНЦИИ И РАЗМЕРЫ (юниты; 1 юнит = 1 клетка)
# --------------------------------------------------------------------------
WALL_X, WALL_Y = 2.76, 1.64        # оси стен: X — длинная сторона
HX, HY = WALL_X / 2.0, WALL_Y / 2.0       # 1.38, 0.82

PL_H = 0.16                        # каменный цоколь, высота (канон 0.15)
PL_OUT = 0.055                     # выступ цоколя за плоскость стены (канон 0.06)
WALL_Z0 = PL_H                     # 0.16
WALL_H = 1.35                      # высота стен (канон 1.35)
WALL_Z1 = WALL_Z0 + WALL_H         # 1.51

# стена «растёт»: k = 1 вверху (номинал), ниже — уже
TAN_LEAN = math.tan(math.radians(1.2))


def wall_k(z):
    t = (z - WALL_Z0) / WALL_H
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return 1.0 - (1.0 - t) * TAN_LEAN


def lean(verts):
    """Прижать деталь к наклонной стене тем же законом, что и коробку стен."""
    return [(v[0] * wall_k(v[2]), v[1] * wall_k(v[2]), v[2]) for v in verts]


FRAME_OUT = 0.05                   # выступ каркаса за плоскость стены (канон 0.05)
FRAME_T = 0.10                     # толщина бруса каркаса

PITCH = math.radians(47.0)         # уклон ската: солома 45..55 град (канон)
TAN_P, COS_P = math.tan(PITCH), math.cos(PITCH)
OVER_SLOPE = 0.18                  # свес по скату (канон 11..31%)
OVER_END = 0.11                    # свес по торцу (канон 4..13%)
EAVE_Y = HY + OVER_SLOPE           # 1.00 — кромка соломы по Y (ровно в пятно)
ROOF_X = HX + OVER_END             # 1.49 — кромка лобовой доски по X
PLANK_X = ROOF_X - 0.07            # 1.42 — где кончается солома (дальше доска)
ROOF_T = 0.13                      # толщина кровли у карниза (канон 0.08..0.12+)
N_PLAST = 7                        # пластов соломы на скат (канон 6..14)

# Низ кровли опирается на НАРУЖНУЮ кромку верхней обвязки, а не на плоскость
# стены: обвязка выступает на 0.05, и скат, проходящий по стене, её пробивал.
ROOF_Y0 = HY + FRAME_OUT           # 0.87


def z_under(y):
    """Низ кровли: плоскость через наружную кромку верхней обвязки."""
    return WALL_Z1 + (ROOF_Y0 - abs(y)) * TAN_P


def z_nom(y):
    """Номинальная ВЕРХНЯЯ поверхность кровли (без ступеней пластов)."""
    return z_under(y) + ROOF_T / COS_P


RIDGE_Z = z_nom(0.0)               # конёк по номиналу


# --------------------------------------------------------------------------
# ПРИМИТИЗЫ
# --------------------------------------------------------------------------
FACES_ALL = ('+x', '-x', '+y', '-y', '+z', '-z')
# Стороны, с которых модель вообще видно: четыре поворота спрайта + сверху.
# Всё, что не смотрит ни в одну из них, в спрайт не доедет и не строится.
SEE_ALL = ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (0.0, -1.0, 0.0),
           (1.0, 0.0, 0.0), (-1.0, 0.0, 0.0))


def _rot(p, cx, cy, cz, rz, rx, ry):
    """Поворот точки вокруг (cx, cy, cz): сначала Z, потом X, потом Y."""
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
    """Короб: (cx, cy, z0) — центр ОСНОВАНИЯ, размеры, поворот вокруг основания.

    `keep` — какие грани оставить (('+y', '-y', ...)); None — все шесть.
    Порядок вершин и граней даёт нормали НАРУЖУ без пересчёта.
    """
    x0, x1 = cx - sx / 2.0, cx + sx / 2.0
    y0, y1 = cy - sy / 2.0, cy + sy / 2.0
    z1 = z0 + sz
    base = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    if rz or rx or ry:
        base = [_rot(p, cx, cy, z0, rz, rx, ry) for p in base]
    named = [('+z', (4, 5, 6, 7)), ('-z', (0, 3, 2, 1)),
             ('+y', (2, 3, 7, 6)), ('-y', (0, 1, 5, 4)),
             ('+x', (1, 2, 6, 5)), ('-x', (3, 0, 4, 7))]
    if keep is None:
        faces = [f for _, f in named]
    else:
        faces = [f for n, f in named if n in keep]
    return base, faces


def prism_x(poly_yz, x0, x1, keep=None):
    """Призма вдоль X по контуру в плоскости YZ. Нормали — наружу.

    Контур задаётся в любом обходе: ориентация выправляется знаком площади
    (CCW в (y,z) при взгляде с +X даёт нормаль +X).
    """
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
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    faces.append(tuple(range(n - 1, -1, -1)))           # торец x0: нормаль -X
    faces.append(tuple(range(n, 2 * n)))                # торец x1: нормаль +X
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


def _norm(v):
    d = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    return (v[0] / d, v[1] / d, v[2] / d)


def _face_normal(verts, f):
    p = [verts[i] for i in f]
    a = (p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2])
    b = (p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2])
    return _norm((a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                  a[0] * b[1] - a[1] * b[0]))


def cull(verts, faces, see=SEE_ALL, min_dot=0.12):
    """Выбросить фасеты, не смотрящие ни в одну из сторон `see`.

    Это единственный честный способ экономить трисы: грань, нормаль которой
    не ловит ни один из четырёх поворотов спрайта и не смотрит вверх, в кадр
    не попадает.  Проверяется тестом `tools/xray.py probe` (видимых изнанок
    быть не должно).
    """
    out = []
    for f in faces:
        n = _face_normal(verts, f)
        if any(n[0] * s[0] + n[1] * s[1] + n[2] * s[2] > min_dot for s in see):
            out.append(f)
    return out


def bar(p0, p1, sx, sy, see=(), caps=(), over=0.0):
    """Брусок из p0 в p1 (p0/p1 — центры торцов), сечение sx (поперёк) x sy.

    Ось бруска — от p0 к p1; для наклонных элементов (раскосы, жерди, лобовая
    доска) это единственный способ задать их одной строкой и без ошибок.

    `see` — направления, С КОТОРЫХ брусок видно (обычно нормаль стены и «верх»):
    остаются только те боковины, что смотрят в них.  `caps` — какие торцы
    оставить (0 — у p0, 1 — у p1); `over` удлиняет брусок с обоих концов.
    """
    ax = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    ln = math.sqrt(ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2)
    w = _norm(ax)
    ref = (0.0, 0.0, 1.0) if abs(w[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = _norm((w[1] * ref[2] - w[2] * ref[1],
               w[2] * ref[0] - w[0] * ref[2],
               w[0] * ref[1] - w[1] * ref[0]))
    v = (w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0])
    hx, hy, hz = sx / 2.0, sy / 2.0, ln / 2.0 + over
    cx = (p0[0] + p1[0]) / 2.0
    cy = (p0[1] + p1[1]) / 2.0
    cz = (p0[2] + p1[2]) / 2.0
    verts = []
    for sz_ in (-1, 1):
        for sgx, sgy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            verts.append((cx + u[0] * hx * sgx + v[0] * hy * sgy + w[0] * hz * sz_,
                          cy + u[1] * hx * sgx + v[1] * hy * sgy + w[1] * hz * sz_,
                          cz + u[2] * hx * sgx + v[2] * hy * sgy + w[2] * hz * sz_))
    # грани и их нормали: 0 = торец p1, 1 = торец p0, 2 = +v, 3 = -v, 4 = +u, 5 = -u
    all_faces = [(4, 5, 6, 7), (0, 3, 2, 1), (2, 3, 7, 6), (0, 1, 5, 4),
                 (1, 2, 6, 5), (3, 0, 4, 7)]
    normals = [w, (-w[0], -w[1], -w[2]), v, (-v[0], -v[1], -v[2]), u,
               (-u[0], -u[1], -u[2])]
    idx = []
    if 0 in caps:
        idx.append(0)
    if 1 in caps:
        idx.append(1)
    if see:
        for i in (2, 3, 4, 5):
            n = normals[i]
            if any(n[0] * s[0] + n[1] * s[1] + n[2] * s[2] > 0.20 for s in see):
                idx.append(i)
    else:
        # see не задан — оставляем ВСЕ боковины (иначе брусок превращается в
        # полую труду из двух торцов; разбирается автоотсевом)
        idx.extend((2, 3, 4, 5))
    faces = [all_faces[i] for i in sorted(set(idx))]
    return verts, faces


def _triangles(pts):
    """Триангуляция полигона (ear clipping) с сохранением обхода.

    Веер годится только для выпуклых контуров: у пилы кровли и у козырька он
    давал треугольники с вывернутой нормалью, и `probe` показывал дыры там,
    где их нет.
    """
    m = len(pts)
    if m < 3:
        return []
    if m == 3:
        return [(0, 1, 2)]
    e1 = [pts[1][i] - pts[0][i] for i in range(3)]
    e2 = [pts[2][i] - pts[0][i] for i in range(3)]
    n = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
         e1[0] * e2[1] - e1[1] * e2[0])
    ax = max(range(3), key=lambda i: abs(n[i]))
    i0, i1 = [i for i in range(3) if i != ax]
    P = [(p[i0], p[i1]) for p in pts]
    area = 0.5 * sum(P[i][0] * P[(i + 1) % m][1] - P[(i + 1) % m][0] * P[i][1]
                     for i in range(m))
    sgn = 1.0 if area >= 0 else -1.0
    idx = list(range(m))
    out = []
    guard = 0
    while len(idx) > 3 and guard < 4 * m + 16:
        guard += 1
        cut = False
        for k in range(len(idx)):
            a, b, c = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            pa, pb, pc = P[a], P[b], P[c]
            cr = ((pb[0] - pa[0]) * (pc[1] - pa[1])
                  - (pb[1] - pa[1]) * (pc[0] - pa[0])) * sgn
            if cr <= 1e-12:
                continue
            ok = True
            for j in idx:
                if j in (a, b, c):
                    continue
                q = P[j]
                d1 = (pb[0] - pa[0]) * (q[1] - pa[1]) - (pb[1] - pa[1]) * (q[0] - pa[0])
                d2 = (pc[0] - pb[0]) * (q[1] - pb[1]) - (pc[1] - pb[1]) * (q[0] - pb[0])
                d3 = (pa[0] - pc[0]) * (q[1] - pc[1]) - (pa[1] - pc[1]) * (q[0] - pc[0])
                if d1 * sgn >= -1e-12 and d2 * sgn >= -1e-12 and d3 * sgn >= -1e-12:
                    ok = False
                    break
            if ok:
                out.append((a, b, c))
                idx.remove(b)
                cut = True
                break
        if not cut:
            break
    if len(idx) > 3:
        # не нашли ухо (неплоский или почти вырожденный контур) — добиваем
        # веером: важно вернуть ТРЕУГОЛЬНИКИ, иначе геометрия ломается
        for k in range(1, len(idx) - 1):
            out.append((idx[0], idx[k], idx[k + 1]))
    elif len(idx) == 3:
        out.append(tuple(idx))
    return out


def _ray_tri(o, d, a, b, c, tmax):
    """Пересечение луча o+t*d с треугольником (Мёллер—Трумбор). t или None."""
    e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    pv = (d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2],
          d[0] * e2[1] - d[1] * e2[0])
    det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]
    if -1e-12 < det < 1e-12:
        return None
    inv = 1.0 / det
    tv = (o[0] - a[0], o[1] - a[1], o[2] - a[2])
    u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv
    if u < -1e-9 or u > 1 + 1e-9:
        return None
    qv = (tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2],
          tv[0] * e1[1] - tv[1] * e1[0])
    v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv
    if v < -1e-9 or u + v > 1 + 1e-9:
        return None
    t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv
    return t if 1e-6 < t < tmax else None


class _Grid(object):
    """Грубая равномерная сетка треугольников — чтобы автоотсев не был O(n*m)."""

    def __init__(self, tris, cell=0.25):
        self.cell = cell
        self.d = {}
        self.tris = tris
        for i, (a, b, c) in enumerate(tris):
            x0 = min(a[0], b[0], c[0]); x1 = max(a[0], b[0], c[0])
            y0 = min(a[1], b[1], c[1]); y1 = max(a[1], b[1], c[1])
            z0 = min(a[2], b[2], c[2]); z1 = max(a[2], b[2], c[2])
            for ix in range(int(x0 // cell), int(x1 // cell) + 1):
                for iy in range(int(y0 // cell), int(y1 // cell) + 1):
                    for iz in range(int(z0 // cell), int(z1 // cell) + 1):
                        self.d.setdefault((ix, iy, iz), []).append(i)

    def along(self, o, p):
        """Индексы треугольников в ячейках вдоль отрезка o..p."""
        out = set()
        cell = self.cell
        n = max(1, int(max(abs(p[i] - o[i]) for i in range(3)) / cell * 2.0) + 1)
        for k in range(n + 1):
            t = k / float(n)
            q = (o[0] + (p[0] - o[0]) * t, o[1] + (p[1] - o[1]) * t,
                 o[2] + (p[2] - o[2]) * t)
            key = (int(q[0] // cell), int(q[1] // cell), int(q[2] // cell))
            out.update(self.d.get(key, ()))
        return out


def _is_closed(part):
    """Замкнут ли контур детали (каждое ребро встречается ровно дважды)."""
    seen = set()
    for f in part['faces']:
        for k in range(len(f)):
            e = (f[k], f[(k + 1) % len(f)])
            if e in seen:
                return False
            seen.add(e)
    return all((b, a) in seen for (a, b) in seen)


def autocull(parts, cover=0.03):
    """Выбросить фасеты, которые НЕМЕДЛЕННО закрыты или утоплены в соседа.

    Два теста на каждую пробную точку фасета:
      1) луч наружу упирается в чужую геометрию ближе `cover` — фасет закрыт;
      2) точка лежит ВНУТРИ замкнутой чужой детали — фасет утоплен.
    Второй тест нужен отдельно: луч, стартующий внутри чужого объёма, выходит
    наружу через дальнюю стенку и «закрытым» не считается — из-за этого у
    блоков цоколя оставались все шесть граней (240 трис на ровном месте).

    Фасет выбрасывается, только если закрыты ВСЕ его пробные точки (центр и
    углы, поджатые к центру на 7%): иначе в оболочке осталась бы дыра.
    """
    tris, owner = [], []
    for pi, p in enumerate(parts):
        v = p['verts']
        for f in p['faces']:
            # НЕ веер: у невыпуклого контура (пила кровли) веер даёт треугольники
            # ВНЕ контура — они «закрывали» чужие фасеты, и стекло щипца
            # оставалось без единой грани
            for t in _triangles([v[i] for i in f]):
                tris.append((v[f[t[0]]], v[f[t[1]]], v[f[t[2]]]))
                owner.append(pi)
    grid = _Grid(tris)

    boxes, closed = [], []
    for p in parts:
        v = p['verts']
        boxes.append(([min(q[i] for q in v) for i in range(3)],
                      [max(q[i] for q in v) for i in range(3)]))
        closed.append(_is_closed(p))
    solid = [i for i in range(len(parts)) if closed[i] and len(parts[i]['faces']) >= 4]
    ptris = {i: [tris[j] for j in range(len(tris)) if owner[j] == i] for i in solid}

    def inside(q, skip):
        for pi in solid:
            if pi == skip:
                continue
            lo, hi = boxes[pi]
            if not (lo[0] < q[0] < hi[0] and lo[1] < q[1] < hi[1]
                    and lo[2] < q[2] < hi[2]):
                continue
            cnt = 0
            for a, b, c in ptris[pi]:
                if _ray_tri(q, (0.0, 1.0, 0.0), a, b, c, 1e9) is not None:
                    cnt += 1
            if cnt % 2 == 1:
                return True
        return False

    for pi, p in enumerate(parts):
        v = p['verts']
        keep = []
        for f in p['faces']:
            pts = [v[i] for i in f]
            n = _face_normal(v, f)
            c = [sum(q[k] for q in pts) / len(pts) for k in range(3)]
            probes = [c] + [[c[k] + (q[k] - c[k]) * 0.93 for k in range(3)]
                            for q in pts]
            hidden = True
            for q in probes:
                o = (q[0] + n[0] * 1e-4, q[1] + n[1] * 1e-4, q[2] + n[2] * 1e-4)
                end = (o[0] + n[0] * cover, o[1] + n[1] * cover, o[2] + n[2] * cover)
                hit = False
                for ti in grid.along(o, end):
                    if owner[ti] == pi:
                        continue
                    a, b, cc = tris[ti]
                    if _ray_tri(o, n, a, b, cc, cover) is not None:
                        hit = True
                        break
                if not hit and not inside(q, pi):
                    hidden = False
                    break
            if not hidden:
                keep.append(f)
        p['faces'] = keep
    return parts


def jitter(verts, amount, seed, axis=None):
    """Дрожь вершин: «глина», а не линейка. Малая (0.004..0.008)."""
    if not amount:
        return verts
    rng = random.Random(seed)
    out = []
    for p in verts:
        d = [rng.uniform(-amount, amount) for _ in range(3)]
        if axis:
            for i in range(3):
                if axis[i] == 0:
                    d[i] = 0.0
        out.append((p[0] + d[0], p[1] + d[1], p[2] + d[2]))
    return out


def part(parts, name, family, verts, faces, jit=0.0, seed=0, ln=False):
    """Добавить деталь. ln=True — прижать к наклонной стене (см. lean)."""
    if ln:
        verts = lean(verts)
    if jit:
        verts = jitter(verts, jit, seed)
    parts.append(dict(name=name, family=family, verts=verts, faces=faces))
    return parts


def tris_of(parts):
    return sum(sum(len(f) - 2 for f in p['faces']) for p in parts)


def verts_of(parts):
    return sum(len(p['verts']) for p in parts)


# --------------------------------------------------------------------------
# РАСКЛАДКА СТЕНЫ: где стойки, где проёмы, где раскосы
# --------------------------------------------------------------------------
# Всё в НОМИНАЛЕ (плоскость стены y = +-HY / x = +-HX), наклон — отдельно.
CP_W = 0.14                        # угловая стойка (канон 0.12..0.14)
ST_W = 0.11                        # промежуточная стойка (канон 0.10)
PLATE_T = 0.10                     # толщина обвязки
PLATE_H = 0.13                     # высота обвязки (верхней и нижней)
WIN = 0.28                         # окно фасада (канон 0.26)
WIN_G = 0.23                       # окно щипца
WIN_FW = 0.05                      # ширина планки рамы
WIN_OUT = 0.05                     # выступ рамы за плоскость стены
WIN_GLASS = 0.025                  # насколько стекло выступает из стены (в раме)
DOOR_W, DOOR_H = 0.34, 0.70        # дверь (канон 0.32 x 0.72)

WIN_FRONT_X = 0.78                 # центры окон фасада
WIN_BACK_X = 0.78
SIDE_WIN_Y = 0.0
WIN_Z = WALL_Z0 + 0.42 * WALL_H    # 0.727 — центр окна по высоте (канон 0.42)
RIGEL_Z0, RIGEL_Z1 = 0.90, 0.99    # ригель: одна линия на окна и на дверь
WIN_Z = RIGEL_Z0 - (WIN / 2.0 + WIN_FW)      # окно подпирает ригель снизу
STUD_X = 0.44                      # промежуточные стойки фасада, |x|
SIDE_STUD_Y = 0.42                 # промежуточные стойки торца, |y|
SIDE_LOW_Y = 0.33                  # стойки верхней панели торца, |y|
GABLE_BRACE_Y = 0.72               # низ раскоса щипца на обвязке
GABLE_BRACE_Y1 = 0.26              # верх раскоса щипца на центральной стойке
CHIMNEY_X = -0.62                  # труба смещена от центра (канон 0.3..0.6)
CHIMNEY_Y = 0.36                   # стоит на скате: на коньке её съедает гребень


def _wall_faces(wall):
    """(наружная грань, первая вдоль стены, вторая вдоль стены)."""
    return {'+y': ('+y', '+x', '-x'), '-y': ('-y', '+x', '-x'),
            '+x': ('+x', '+y', '-y'), '-x': ('-x', '+y', '-y')}[wall]


def stick(parts, name, wall, a0, a1, z0, z1, t=FRAME_T, out=FRAME_OUT,
          faces=('out', 'top'), fam='trunk', ln=True, jit=0.0, seed=0):
    """Брусок каркаса НА стене.

    wall — нормаль стены ('+y', '-y', '+x', '-x'); a0..a1 — вдоль стены
    (x для стен +-y, y для стен +-x); z0..z1 — по высоте.  Наружная грань
    встаёт на `out` от плоскости стены, внутрь брус уходит на t - out.
    `faces` — какие грани оставить: out / top / bot / s1 / s2 (s1, s2 — вдоль).
    """
    o, s1, s2 = _wall_faces(wall)
    keep = tuple({'out': o, 'top': '+z', 'bot': '-z', 's1': s1, 's2': s2}[k]
                 for k in faces)
    if wall in ('+y', '-y'):
        sgn = 1.0 if wall == '+y' else -1.0
        cx, cy = (a0 + a1) / 2.0, sgn * (HY + out - t / 2.0)
        sx, sy = abs(a1 - a0), t
    else:
        sgn = 1.0 if wall == '+x' else -1.0
        cx, cy = sgn * (HX + out - t / 2.0), (a0 + a1) / 2.0
        sx, sy = t, abs(a1 - a0)
    v, f = box(cx, cy, z0, sx, sy, z1 - z0, keep=keep)
    return part(parts, name, fam, v, f, jit=jit, seed=seed, ln=ln)


# --------------------------------------------------------------------------
# ЯРУС 1: КАМЕННЫЙ ЦОКОЛЬ
# --------------------------------------------------------------------------
def build_plinth(parts, rng):
    """Цоколь: непрерывное ядро + отдельные блоки со швом (канон §2)."""
    px, py = HX + 0.045, HY + 0.045
    v, f = box(0.0, 0.0, 0.0, 2 * px, 2 * py, PL_H + 0.03,
               keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    part(parts, 'plinth_core', 'stone', v, f, jit=0.005, seed=101)

    # блоки по длинным стенам: 6 на сторону, ширина 0.36..0.46, шов 0.025
    for sgn_y in (1, -1):
        n = 5
        w = (2 * px + 0.06) / n
        for i in range(n):
            cx = -px - 0.03 + w * (i + 0.5)
            h = PL_H + rng.uniform(-0.02, 0.025)
            dz = rng.uniform(-0.012, 0.012)
            sy = rng.uniform(0.025, 0.052)
            v, f = box(cx, sgn_y * (py + sy / 2.0 - 0.012), dz,
                       w - 0.03, sy, h,
                       rz=math.radians(rng.uniform(-3.0, 3.0)),
                       rx=math.radians(rng.uniform(-2.0, 2.0)))
            part(parts, 'plinth_block_y%d_%d' % (sgn_y, i), 'stone', v, f,
                 jit=0.004, seed=110 + i + (0 if sgn_y > 0 else 7))
    # блоки по торцам: 4 на сторону
    for sgn_x in (1, -1):
        n = 3
        w = (2 * py + 0.06) / n
        for i in range(n):
            cy = -py - 0.03 + w * (i + 0.5)
            h = PL_H + rng.uniform(-0.02, 0.025)
            dz = rng.uniform(-0.012, 0.012)
            sx = rng.uniform(0.025, 0.052)
            v, f = box(sgn_x * (px + sx / 2.0 - 0.012), cy, dz,
                       sx, w - 0.03, h,
                       rz=math.radians(rng.uniform(-3.0, 3.0)),
                       ry=math.radians(rng.uniform(-2.0, 2.0)))
            part(parts, 'plinth_block_x%d_%d' % (sgn_x, i), 'stone', v, f,
                 jit=0.004, seed=130 + i + (0 if sgn_x > 0 else 5))
    # мох на цоколе — как у ратуши: пятна по верху кладки
    for i, (mx, my) in enumerate(((-1.20, 0.85), (1.28, 0.85), (1.32, -0.86),
                                  (-1.30, -0.62), (1.36, 0.30))):
        r = rng.uniform(0.07, 0.12)
        v, f = box(mx, my, PL_H - 0.008, r * 2, r * 1.1, 0.032,
                   rz=math.radians(rng.uniform(-25, 25)))
        part(parts, 'moss_%d' % i, 'grass', v, f, jit=0.004, seed=150 + i)


# --------------------------------------------------------------------------
# ЯРУС 2: СТЕНЫ (обмазка) И ЩИПЦЫ
# --------------------------------------------------------------------------
def build_walls(parts):
    """Обмазанная стена + щипцы.  Верх стены — номинал (см. правило 1)."""
    v, f = box(0.0, 0.0, WALL_Z0, WALL_X, WALL_Y, WALL_H,
               keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    part(parts, 'wall_core', 'skin', v, f, jit=0.005, seed=201, ln=True)

    # Щипец — ПЯТИУГОЛЬНИК: низ по верху стены, скаты ровно по низу кровли.
    # (Треугольник до конька оставлял бы щель под свесом: низ кровли идёт по
    #  наружной кромке обвязки, то есть на 0.05 выше плоскости стены.)
    gable = [(HY, WALL_Z1), (HY, z_under(HY)), (0.0, z_under(0.0)),
             (-HY, z_under(HY)), (-HY, WALL_Z1)]
    for sgn in (1, -1):
        v, f = prism_x(gable, sgn * (HX - 0.06), sgn * HX,
                       keep=('+x' if sgn > 0 else '-x',))
        part(parts, 'gable_%d' % sgn, 'skin', v, f, jit=0.004, seed=203 + (sgn > 0))


# --------------------------------------------------------------------------
# ЯРУС 2b: КАРКАС (фахверк)
# --------------------------------------------------------------------------
def build_frame(parts):
    """Обвязки, стойки, ригель, раскосы, щипец.  Всё сходится в стыках.

    Раскладка панели (фасад): нижняя обвязка -> стойки -> РИГЕЛЬ на одной
    линии с верхом окна и верхом двери -> верхние угловые раскосы в 45 град ->
    верхняя обвязка.  Раскосы стоят именно в верхних панелях: прямой ход от
    стойки к углу прошёл бы ровно сквозь окно.
    """
    z_bot0, z_bot1 = WALL_Z0, WALL_Z0 + PLATE_H          # нижняя обвязка
    z_top0, z_top1 = WALL_Z1 - PLATE_H, WALL_Z1          # верхняя обвязка
    a_in_x = HX - CP_W / 2.0 + 0.03                      # докуда достаёт ригель
    a_in_y = HY - CP_W / 2.0 + 0.03

    # --- обвязки по периметру (торцы прячутся в угловых стойках) -----------
    for sgn in (1, -1):
        wy = '+y' if sgn > 0 else '-y'
        wx = '+x' if sgn > 0 else '-x'
        stick(parts, 'plate_by%d' % sgn, wy, -HX, HX, z_bot0, z_bot1,
              faces=('out', 'top', 'bot'))
        stick(parts, 'plate_ty%d' % sgn, wy, -HX, HX, z_top0, z_top1,
              faces=('out', 'top', 'bot'))
        stick(parts, 'plate_bx%d' % sgn, wx, -HY, HY, z_bot0, z_bot1,
              faces=('out', 'top', 'bot'))
        stick(parts, 'plate_tx%d' % sgn, wx, -HY, HY, z_top0, z_top1,
              faces=('out', 'top', 'bot'))

    # --- угловые стойки: обнимают угол, выступают по обеим стенам ----------
    for sx_ in (1, -1):
        for sy_ in (1, -1):
            v, f = box(sx_ * (HX + FRAME_OUT - CP_W / 2.0),
                       sy_ * (HY + FRAME_OUT - CP_W / 2.0),
                       WALL_Z0, CP_W, CP_W, WALL_H,
                       keep=(('+x' if sx_ > 0 else '-x'),
                             ('+y' if sy_ > 0 else '-y'), '+z'))
            part(parts, 'corner_%d%d' % (sx_, sy_), 'trunk', v, f, ln=True)

    # --- промежуточные стойки: фасад и тыл по X, торцы по Y ---------------
    for sgn in (1, -1):
        for sy_ in (1, -1):
            wall = '+y' if sy_ > 0 else '-y'
            stick(parts, 'stud_f%d_%d' % (sgn, sy_), wall,
                  sgn * STUD_X - ST_W / 2.0, sgn * STUD_X + ST_W / 2.0,
                  z_bot1, RIGEL_Z0, faces=('out', 's1', 's2'))
            stick(parts, 'stud_u%d_%d' % (sgn, sy_), wall,
                  sgn * STUD_X - ST_W / 2.0, sgn * STUD_X + ST_W / 2.0,
                  RIGEL_Z1, z_top0, faces=('out', 's1', 's2'))
        for sx_ in (1, -1):
            wall = '+x' if sx_ > 0 else '-x'
            stick(parts, 'stud_s%d_%d' % (sgn, sx_), wall,
                  sgn * SIDE_STUD_Y - ST_W / 2.0, sgn * SIDE_STUD_Y + ST_W / 2.0,
                  z_bot1, RIGEL_Z0, faces=('out', 's1', 's2'))

    # --- центральная стойка: над ригелем на фасаде, до ригеля в тылу ------
    stick(parts, 'stud_c_f', '+y', -ST_W / 2.0, ST_W / 2.0, RIGEL_Z1, z_top0,
          faces=('out', 's1', 's2'))
    stick(parts, 'stud_c_b', '-y', -ST_W / 2.0, ST_W / 2.0, z_bot1, RIGEL_Z0,
          faces=('out', 's1', 's2'))

    # --- ригель: одна горизонталь на окна, дверь и тыл --------------------
    for wall, a0, a1 in (('+y', -a_in_x, a_in_x), ('-y', -a_in_x, a_in_x),
                         ('+x', -a_in_y, a_in_y), ('-x', -a_in_y, a_in_y)):
        stick(parts, 'rigel_%s' % wall, wall, a0, a1, RIGEL_Z0, RIGEL_Z1,
              faces=('out', 'top', 'bot'))

    # --- угловые раскосы верхних панелей: ровно 45 град, в стык -----------
    # брусок лежит в плоскости стены: ось X — вдоль стены, Z — вверх, а
    # поперёк (в стену) он уходит на FRAME_T, как и остальной каркас
    for wall in ('+y', '-y'):
        sgn_y = 1.0 if wall == '+y' else -1.0
        for sgn in (1, -1):
            v, f = bar((sgn * a_in_x, sgn_y * HY, RIGEL_Z1 - 0.015),
                       (sgn * (a_in_x - 0.40), sgn_y * HY,
                        RIGEL_Z1 - 0.015 + 0.40),
                       FRAME_T, 0.085,
                       see=((0.0, sgn_y, 0.0), (0.0, 0.0, 1.0)), over=0.03)
            part(parts, 'brace_y%s%d' % (wall[1], sgn), 'trunk', v, f, ln=True)

    # ТОРЦЫ — без раскосов в панелях: панель 1.38 x 0.39 слишком широкая и низкая,
    # раскос 45° в ней сходится к середине и обрывается в пустоте (заказчик:
    # «обрубаются на половине пути»).  У эталона-ратуши торец держат стойки и
    # обвязки — так же и здесь: ряд стоек в верхней панели.
    for wall in ('+x', '-x'):
        for sgn in (1, -1):
            stick(parts, 'stud_xu%d%s' % (sgn, wall[1]), wall,
                  sgn * SIDE_LOW_Y - ST_W / 2.0, sgn * SIDE_LOW_Y + ST_W / 2.0,
                  RIGEL_Z1, z_top0, faces=('out', 's1', 's2'))

    # --- щипец: центральная стойка + два раскоса в 45 град ----------------
    for sx_ in (1, -1):
        out_x = ('+x' if sx_ > 0 else '-x')
        # центральная стойка идёт от обвязки вверх, но РАЗРЕЗАНА окном щипца:
        # сплошная стойка проходила за стеклом и автоотсев выбрасывал стекло
        wtop, wbot = 1.90 + WIN_G / 2.0 + 0.04, 1.90 - WIN_G / 2.0 - 0.04
        v, f = box(sx_ * (HX + FRAME_OUT - FRAME_T / 2.0), 0.0, WALL_Z1,
                   FRAME_T, ST_W, wbot - WALL_Z1, keep=(out_x, '+y', '-y'))
        part(parts, 'gable_post%d_a' % sx_, 'trunk', v, f, ln=True)
        v, f = box(sx_ * (HX + FRAME_OUT - FRAME_T / 2.0), 0.0, wtop,
                   FRAME_T, ST_W, z_under(0.0) - 0.17 - wtop,
                   keep=(out_x, '+y', '-y', '+z'))
        part(parts, 'gable_post%d_b' % sx_, 'trunk', v, f, ln=True)
        for sg in (1, -1):
            # 45 град от верхней обвязки до НАРУЖНОЙ стойки рамы окна щипца:
            # раньше раскос кончался на 0.2 не дойдя до стойки — обрубленный
            # конец в воздухе (заказчик это и увидел)
            v, f = bar((sx_ * HX, sg * 0.70, WALL_Z1 - 0.015),
                       (sx_ * HX, sg * 0.17, WALL_Z1 - 0.015 + 0.53),
                       FRAME_T, 0.075,
                       see=((sx_, 0.0, 0.0), (0.0, 0.0, 1.0)), over=0.035)
            part(parts, 'gable_brace%d%d' % (sx_, sg), 'trunk', v, f, ln=True)


# --------------------------------------------------------------------------
# ЯРУС 3: ПРОЁМЫ
# --------------------------------------------------------------------------
def build_window(parts, cx, cy, cz, nx, ny, tag, shutters=False, size=None):
    """Окно: рама-кольцо, стекло в глубине рамы, переплёт 2 x 2, подоконник.

    (nx, ny) — нормаль стены наружу (осевая).  Рама — именно КОЛЬЦО: стойки
    идут на всю высоту (2*O), планки встают МЕЖДУ ними и заходят в стойки на
    5 мм, поэтому в углах рамы нет ни щели, ни совпадающих плоскостей
    (z-fighting).  Стекло ТЁМНОЕ (канон §5) и утоплено в раму на 0.025.
    """
    win = size or WIN
    fw = WIN_FW if win > 0.25 else 0.04
    t = 0.07                                # глубина рамы (в стену на 0.02)
    half = win / 2.0
    O = half + fw                           # половина НАРУЖНОГО габарита рамы
    # Глубины окна (от плоскости стены): рама выступает на WIN_OUT, стекло
    # утоплено в неё на 0.026, переплёт — перед стеклом.  В v2 стекло торчало
    # на 1 мм ВПЕРЁД рамы, и автоотсев гасил наружную грань рамы.
    dc = WIN_OUT - t / 2.0                  # центр рамы по глубине
    d_glass = WIN_OUT - 0.032               # стекло
    d_mul = WIN_OUT - 0.014                 # переплёт

    if ny:                                  # стена по X, нормаль по Y
        s = 1.0 if ny > 0 else -1.0
        oy = '+y' if s > 0 else '-y'
        yc = cy + s * dc
        # стойки: на всю высоту рамы
        for sgx in (1, -1):
            v, f = box(cx + sgx * (half + fw / 2.0), yc, cz - O, fw, t, 2 * O,
                       keep=(oy, '+x', '-x'))
            part(parts, tag + '_fr_%d' % sgx, 'trunk', v, f, ln=True)
        # планки: между стойками (в стойки заходят на 5 мм)
        v, f = box(cx, yc, cz + half, win + 0.01, t, fw, keep=(oy, '-z', '+z'))
        part(parts, tag + '_fr_t', 'trunk', v, f, ln=True)
        v, f = box(cx, yc, cz - half - fw, win + 0.01, t, fw, keep=(oy, '+z', '-z'))
        part(parts, tag + '_fr_b', 'trunk', v, f, ln=True)
        # стекло: в раме, на WIN_GLASS от плоскости стены
        v, f = box(cx, cy + s * d_glass, cz - half, win, 0.012, win,
                   keep=(oy,))
        part(parts, tag + '_glass', 'iron', v, f, ln=True)
        # переплёт 2 x 2 — перед стеклом, в проёме рамы
        v, f = box(cx, cy + s * d_mul, cz - half, 0.026, 0.02, win,
                   keep=(oy, '+x', '-x'))
        part(parts, tag + '_mul_v', 'trunk', v, f, ln=True)
        v, f = box(cx, cy + s * d_mul, cz - 0.013, win, 0.02, 0.026,
                   keep=(oy, '+z'))
        part(parts, tag + '_mul_h', 'trunk', v, f, ln=True)
        # каменный подоконник: шире рамы, с выступом
        v, f = box(cx, cy + s * 0.02, cz - O - 0.045,
                   2 * O + 0.11, 0.10, 0.05,
                   keep=(oy, '+z', '-z', '+x', '-x'))
        part(parts, tag + '_sill', 'stone', v, f, ln=True, jit=0.003,
             seed=300 + (len(tag) * 7) % 60)
        if shutters:
            sgx = 1 if cx > 0 else -1
            v, f = box(cx + sgx * (O + 0.115), cy + s * 0.055, cz - half - 0.04,
                       0.21, 0.035, 2 * O - 0.02,
                       rz=math.radians(-s * sgx * 10.0),
                       keep=(oy, '+z', ('+x' if sgx > 0 else '-x')))
            part(parts, tag + '_shut', 'trunk', v, f, ln=True, jit=0.003, seed=311)
    else:                                   # стена по Y, нормаль по X
        s = 1.0 if nx > 0 else -1.0
        ox = '+x' if s > 0 else '-x'
        xc = cx + s * dc
        for sgy in (1, -1):
            v, f = box(xc, cy + sgy * (half + fw / 2.0), cz - O, t, fw, 2 * O,
                       keep=(ox, '+y', '-y'))
            part(parts, tag + '_fr_%d' % sgy, 'trunk', v, f, ln=True)
        v, f = box(xc, cy, cz + half, t, win + 0.01, fw, keep=(ox, '-z', '+z'))
        part(parts, tag + '_fr_t', 'trunk', v, f, ln=True)
        v, f = box(xc, cy, cz - half - fw, t, win + 0.01, fw, keep=(ox, '+z', '-z'))
        part(parts, tag + '_fr_b', 'trunk', v, f, ln=True)
        v, f = box(cx + s * d_glass, cy, cz - half, 0.012, win, win,
                   keep=(ox,))
        part(parts, tag + '_glass', 'iron', v, f, ln=True)
        v, f = box(cx + s * d_mul, cy, cz - half, 0.02, 0.026, win,
                   keep=(ox, '+y', '-y'))
        part(parts, tag + '_mul_v', 'trunk', v, f, ln=True)
        v, f = box(cx + s * d_mul, cy, cz - 0.013, 0.02, win, 0.026,
                   keep=(ox, '+z'))
        part(parts, tag + '_mul_h', 'trunk', v, f, ln=True)
        v, f = box(cx + s * 0.02, cy, cz - O - 0.045,
                   0.10, 2 * O + 0.11, 0.05,
                   keep=(ox, '+z', '-z', '+y', '-y'))
        part(parts, tag + '_sill', 'stone', v, f, ln=True, jit=0.003,
             seed=300 + (len(tag) * 7) % 60)


def build_door(parts):
    """Дверь: тёмный проём, косяк, полотно из трёх досок, ручка, порог, навес."""
    y = HY
    half = DOOR_W / 2.0
    top = WALL_Z0 + DOOR_H
    # проём: чуть шире полотна, чтобы косяк его перекрывал без щели
    v, f = box(0.0, y + 0.012, WALL_Z0 + 0.005, DOOR_W + 0.02, 0.014, DOOR_H - 0.01,
               keep=('+y', '+x', '-x', '+z'))
    part(parts, 'door_hole', 'leather', v, f, ln=True)
    for sgx in (1, -1):
        v, f = box(sgx * (half + 0.028), y + 0.03, WALL_Z0 - 0.01, 0.055, 0.06,
                   DOOR_H + 0.04, keep=('+y', '+x', '-x'))
        part(parts, 'door_jamb%d' % sgx, 'trunk', v, f, ln=True)
    # полотно: три доски с разной глубиной (дощатость), верх — под ригель
    for i, (dx, dep) in enumerate(((-0.107, 0.020), (0.0, 0.012), (0.107, 0.024))):
        v, f = box(dx, y + dep, WALL_Z0 + 0.012, 0.101, 0.03, DOOR_H - 0.02,
                   keep=('+y', ('+x' if dx > 0 else ('-x' if dx < 0 else '+x')), '+z'))
        part(parts, 'door_leaf%d' % i, 'trunk', v, f, ln=True, jit=0.003, seed=330 + i)
    v, f = box(0.10, y + 0.05, WALL_Z0 + 0.38, 0.055, 0.035, 0.055,
               keep=('+y', '+z', '-z', '+x'))
    part(parts, 'door_handle', 'leather', v, f, ln=True)
    # порог и ступень
    v, f = box(0.0, y + 0.06, 0.0, 0.46, 0.18, 0.075, keep=('+y', '+z', '+x', '-x'))
    part(parts, 'door_step0', 'stone', v, f)
    v, f = box(0.0, y + 0.095, 0.0, 0.54, 0.17, 0.042,
               keep=('+y', '+z', '-z', '+x', '-x'))
    part(parts, 'door_step1', 'stone', v, f, jit=0.004, seed=340)
    # навес-козырёк над дверью: соломенный, как свес кровли (не доска!)
    # контур — ТРАПЕЦИЯ (в v1 он самопересекался в углу, и низ козырька
    # смотрел в небо); проверяется тестом самопересечений в xray.py
    ov, zt = 0.18, 1.30
    v, f = prism_x([(y + ov, 1.00), (y + 0.02, zt), (y + 0.02, zt - 0.085),
                    (y + ov, 0.925)], -0.43, 0.43)
    part(parts, 'canopy', 'leaf_autumn', v, f, jit=0.004, seed=342)
    v, f = bar((-0.43, y + ov - 0.02, 0.945), (0.43, y + ov - 0.02, 0.945),
               0.05, 0.05, caps=(0, 1))
    part(parts, 'canopy_edge', 'trunk', v, f)
    for sgx in (1, -1):
        v, f = bar((sgx * 0.33, y - 0.03, 0.78), (sgx * 0.33, y + 0.15, 1.00),
                   0.06, 0.055, caps=(0, 1))
        part(parts, 'canopy_brace%d' % sgx, 'trunk', v, f, ln=True)


# --------------------------------------------------------------------------
# ЯРУС 4: КРОВЛЯ — ПЛАСТЫ СОЛОМЫ
# --------------------------------------------------------------------------
def plast_bands(rng):
    """Границы пластов по скату: у карниза шире, у конька уже + дрожь."""
    w = []
    for i in range(N_PLAST):
        base = 1.0 + 0.42 * (N_PLAST - 1 - i) / (N_PLAST - 1.0)
        w.append(base * rng.uniform(0.88, 1.12))
    s = sum(w)
    bounds = [EAVE_Y]
    for wi in w:
        bounds.append(bounds[-1] - wi / s * EAVE_Y)
    bounds[-1] = 0.0
    return bounds


def build_roof(parts, rng):
    """Кровля: пласты соломы ступенями + гребень + жердь + лобовые доски.

    Тело кровли — ОДНА ЗАМКНУТАЯ призма по контуру «пилы»: пласты читаются
    ступенями (канон §6), а объём закрыт и снизу.  Разрезной вариант (пласт =
    отдельная плита) оставлял под плитами пустоту, и с низкого ракурса в неё
    было видно изнанку соломы — счётчик видимых изнанок `xray.py probe` это
    ловит, поэтому здесь только замкнутый контур.
    """
    bounds = plast_bands(rng)
    steps, tilts, mids = [], [], []
    acc = 0.0
    for i in range(N_PLAST):
        acc += rng.uniform(0.020, 0.032)
        steps.append(acc)
        tilts.append((-1.0 if i % 2 else 1.0) * rng.uniform(0.010, 0.026))
        mids.append((bounds[i] + bounds[i + 1]) / 2.0)

    def raw(i, ay):
        return z_nom(ay) + steps[i] + tilts[i] * (ay - mids[i])

    # Лобовая доска — прямая.  Солома подрезается СДВИГОМ всех ступеней вниз:
    # срез по одной грани оставил бы пласты нулевой толщины.
    z_eave, z_ridge = raw(0, EAVE_Y), raw(N_PLAST - 1, 0.0)

    def line(ay):
        return z_ridge + (z_eave - z_ridge) * (ay / EAVE_Y)

    exc = max(max(raw(i, bounds[i]) - line(bounds[i]),
                  raw(i, bounds[i + 1]) - line(bounds[i + 1]))
              for i in range(N_PLAST))
    if exc > -0.008:
        steps = [s - (exc + 0.008) for s in steps]

    def top(i, ay):
        return raw(i, ay)

    poly = [(EAVE_Y, z_under(EAVE_Y)), (EAVE_Y, top(0, EAVE_Y))]
    for i in range(1, N_PLAST):
        poly.append((bounds[i], top(i - 1, bounds[i])))
        poly.append((bounds[i], top(i, bounds[i])))
    poly.append((0.0, top(N_PLAST - 1, 0.0)))
    for i in range(N_PLAST - 1, 0, -1):
        poly.append((-bounds[i], top(i, bounds[i])))
        poly.append((-bounds[i], top(i - 1, bounds[i])))
    poly.append((-EAVE_Y, top(0, EAVE_Y)))
    poly.append((-EAVE_Y, z_under(EAVE_Y)))
    poly.append((0.0, z_under(0.0)))
    v, f = prism_x(poly, -PLANK_X, PLANK_X)
    part(parts, 'roof_plasts', 'leaf_autumn', v, f, jit=0.004, seed=401)

    # Лобовая доска по кромке щипца — ПРИЗМОЙ по тому же контуру, а не
    # бруском: у бруска сечение симметрично оси, и его нижний угол на карнизе
    # выходил выше соломы (снизу видно изнанку).  Здесь низ доски заведомо
    # УТОПЛЕН под солому, а верх идёт параллельно ей на 0.08 выше.
    for sx_ in (1, -1):
        for sg in (1, -1):
            prof = [(sg * (EAVE_Y - 0.004), line(EAVE_Y) - 0.045),
                    (sg * (EAVE_Y - 0.004), line(EAVE_Y) + 0.085),
                    (0.0, line(0.0) + 0.075), (0.0, line(0.0) - 0.05)]
            v, f = prism_x(prof, sx_ * PLANK_X, sx_ * ROOF_X)
            part(parts, 'barge_%d%d' % (sx_, sg), 'trunk', v, f)

    # оборванный край соломы по карнизу: 4 сегмента, низ неровный
    seg = (2 * PLANK_X) / 3.0
    for sy_ in (1, -1):
        for i in range(3):
            x0 = -PLANK_X + seg * i
            drop = rng.uniform(0.035, 0.08)
            ztop = z_under(EAVE_Y - 0.035) + 0.05
            v, f = box(x0 + seg / 2.0, sy_ * (EAVE_Y - 0.035),
                       ztop - drop, seg - 0.02, 0.07, drop + 0.05,
                       keep=('+y' if sy_ > 0 else '-y', '-z', '+x', '-x',
                             '-y' if sy_ > 0 else '+y'))
            part(parts, 'eave_rag_y%d_%d' % (sy_, i), 'leaf_autumn', v, f,
                 jit=0.005, seed=410 + i)
    # конёк: соломенный гребень + прижимная жердь с выпущенными концами
    ridge_z = top(N_PLAST - 1, 0.0)
    cap = [(0.19, ridge_z - 0.28), (0.0, ridge_z + 0.05), (-0.19, ridge_z - 0.28)]
    v, f = prism_x(cap, -PLANK_X - 0.05, PLANK_X + 0.05)
    part(parts, 'ridge_cap', 'leaf_autumn', v, f, jit=0.004, seed=420)
    v, f = bar((-PLANK_X - 0.03, 0.0, ridge_z + 0.075),
               (PLANK_X + 0.03, 0.0, ridge_z + 0.075), 0.05, 0.05, caps=(0, 1))
    part(parts, 'ridge_pole', 'trunk', v, f)


def build_chimney(parts, rng):
    """Каменная труба на скате (канон §7): блоки + козырёк."""
    x, y = CHIMNEY_X, CHIMNEY_Y
    z0 = 2.14
    blocks = ((0.32, 0.32, 0.17), (0.29, 0.29, 0.16), (0.26, 0.26, 0.15),
              (0.235, 0.235, 0.14))
    z = z0
    for i, (sx_, sy_, h) in enumerate(blocks):
        v, f = box(x + rng.uniform(-0.010, 0.010), y + rng.uniform(-0.010, 0.010),
                   z, sx_, sy_, h,
                   rz=math.radians(rng.uniform(-4.0, 4.0)),
                   keep=('+x', '-x', '+y', '-y', '+z'))
        part(parts, 'chimney_%d' % i, 'stone', v, f, jit=0.004, seed=430 + i)
        z += h
    v, f = box(x, y, z, 0.36, 0.36, 0.055,
               keep=('+x', '-x', '+y', '-y', '+z', '-z'))
    part(parts, 'chimney_cap', 'stone', v, f, jit=0.004, seed=436)
    v, f = box(x, y, z + 0.055, 0.20, 0.20, 0.05,
               keep=('+x', '-x', '+y', '-y', '+z'))
    part(parts, 'chimney_neck', 'stone', v, f, jit=0.004, seed=437)
    v, f = box(x, y, z + 0.105, 0.125, 0.125, 0.035, keep=('+z',))
    part(parts, 'chimney_flue', 'leather', v, f)


# --------------------------------------------------------------------------
# ЯРУС 5: ДВОР (поленница, кадка)
# --------------------------------------------------------------------------
def build_yard(parts, rng):
    """Двор: поленница у торца, кадка у крыльца. Ставится НА землю."""
    x0, y0 = -HX + 0.05, -0.42
    v, f = box(x0, y0, 0.0, 0.27, 0.50, 0.30, keep=('+x', '-x', '+y', '-y', '+z'))
    part(parts, 'wood_base', 'trunk', v, f, jit=0.005, seed=440)
    for i in range(6):
        zz = 0.07 + (i // 3) * 0.10
        yy = y0 - 0.16 + (i % 3) * 0.16
        v, f = box(x0 - 0.135, yy, zz, 0.05, 0.13, 0.13,
                   keep=('-x', '+z', '+y', '-y'))
        part(parts, 'wood_end%d' % i, 'trunk', v, f)
    for i in range(2):
        yy = y0 - 0.11 + i * 0.22
        v, f = box(x0, yy, 0.295, 0.26, 0.19, 0.155,
                   rz=math.radians(rng.uniform(-6, 6)),
                   keep=('+x', '-x', '+z', '+y', '-y'))
        part(parts, 'log_top%d' % i, 'trunk', v, f, jit=0.005, seed=445 + i)
    # кадка у крыльца
    bx, by = HX - 0.34, HY - 0.03
    poly = [(bx + math.cos(math.radians(60 * k + 30)) * 0.13,
             by + math.sin(math.radians(60 * k + 30)) * 0.13) for k in range(6)]
    r_mid = [(bx + (p[0] - bx) * 1.12, by + (p[1] - by) * 1.12) for p in poly]
    v = ([(p[0], p[1], 0.0) for p in poly] + [(p[0], p[1], 0.10) for p in poly]
         + [(p[0], p[1], 0.20) for p in r_mid] + [(p[0], p[1], 0.30) for p in poly])
    f = []
    for lvl in range(3):
        a, b = lvl * 6, (lvl + 1) * 6
        for k in range(6):
            k2 = (k + 1) % 6
            f.append((a + k, a + k2, b + k2, b + k))
    f.append(tuple(range(5, -1, -1)))       # дно
    f.append(tuple(range(18, 24)))          # верхняя крышка
    f = cull(v, f, see=SEE_ALL + ((0.0, 0.0, -1.0),))
    part(parts, 'barrel', 'trunk', v, f, jit=0.004, seed=450)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant='a', seed=7):
    """Собрать дом. Возвращает список деталей (dict name/family/verts/faces).

    Варианты:
        a — дом жителя: каркас + обмазка, солома, ставни, навес, труба, двор;
        b — тот же дом с крыльцом: стенки-выступы, настил, односкатный навес;
        c — тот же дом с высоким щипцом и слуховым окном (дом «побогаче»).
    """
    rng = random.Random(seed)
    parts = []
    build_plinth(parts, rng)
    build_walls(parts)
    build_frame(parts)
    build_window(parts, -WIN_FRONT_X, HY, WIN_Z, 0.0, 1.0, 'win_f_l', shutters=True)
    build_window(parts, WIN_FRONT_X, HY, WIN_Z, 0.0, 1.0, 'win_f_r', shutters=True)
    if variant in ('a', 'c'):
        build_window(parts, -WIN_BACK_X, -HY, WIN_Z, 0.0, -1.0, 'win_b_l')
        build_window(parts, WIN_BACK_X, -HY, WIN_Z, 0.0, -1.0, 'win_b_r')
    else:
        build_window(parts, 0.0, -HY, WIN_Z, 0.0, -1.0, 'win_b_c')
    build_window(parts, -HX, SIDE_WIN_Y, WIN_Z, -1.0, 0.0, 'win_s_l')
    build_window(parts, HX, SIDE_WIN_Y, WIN_Z, 1.0, 0.0, 'win_s_r')
    build_window(parts, -HX, 0.0, 1.90, -1.0, 0.0, 'win_g_l', size=WIN_G)
    build_window(parts, HX, 0.0, 1.90, 1.0, 0.0, 'win_g_r', size=WIN_G)
    build_door(parts)
    build_roof(parts, rng)
    build_chimney(parts, rng)
    build_yard(parts, rng)

    if variant == 'b':                      # крыльцо с навесом (внутри пятна)
        _porch(parts, rng)
    if variant == 'c':                      # чердак: лаз и приставная лестница
        _loft(parts)

    ground(parts)
    autocull(parts)
    return parts


def ground(parts):
    """Опора в (0,0,0): если дрожь утопила низ ниже нуля — приподнять всё.

    Канон: «Z вверх, опора объекта в (0,0,0), низ на z = 0». Дрожь цоколя на
    0.004..0.008 легко даёт -0.015, и дом утонул бы в карте.
    """
    lo = min(v[2] for p in parts for v in p['verts'])
    if lo < 0.0:
        for p in parts:
            p['verts'] = [(v[0], v[1], v[2] - lo) for v in p['verts']]
    return -lo if lo < 0.0 else 0.0


def _porch(parts, rng):
    """Крыльцо: две стенки-выступа, настил, односкатный навес и лавка.

    Всё ВНУТРИ пятна 3 x 2: вынос 0.20 от стены при свесе кровли 1.00 —
    крыльцо не выходит за кромку спрайта (канон: «габарит не выходит за пятно»).
    """
    y0 = HY
    d = 0.17                                   # вынос крыльца
    w = 0.44                                   # полуширина
    h = 0.66                                   # высота стенок
    for sgx in (1, -1):
        v, f = box(sgx * (w + 0.07), y0 + d / 2.0, 0.0, 0.14, d, h,
                   keep=('+y', '+x', '-x', '+z'))
        part(parts, 'porch_wall%d' % sgx, 'skin', v, f, jit=0.004, seed=470 + sgx)
    v, f = box(0.0, y0 + d / 2.0, 0.0, 2 * (w + 0.07), d, 0.10,
               keep=('+y', '+z', '-z', '+x', '-x'))
    part(parts, 'porch_floor', 'trunk', v, f, jit=0.004, seed=474)
    # навес крыльца — ОДНА плита: два слоя давали на кромке видимую изнанку
    # (тонкая красная линия в счётчике изнанок)
    v, f = prism_x([(y0 + d + 0.02, h - 0.03), (y0 - 0.03, h + 0.30),
                    (y0 - 0.03, h + 0.20), (y0 + d + 0.02, h - 0.13)],
                   -(w + 0.11), (w + 0.11), keep=('side', '-x', '+x'))
    part(parts, 'porch_roof', 'leaf_autumn', v, f, jit=0.004, seed=476)
    # лавка у стенки крыльца
    v, f = box(w - 0.02, y0 + 0.10, 0.10, 0.30, 0.13, 0.05,
               keep=('+z', '+y', '-y', '+x'))
    part(parts, 'porch_bench', 'trunk', v, f)
    for sgy in (1, -1):
        v, f = box(w - 0.02, y0 + 0.10 + sgy * 0.05, 0.0, 0.05, 0.05, 0.10,
                   keep=('+z', '+y', '-y', '+x'))
        part(parts, 'porch_leg%d' % sgy, 'trunk', v, f)


def _loft(parts):
    """Чердак варианта c: лаз в щипце и приставная лестница у торца.

    Лестница ПРИСТАВНАЯ (тетивы вертикально, ступени наружу): откинутая
    вылезает за пятно застройки, а пятно в игре — закон.
    """
    xw = -HX - FRAME_OUT
    v, f = box(xw + 0.03, 0.0, z_under(0.0) - 0.52, 0.06, 0.26, 0.22, keep=('-x',))
    part(parts, 'loft_hole', 'leather', v, f)
    for sg in (1, -1):
        v, f = bar((xw - 0.02, sg * 0.115, 0.18), (xw - 0.02, sg * 0.115, 1.50),
                   0.05, 0.05, caps=(0, 1))
        part(parts, 'ladder_rail%d' % sg, 'trunk', v, f)
    for k, h in enumerate((0.44, 0.74, 1.04, 1.34)):
        v, f = bar((xw - 0.02, -0.125, h), (xw - 0.02, 0.125, h), 0.04, 0.04,
                   caps=(0, 1))
        part(parts, 'ladder_rung%d' % k, 'trunk', v, f)
    for sgy in (1, -1):
        v, f = bar((xw + 0.02, sgy * 0.155, z_under(0.0) - 0.55),
                   (xw + 0.02, sgy * 0.155, z_under(0.0) - 0.26),
                   0.06, 0.07, caps=(0, 1))
        part(parts, 'loft_jamb%d' % sgy, 'trunk', v, f)
    v, f = bar((xw + 0.02, -0.17, z_under(0.0) - 0.23),
               (xw + 0.02, 0.17, z_under(0.0) - 0.23), 0.06, 0.07, caps=(0, 1))
    part(parts, 'loft_lintel', 'trunk', v, f)


def stats(parts):
    return dict(verts=verts_of(parts), tris=tris_of(parts), parts=len(parts))


if __name__ == '__main__':
    for var in ('a', 'b', 'c'):
        p = build(var)
        print('%-3s %s' % (var, stats(p)))
