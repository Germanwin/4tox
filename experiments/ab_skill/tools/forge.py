"""forge.py — библиотека геометрии построек для 4tox/mapgen2. Чистый Python.

Здесь только то, что повторяется от постройки к постройке:
    * примитивы (короб, призма вдоль X, брусок по двум точкам);
    * отсев невидимых фасетов — по сторонам обзора (`cull`) и геометрически
      (`autocull`: фасет закрыт соседом или утоплен внутрь него);
    * триангуляция невыпуклых контуров (ear clipping) — ею же пользуется
      анализатор, чтобы не показывать несуществующие дыры;
    * палитра атласа (семейство -> три тона + пороги тонов по нормали);
    * раскладка стены: брусок каркаса и рама окна как КОЛЬЦО.

Никакого bpy и никаких зависимостей: файл одинаково работает в Blender,
в bundled-python DSH и просто в интерпретаторе. Анализатор дефектов
(`xray.py`) и приёмка (`canon.py`) лежат рядом и numpy/Pillow требуют.

КОНТРАКТ ДЕТАЛИ.  Деталь — dict(name, family, verts, faces):
    name   — имя для отчётов (одинаковые имена группируются);
    family — семейство палитры атласа (тон считается по нормали уже в Blender);
    verts  — список (x, y, z), z вверх, 1 юнит = 1 клетка карты;
    faces  — список кортежей индексов, обход даёт нормаль НАРУЖУ.

ПОРЯДОК РАБОТЫ, который эта библиотека подразумевает:
    1) генератор в чистом Python собирает список деталей (см. templates/building.py);
    2) `autocull` выбрасывает всё, что не видно, ОДИН раз в конце сборки;
    3) `scripts/xray.py probe` доказывает, что видимых изнанок не осталось;
    4) `scripts/canon.py` проверяет канонные пропорции и бюджет;
    5) `scripts/live.py` собирает то же самое в живом Blender и рендерит спрайт.

ПОЧЕМУ ТАК.  Геометрия отдельно от Blender — потому что форму нужно уметь
мерить и повторять: сборка в Blender это способ ПОКАЗАТЬ, а не способ думать.
Отсев отдельным проходом — потому что «какие грани видны» решается геометрией
(луч, тест точки внутри), а не догадками автора в момент написания детали.
"""
import math
import random

# --------------------------------------------------------------------------
# СТОРОНЫ ОБЗОРА
# --------------------------------------------------------------------------
FACES_ALL = ('+x', '-x', '+y', '-y', '+z', '-z')
# Четыре поворота спрайта + вид сверху. Всё, что не смотрит ни в одну из этих
# сторон, в кадр не попадает — но выбрасывать это должен `autocull`, а не
# ручной `keep`: ручной отсев ошибается на косых лучах (см. references/pitfalls).
SEE_ALL = ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0), (0.0, -1.0, 0.0),
           (1.0, 0.0, 0.0), (-1.0, 0.0, 0.0))
SEE_SPRITE = SEE_ALL
WALL_NORMAL = {'+x': (1.0, 0.0, 0.0), '-x': (-1.0, 0.0, 0.0),
               '+y': (0.0, 1.0, 0.0), '-y': (0.0, -1.0, 0.0)}


def _norm(v):
    d = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    return (v[0] / d, v[1] / d, v[2] / d)


def face_normal(verts, f):
    """Нормаль фасета по обходу. Наружу — если обход задан правильно."""
    p = [verts[i] for i in f]
    a = (p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2])
    b = (p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2])
    return _norm((a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                  a[0] * b[1] - a[1] * b[0]))


# --------------------------------------------------------------------------
# ПРИМИТИВЫ
# --------------------------------------------------------------------------
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

    `keep` — какие грани оставить ('+x', '-y', ...); None — все шесть.
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

    Контур можно задавать в любом обходе: ориентация выправляется знаком
    площади. `keep` — 'side' (все боковины), '-x', '+x' (торцы).
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


def bar(p0, p1, sx, sy, see=(), caps=(), over=0.0):
    """Брусок из p0 в p1 (p0/p1 — центры торцов), сечение sx (поперёк) x sy.

    Ось — от p0 к p1.  Для наклонных элементов (раскосы, жерди, лобовые доски)
    это единственный способ задать их одной строкой и без ошибок.

    `see`  — направления, С КАКИХ СТОРОН брусок видно (обычно нормаль стены и
             «верх»): остаются боковины, смотрящие в них.  Пустой `see` —
             оставить ВСЕ боковины (иначе от бруска останутся два торца, то
             есть полая труба: на эти грабли наступали).
    `caps` — какие торцы оставить (0 — у p0, 1 — у p1).  Торец, воткнутый в
             стойку, оставлять не нужно — `autocull` его потом выбросит.
    `over` — удлинить брусок с обоих концов: им раскос ЗАВОДЯТ в стойку,
             чтобы стык был стыком, а не «почти достал».
    """
    ax = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    ln = math.sqrt(ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2)
    w = _norm(ax)
    ref = (0.0, 0.0, 1.0) if abs(w[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = _norm((w[1] * ref[2] - w[2] * ref[1],
               w[2] * ref[0] - w[0] * ref[2],
               w[0] * ref[1] - w[1] * ref[0]))
    v = (w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2],
         w[0] * u[1] - w[1] * u[0])
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
        idx.extend((2, 3, 4, 5))
    faces = [all_faces[i] for i in sorted(set(idx))]
    return verts, faces


# --------------------------------------------------------------------------
# ОТСЕВ: СНАЧАЛА ПО СТОРОНАМ ОБЗОРА, ПОТОМ ГЕОМЕТРИЧЕСКИ
# --------------------------------------------------------------------------
def cull(verts, faces, see=SEE_ALL, min_dot=0.12):
    """Оставить фасеты, смотрящие хотя бы в одну из сторон `see`."""
    out = []
    for f in faces:
        n = face_normal(verts, f)
        if any(n[0] * s[0] + n[1] * s[1] + n[2] * s[2] > min_dot for s in see):
            out.append(f)
    return out


def triangles(pts):
    """Триангуляция полигона (ear clipping) с сохранением обхода.

    Веер годится только для выпуклых контуров: у пилы кровли или у козырька он
    даёт треугольники ВНЕ контура, и всё, что на них смотрит — автоотсев,
    анализатор, счётчик изнанок — начинает врать.  Поэтому один честный
    алгоритм на всю библиотеку.
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
        for k in range(1, len(idx) - 1):      # неплоский контур — добиваем веером
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


class Grid(object):
    """Равномерная сетка треугольников: автоотсев не должен быть O(n*m)."""

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
            out.update(self.d.get((int(q[0] // cell), int(q[1] // cell),
                                   int(q[2] // cell)), ()))
        return out


def is_closed(part):
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
    наружу через дальнюю стенку и «закрытым» не считается — без этого у блока
    цоколя оставались все шесть граней (240 трис на ровном месте).

    Фасет выбрасывается, только если закрыты ВСЕ его пробные точки: центр и
    углы, поджатые к центру на 7%.  Иначе в оболочке осталась бы дыра там, где
    фасет спрятан наполовину — а такая дыра видна с косого луча.

    Вызывать ОДИН раз, в самом конце сборки: до него детали ещё не на своём
    месте (наклон стены, подъём над землёй), после — геометрия заморожена.
    """
    tris, owner = [], []
    for pi, p in enumerate(parts):
        v = p['verts']
        for f in p['faces']:
            for t in triangles([v[i] for i in f]):
                tris.append((v[f[t[0]]], v[f[t[1]]], v[f[t[2]]]))
                owner.append(pi)
    grid = Grid(tris)

    boxes, closed = [], []
    for p in parts:
        v = p['verts']
        boxes.append(([min(q[i] for q in v) for i in range(3)],
                      [max(q[i] for q in v) for i in range(3)]))
        closed.append(is_closed(p))
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
            n = face_normal(v, f)
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


# --------------------------------------------------------------------------
# ДЕТАЛИ, ДРОЖЬ, НАКЛОН СТЕНЫ
# --------------------------------------------------------------------------
def jitter(verts, amount, seed, axis=None):
    """Дрожь вершин: «глина», а не линейка. Держать в пределах 0.003..0.008.

    Больше — и стена начнёт пробивать прибитые к ней окна: запас между
    поверхностью стены и стеклом рамы всего 0.02.
    """
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


def part(parts, name, family, verts, faces, jit=0.0, seed=0, lean=None):
    """Добавить деталь в сборку. `lean` — функция прижатия к наклонной стене."""
    if lean is not None:
        verts = lean(verts)
    if jit:
        verts = jitter(verts, jit, seed)
    parts.append(dict(name=name, family=family, verts=verts, faces=faces))
    return parts


def wall_lean(z0, height, tan_lean):
    """Наклон стены: ВЕРХ — НОМИНАЛ, низ уходит внутрь на tan_lean.

    Возвращает функцию для `part(..., lean=...)`.  Почему именно так: если
    наклонять объём стены «вокруг середины», её верх становится ШИРЕ номинала,
    и всё, что стоит на стене (обвязка, щипец, кровля), начинает пробивать
    скат — щели по карнизу.  Номинал сверху = всё, что выше стены, считается
    по прямоугольнику и сходится без зазоров.
    """
    tan_lean = abs(tan_lean)

    def k(z):
        t = (z - z0) / float(height)
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        return 1.0 - (1.0 - t) * tan_lean

    def lean(verts):
        return [(v[0] * k(v[2]), v[1] * k(v[2]), v[2]) for v in verts]

    lean.k = k
    return lean


def ground(parts):
    """Опора в (0, 0, 0): если дрожь утопила низ ниже нуля — приподнять всё."""
    lo = min(v[2] for p in parts for v in p['verts'])
    if lo < 0.0:
        for p in parts:
            p['verts'] = [(v[0], v[1], v[2] - lo) for v in p['verts']]
    return -lo if lo < 0.0 else 0.0


def tris_of(parts):
    return sum(sum(len(f) - 2 for f in p['faces']) for p in parts)


def stats(parts):
    return dict(parts=len(parts), verts=sum(len(p['verts']) for p in parts),
                tris=tris_of(parts))


def census(parts):
    """Сколько трис в каждой группе деталей (имя без цифр) — для бюджета."""
    import collections
    import re
    g = collections.Counter()
    for p in parts:
        key = re.sub(r'[-+]?\d+', '#', p['name']).rstrip('_#')
        g[key] += sum(len(f) - 2 for f in p['faces'])
    return g


# --------------------------------------------------------------------------
# РАСКЛАДКА: БРУСОК НА СТЕНЕ И РАМА ОКНА
# --------------------------------------------------------------------------
def wall_faces(wall):
    """(наружная грань, первая вдоль стены, вторая вдоль стены)."""
    return {'+y': ('+y', '+x', '-x'), '-y': ('-y', '+x', '-x'),
            '+x': ('+x', '+y', '-y'), '-x': ('-x', '+y', '-y')}[wall]


def stick(parts, name, wall, plane, a0, a1, z0, z1, t=0.10, out=0.05,
          faces=('out', 'top'), fam='trunk', lean=None, jit=0.0, seed=0):
    """Брусок каркаса НА стене — обвязка, стойка, ригель, раскос-«коробкой».

    wall  — нормаль стены ('+y', '-x', ...); plane — координата НАРУЖНОЙ
            плоскости стены (номинал, до наклона);
    a0..a1 — вдоль стены (x для стен +-y, y для стен +-x);
    z0..z1 — по высоте; t — толщина бруса, out — выступ за плоскость стены.
    faces — какие грани оставить: out / top / bot / s1 / s2 (s1, s2 — вдоль).

    Брус встаёт наружной гранью на `out` от плоскости стены и уходит внутрь на
    t - out: каркас в одной плоскости со стеной в изометрии не читается.
    """
    o, s1, s2 = wall_faces(wall)
    keep = tuple({'out': o, 'top': '+z', 'bot': '-z', 's1': s1, 's2': s2}[k]
                 for k in faces)
    if wall in ('+y', '-y'):
        sgn = 1.0 if wall == '+y' else -1.0
        cx, cy = (a0 + a1) / 2.0, sgn * (plane + out - t / 2.0)
        sx, sy = abs(a1 - a0), t
    else:
        sgn = 1.0 if wall == '+x' else -1.0
        cx, cy = sgn * (plane + out - t / 2.0), (a0 + a1) / 2.0
        sx, sy = t, abs(a1 - a0)
    v, f = box(cx, cy, z0, sx, sy, z1 - z0, keep=keep)
    return part(parts, name, fam, v, f, jit=jit, seed=seed, lean=lean)


def window(parts, tag, wall, plane, a_center, z_center, size=0.28, fw=0.05,
           out=0.05, depth=0.07, glass_in=0.032, mul_in=0.014,
           sill=True, shutters=False, fam='trunk', stone='stone',
           glass='iron', lean=None):
    """Окно как КОЛЬЦО: стойки на всю высоту, планки между ними, стекло внутри.

    Собирается из четырёх брусков, но раскладка именно кольцевая: планки
    заходят в стойки на 5 мм, поэтому в углах рамы нет ни щели, ни совпадающих
    плоскостей.  Глубины считаются от плоскости стены одной формулой —
    наружная плоскость рамы `out`, стекло `out - glass_in`, переплёт
    `out - mul_in`; если задать их «на глаз», стекло окажется впереди рамы и
    автоотсев погасит наружную грань рамы вместе со стеклом.

    `a_center` — центр окна вдоль стены, `z_center` — по высоте.
    """
    half = size / 2.0
    O = half + fw
    o, s1, s2 = wall_faces(wall)
    sgn = 1.0 if wall in ('+y', '+x') else -1.0
    d_frame = out - depth / 2.0
    d_glass = out - glass_in
    d_mul = out - mul_in
    t = depth

    def place(a, z0, sa, sz, keep, name, fam_='trunk', jit=0.0, seed=0):
        if wall in ('+y', '-y'):
            v, f = box(a, sgn * (plane + d_frame), z0, sa, t, sz, keep=keep)
        else:
            v, f = box(sgn * (plane + d_frame), a, z0, t, sa, sz, keep=keep)
        part(parts, name, fam_, v, f, jit=jit, seed=seed, lean=lean)

    # стойки: на всю высоту наружного габарита
    for sg in (1, -1):
        place(a_center + sg * (half + fw / 2.0), z_center - O, fw, 2 * O,
              (o, s1, s2), '%s_fr_%d' % (tag, sg))
    # планки: между стойками, с заходом 5 мм внутрь каждой
    place(a_center, z_center + half, size + 0.01, fw, (o, '-z'),
          tag + '_fr_t')
    place(a_center, z_center - half - fw, size + 0.01, fw, (o, '+z'),
          tag + '_fr_b')
    # стекло и переплёт 2x2
    if wall in ('+y', '-y'):
        v, f = box(a_center, sgn * (plane + d_glass), z_center - half,
                   size, 0.012, size, keep=(o,))
        part(parts, tag + '_glass', glass, v, f, lean=lean)
        v, f = box(a_center, sgn * (plane + d_mul), z_center - half,
                   0.026, 0.02, size, keep=(o, s1, s2))
        part(parts, tag + '_mul_v', fam, v, f, lean=lean)
        v, f = box(a_center, sgn * (plane + d_mul), z_center - 0.013,
                   size, 0.02, 0.026, keep=(o, '+z'))
        part(parts, tag + '_mul_h', fam, v, f, lean=lean)
    else:
        v, f = box(sgn * (plane + d_glass), a_center, z_center - half,
                   0.012, size, size, keep=(o,))
        part(parts, tag + '_glass', glass, v, f, lean=lean)
        v, f = box(sgn * (plane + d_mul), a_center, z_center - half,
                   0.02, 0.026, size, keep=(o, s1, s2))
        part(parts, tag + '_mul_v', fam, v, f, lean=lean)
        v, f = box(sgn * (plane + d_mul), a_center, z_center - 0.013,
                   0.02, size, 0.026, keep=(o, '+z'))
        part(parts, tag + '_mul_h', fam, v, f, lean=lean)
    if sill:
        w, h, d = 2 * O + 0.11, 0.05, 0.10
        if wall in ('+y', '-y'):
            v, f = box(a_center, sgn * (plane + 0.02), z_center - O - 0.045,
                       w, d, h, keep=(o, '+z', '-z', s1, s2))
        else:
            v, f = box(sgn * (plane + 0.02), a_center, z_center - O - 0.045,
                       d, w, h, keep=(o, '+z', '-z', s1, s2))
        part(parts, tag + '_sill', stone, v, f, jit=0.003,
             seed=300 + (len(tag) * 7) % 60, lean=lean)
    if shutters:
        sg = 1.0 if a_center > 0 else -1.0
        if wall in ('+y', '-y'):
            v, f = box(a_center + sg * (O + 0.115), sgn * (plane + 0.055),
                       z_center - half - 0.04, 0.21, 0.035, 2 * O - 0.02,
                       rz=math.radians(-sgn * sg * 10.0),
                       keep=(o, '+z', ('+x' if sg > 0 else '-x')))
        else:
            v, f = box(sgn * (plane + 0.055), a_center + sg * (O + 0.115),
                       z_center - half - 0.04, 0.035, 0.21, 2 * O - 0.02,
                       rz=math.radians(sgn * sg * 10.0),
                       keep=(o, '+z', ('+y' if sg > 0 else '-y')))
        part(parts, tag + '_shut', fam, v, f, jit=0.003, seed=311, lean=lean)


# --------------------------------------------------------------------------
# ПАЛИТРА АТЛАСА
# --------------------------------------------------------------------------
class Palette(object):
    """Семейства атласа и тона: тон фасета считается ПО НОРМАЛИ в Blender.

    Источник — машинная палитра скилла `4tox-lowpoly-3d`
    (`references/palette.json`).  Если файла нет, работает встроенный
    fallback: цвета те же, но канон может уехать — тогда `check()` скажет.
    """

    SKILL_PALETTE = ('/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/'
                     'references/palette.json')
    FALLBACK_TONES = {
        'trunk':       ('#523521', '#4E321F', '#321E11'),
        'stone':       ('#798186', '#656B70', '#44484A'),
        'skin':        ('#C99464', '#A87B52', '#745437'),
        'leaf_autumn': ('#A8701F', '#895B18', '#56360B'),
        'grass':       ('#447937', '#3A682F', '#2E5424'),
        'iron':        ('#6E767C', '#636B72', '#454B50'),
        'leather':     ('#3A2614', '#2A1B0E', '#1C1108'),
    }
    FALLBACK_THRESH = dict(wood=(0.50, 0.30), stone=(0.75, 0.28),
                           leaf=(0.55, 0.32), skin=(0.52, 0.30),
                           iron=(0.75, 0.28), leather=(0.50, 0.30))
    THRESH_KEY = {'trunk': 'wood', 'stone': 'stone', 'skin': 'skin',
                  'leaf_autumn': 'leaf', 'grass': 'leaf', 'iron': 'iron',
                  'leather': 'leather'}
    FAMILIES = ('trunk', 'stone', 'skin', 'leaf_autumn', 'grass', 'iron',
                'leather')

    def __init__(self, path=None):
        import json
        import os
        self.data = None
        p = path or self.SKILL_PALETTE
        if os.path.exists(p):
            try:
                with open(p, encoding='utf-8') as f:
                    self.data = json.load(f)
            except Exception:
                self.data = None

    def tones(self, family):
        """Семейство -> (свет, средний, тень) в sRGB hex."""
        if self.data:
            t = self.data.get('tones', {}).get(family)
            if t and all(k in t for k in ('light', 'mid', 'dark')):
                return (t['light'].upper(), t['mid'].upper(), t['dark'].upper())
        return self.FALLBACK_TONES[family]

    def thresholds(self, family):
        key = self.THRESH_KEY.get(family, 'wood')
        if self.data:
            th = self.data.get('tone_thresholds', {}).get(key)
            if th:
                return (th[0], th[1])
        return self.FALLBACK_THRESH[key]

    def hex_rgb(self, tone):
        if isinstance(tone, (tuple, list)):
            return tuple(tone)
        h = str(tone).lstrip('#')
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

    def budget(self, kind='building'):
        """Канонный бюджет трис для класса объекта из палитры скилла."""
        if self.data:
            b = self.data.get('budget', {}).get(kind, {})
            if 'tris' in b:
                return tuple(b['tris'])
        return (300, 1500)

    def outline(self):
        if self.data and self.data.get('outline'):
            return self.data['outline'][0]
        return '#0E120E'

    def check(self):
        """Разошлась ли встроенная копия с палитрой скилла (пусто = всё ок)."""
        if not self.data:
            return ['файл палитры скилла не найден — работаю на встроенных цветах']
        bad = []
        for fam in self.FAMILIES:
            want = self.FALLBACK_TONES[fam]
            got = self.tones(fam)
            if tuple(got) != tuple(want):
                bad.append('%s: скилл %s, встроено %s' % (fam, got, want))
        return bad
