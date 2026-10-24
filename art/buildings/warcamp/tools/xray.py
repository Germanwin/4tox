"""xray.py — софт-рендер и детектор дефектов геометрии БЕЗ Blender.

Зачем отдельный рендер, если есть Blender: итерации по форме идут десятками, и
на каждую правку гонять 12 кадров в живом Blender — это минуты. Здесь своя
ортокамера, z-буфер и плоское затенение по палитре, а главное — три
аналитических теста, которые глазом не сделать:

    изнанки   — пиксели, где первым по глубине идёт фасет, смотрящий ОТ камеры.
                Значит наружной грани тут нет и видно нутро детали: дыра;
    зазоры    — ближайший сосед детали дальше 0.01: деталь висит в воздухе;
    копланар  — совпадающие плоскости у разных деталей: z-fighting в кадре.

Счётчик изнанок — главный приём этой мастерской. Он ловит и вывернутые грани,
и выброшенные наружные фасеты, и щели, и «наполовину спрятанные» детали — всё
то, что на спрайте выглядит волосяной линией или тёмной полосой.

    $PY3 xray.py probe --gen tools/building.py
    $PY3 xray.py shot out/view.png --gen tools/building.py --az 45 --el 35 --zoom 150
    $PY3 xray.py sweep --gen tools/building.py

`--gen` — путь к генератору (чистый Python, функция build(variant=None)).
Рендер — ортокамера канона: азимут 45, подъём 35.2644, изометрия 2:1.
"""
import argparse
import importlib.util
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import forge as F
try:
    import village as V
except ImportError:                                   # чужой генератор
    V = None                                              # noqa: E402

SUN = np.array([-0.36, 0.30, 0.88])
SUN = SUN / np.linalg.norm(SUN)
AZ, EL = 45.0, 35.264389682754654          # канонная изометрия 2:1
RES_X, RES_Y = 640, 800


# --------------------------------------------------------------------------
# ИСТОЧНИК ГЕОМЕТРИИ
# --------------------------------------------------------------------------
def load_parts(path, variant=None):
    """Загрузить генератор по пути и получить список деталей.

    Ожидается функция `build(variant=None)` или `build()`.  Модуль грузится по
    файлу (а не по имени), поэтому генератор может лежать где угодно и не
    требовать __init__.py вокруг.
    """
    path = os.path.abspath(path)
    spec = importlib.util.spec_from_file_location('forge_gen', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['forge_gen'] = mod
    spec.loader.exec_module(mod)
    fn = getattr(mod, 'build', None)
    if fn is None:
        raise SystemExit('%s: нет функции build()' % path)
    try:
        return fn(variant)
    except TypeError:
        return fn()


# --------------------------------------------------------------------------
# МЕШ
# --------------------------------------------------------------------------
def mesh(parts):
    """Собрать треугольники и их атрибуты (нормали — из обхода граней)."""
    verts, tri, part, poly, fam = [], [], [], [], []
    for pi, p in enumerate(parts):
        off = len(verts)
        verts.extend([tuple(map(float, v)) for v in p['verts']])
        for fi, f in enumerate(p['faces']):
            # НЕ веер: у невыпуклого контура (пила кровли, козырёк) веер даёт
            # треугольники вне контура, и анализатор показывает несуществующие
            # изнанки.  Триангуляция — та же, что у автоотсева.
            for t in F.triangles([p['verts'][i] for i in f]):
                tri.append(tuple(off + f[i] for i in t))
                part.append(pi)
                poly.append(fi)
                fam.append(p['family'])
    V = np.asarray(verts, float)
    T = V[np.asarray(tri, int)]
    e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
    cr = np.cross(e1, e2)
    ln = np.linalg.norm(cr, axis=1)
    N = cr / np.maximum(ln, 1e-12)[:, None]
    return dict(V=V, T=T, N=N, part=np.asarray(part, int),
                poly=np.asarray(poly, int), fam=np.asarray(fam),
                area=ln / 2.0, parts=parts)


def rot_z(M, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    R = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    out = dict(M)
    out['T'] = M['T'] @ R.T
    out['N'] = M['N'] @ R.T
    out['V'] = M['V'] @ R.T
    return out


def cam_basis(az_deg, el_deg):
    """Ортокамера канона: взгляд из (-cos el cos az, cos el sin az, sin el)."""
    az, el = math.radians(az_deg), math.radians(el_deg)
    eye = np.array([-math.cos(el) * math.cos(az), math.cos(el) * math.sin(az),
                    math.sin(el)])
    f = -eye
    r = np.cross(np.array([0.0, 0.0, 1.0]), f)
    r = r / np.linalg.norm(r)
    u = np.cross(f, r)
    return dict(eye=eye, f=f, r=r, u=u)


def flat_rgb(M, palette=None):
    """(m,3) sRGB 0..1 на треугольник: краска зоны + затенение по нормали.

    Лагерь красится ЗОНАМИ ПАЛИТРЫ РАТУШИ (`tools/village.py`) — один материал
    на зону, затенение естественное, как у ратуши.  Поэтому здесь два случая:

    * зона деревни — цвет = краска ратуши, умноженная на затенение
      (`village.preview_rgb`); это ПРЕДПРОСМОТР без Blender, нужный, чтобы
      посмотреть силуэт и изнанки, а не чтобы утверждать цвет;
    * семейство атласа природы — прежний путь: тон из палитры скилла по
      нормали (оставлен для чужих генераторов, которые ещё зовут `xray`).
    """
    P = palette or F.Palette()
    b = np.clip(M['N'] @ SUN, 0.0, None) + 0.15
    out = np.zeros((len(M['T']), 3))
    for fam in set(M['fam'].tolist()):
        sel = M['fam'] == fam
        if V is not None and fam in V.ZONES:
            out[sel] = np.stack([np.array(V.preview_rgb(fam, n))
                                 for n in M['N'][sel]])
            continue
        light, mid = P.thresholds(fam)
        tones = [np.array(P.hex_rgb(t)) / 255.0 for t in P.tones(fam)]
        bb = b[sel]
        t = np.where(bb >= light, 0, np.where(bb >= mid, 1, 2))
        out[sel] = np.stack([tones[int(x)] for x in t])
    return out


# --------------------------------------------------------------------------
# РЕНДЕР
# --------------------------------------------------------------------------
def render(M, W=RES_X, Hh=RES_Y, az=AZ, el=EL, scale=80.0,
           center=(0.0, 0.0, 1.4), mode='sprite', palette=None, rgba=None):
    """Ортокамера + z-буфер. mode: sprite | id | back | normal | depth."""
    cb = cam_basis(az, el)
    center = np.asarray(center, float)
    P = M['T'].reshape(-1, 3)
    sx = ((P @ cb['r'] - center @ cb['r']) * scale + W / 2.0).reshape(-1, 3)
    sy = (Hh / 2.0 - (P @ cb['u'] - center @ cb['u']) * scale).reshape(-1, 3)
    dep = (P @ cb['eye'] - center @ cb['eye']).reshape(-1, 3)
    front = M['N'] @ cb['eye']

    if mode == 'sprite':
        col = flat_rgb(M, palette) if rgba is None else rgba
    elif mode == 'normal':
        col = M['N'] * 0.5 + 0.5
    elif mode == 'back':
        col = np.where(front[:, None] < 0.0, np.array([1.0, 0.0, 0.0]),
                       np.array([0.55, 0.55, 0.55]))
    elif mode == 'depth':
        d = dep.mean(axis=1)
        col = np.clip((d - d.min()) / max(1e-9, np.ptp(d)), 0, 1)[:, None] * \
            np.array([[0.2, 0.4, 0.9]]) + 0.1
    else:
        rng = np.random.RandomState(3)
        col = (rng.rand(len(M['parts']), 3) * 0.7 + 0.3)[M['part']]

    img = np.ones((Hh, W, 3)) * 0.13
    zbuf = np.full((Hh, W), -1e9)
    idbuf = np.full((Hh, W), -1, int)
    area2 = ((sx[:, 1] - sx[:, 0]) * (sy[:, 2] - sy[:, 0])
             - (sx[:, 2] - sx[:, 0]) * (sy[:, 1] - sy[:, 0]))
    for i in range(len(M['T'])):
        if abs(area2[i]) < 1e-9:
            continue
        x0 = max(0, int(math.floor(sx[i].min())))
        x1 = min(W - 1, int(math.ceil(sx[i].max())))
        y0 = max(0, int(math.floor(sy[i].min())))
        y1 = min(Hh - 1, int(math.ceil(sy[i].max())))
        if x1 < x0 or y1 < y0:
            continue
        xs = np.arange(x0, x1 + 1) + 0.5
        ys = np.arange(y0, y1 + 1) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        w0 = ((sx[i, 1] - gx) * (sy[i, 2] - gy)
              - (sx[i, 2] - gx) * (sy[i, 1] - gy)) / area2[i]
        w1 = ((sx[i, 2] - gx) * (sy[i, 0] - gy)
              - (sx[i, 0] - gx) * (sy[i, 2] - gy)) / area2[i]
        w2 = 1.0 - w0 - w1
        ins = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        if not ins.any():
            continue
        d = w0 * dep[i, 0] + w1 * dep[i, 1] + w2 * dep[i, 2]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        m = ins & (d > sub)
        if not m.any():
            continue
        sub[m] = d[m]
        img[y0:y1 + 1, x0:x1 + 1][m] = col[i]
        idbuf[y0:y1 + 1, x0:x1 + 1][m] = i
    return dict(img=img, id=idbuf, zbuf=zbuf, basis=cb)


def save_png(path, img):
    from PIL import Image
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    a = np.clip(img, 0, 1)
    Image.fromarray((a * 255 + 0.5).astype(np.uint8)).save(path)
    return path


# --------------------------------------------------------------------------
# ДЕФЕКТЫ
# --------------------------------------------------------------------------
VIEWS = ((45.0, EL), (135.0, EL), (225.0, EL), (315.0, EL),
         (45.0, 8.0), (45.0, -25.0))


def backfaces(M, views=VIEWS, W=560, Hh=660, scale=120.0, center=(0, 0, 1.45)):
    """Пиксели, где первым по глубине идёт фасет, смотрящий ОТ камеры.

    Такой пиксель означает: наружной грани тут нет, видно нутро детали.
    Возвращает dict имя детали -> {'px': n, 'views': [...]}.
    """
    bad = {}
    for az, el in views:
        R = render(M, W=W, Hh=Hh, az=az, el=el, scale=scale,
                   center=center, mode='back')
        red = (R['img'][:, :, 0] > 0.9) & (R['img'][:, :, 1] < 0.1)
        ids = R['id'][red]
        for i in np.unique(ids):
            if i < 0:
                continue
            name = M['parts'][int(M['part'][i])]['name']
            d = bad.setdefault(name, {'px': 0, 'views': []})
            d['px'] += int((ids == i).sum())
            d['views'].append('%g/%g' % (az, el))
    return bad


def sweep(M, az_step=45, elevs=(-15.0, 15.0, EL, 60.0), W=560, Hh=660,
          scale=120.0, center=(0, 0, 1.45), noisy=200):
    """Плотная сетка ракурсов: сколько изнанок на худшем кадре и по деталям.

    Шесть канонных видов не доказывают отсутствие дыр: дыра может быть видна
    ровно с одного азимута.  Для приёмки гоняем 8 x 4 = 32 ракурса.
    """
    tot, worst, worst_at = {}, 0, None
    for az in range(0, 360, az_step):
        for el in elevs:
            R = render(M, W=W, Hh=Hh, az=float(az), el=el, scale=scale,
                       center=center, mode='back')
            red = (R['img'][:, :, 0] > 0.9) & (R['img'][:, :, 1] < 0.1)
            n = int(red.sum())
            if n > worst:
                worst, worst_at = n, (az, el)
            ids = R['id'][red]
            for i in np.unique(ids):
                if i < 0:
                    continue
                name = M['parts'][int(M['part'][i])]['name']
                tot[name] = tot.get(name, 0) + int((ids == i).sum())
    noisy_parts = {k: v for k, v in tot.items() if v > noisy}
    return dict(worst=worst, worst_at=worst_at, per_part=tot,
                noisy=noisy_parts, frames=len(range(0, 360, az_step)) * len(elevs))


def _pt_tri(P, T):
    """Матрица расстояний от точек P (m,3) до треугольников T (n,3,3)."""
    A, B, C = T[:, 0], T[:, 1], T[:, 2]
    ab, ac = B - A, C - A
    d00 = np.einsum('ij,ij->i', ab, ab)
    d01 = np.einsum('ij,ij->i', ab, ac)
    d11 = np.einsum('ij,ij->i', ac, ac)
    den = np.maximum(d00 * d11 - d01 * d01, 1e-14)
    out = np.full((len(P), len(T)), 1e9)
    for k in range(len(T)):
        ap = P - A[k]
        d20 = ap @ ab[k]
        d21 = ap @ ac[k]
        v = (d11[k] * d20 - d01[k] * d21) / den[k]
        w = (d00[k] * d21 - d01[k] * d20) / den[k]
        u = 1.0 - v - w
        proj = A[k] + v[:, None] * ab[k] + w[:, None] * ac[k]
        d = np.linalg.norm(P - proj, axis=1)
        inside = (u >= 0) & (v >= 0) & (w >= 0)
        for e0, e1 in ((A[k], B[k]), (B[k], C[k]), (C[k], A[k])):
            e = e1 - e0
            t = np.clip(((P - e0) @ e) / max(1e-12, float(e @ e)), 0.0, 1.0)
            d = np.minimum(d, np.linalg.norm(P - (e0 + t[:, None] * e), axis=1))
        out[:, k] = np.where(inside, np.linalg.norm(P - proj, axis=1), d)
    return out


def gaps(M, max_gap=0.03):
    """Детали, у которых рядом НЕТ соседа: висящие в воздухе.

    Канон требует ставить декор на землю или вплотную к стене, а брусок —
    доводить до стойки: висящий в воздухе предмет в изометрии читается ошибкой.
    Проверка честная только для деталей, которые должны к чему-то крепиться,
    поэтому результат читается глазами: в списке нормально видеть конёк, жердь
    и лобовые доски (они висят над кровлей по замыслу).
    """
    parts, tris_of = M['parts'], {}
    for j in range(len(M['T'])):
        tris_of.setdefault(int(M['part'][j]), []).append(j)
    boxes = []
    for p in parts:
        v = np.array(p['verts'])
        boxes.append((v.min(axis=0), v.max(axis=0)))
    out = []
    for i, p in enumerate(parts):
        P = np.array(p['verts'])
        lo_i, hi_i = boxes[i]
        best, who = 1e9, None
        for j in range(len(parts)):
            if i == j:
                continue
            lo, hi = boxes[j]
            corner = np.maximum(0.0, np.maximum(lo_i - hi, lo - hi_i))
            if float(np.linalg.norm(corner)) > max_gap:
                continue
            Tj = M['T'][tris_of.get(j, [])]
            if not len(Tj):
                continue
            d = float(_pt_tri(P, Tj).min())
            if d < best:
                best, who = d, parts[j]['name']
        if best > max_gap:
            out.append(dict(name=p['name'], gap=round(best, 4), to=who))
    return sorted(out, key=lambda x: -x['gap'])


def coplanar(M, eps=2e-3, min_area=4e-4, min_frac=0.05):
    """Пары полигонов РАЗНЫХ деталей в одной плоскости с перекрытием.

    Читать так: `frac` — какая доля меньшего фасета лежит в перекрытии.
    Доли в единицы процентов — это СТЫК: тела деталей пересекаются, фасеты
    утоплены друг в друга, и мерцания в кадре нет (типичный случай — нахлёст
    рядов дранки).  Тревога — когда совпадают целые фасеты (`frac` близко к 1):
    тогда две поверхности дерутся за один пиксель.
    """
    polys, tris_of_poly = [], {}
    seen = set()
    for i in range(len(M['T'])):
        key = (int(M['part'][i]), int(M['poly'][i]))
        tris_of_poly.setdefault(key, []).append(i)
        if key in seen:
            continue
        seen.add(key)
        polys.append((key, M['N'][i], float(M['N'][i] @ M['T'][i, 0])))
    plane = {k: (n, d) for k, n, d in polys}
    box = {}
    for k, tri in tris_of_poly.items():
        pts = M['T'][tri].reshape(-1, 3)
        box[k] = (pts.min(axis=0), pts.max(axis=0), tri)
    keys = list(box)
    out = []
    for a in range(len(keys)):
        ka = keys[a]
        na, da = plane[ka]
        for b in range(a + 1, len(keys)):
            kb = keys[b]
            if ka[0] == kb[0]:
                continue
            nb, db = plane[kb]
            if abs(abs(float(na @ nb)) - 1.0) > 1e-3:
                continue
            if na @ nb < 0:
                db = -db
            if abs(da - db) > eps:
                continue
            lo = np.maximum(box[ka][0], box[kb][0])
            hi = np.minimum(box[ka][1], box[kb][1])
            if np.prod(np.maximum(0.0, hi - lo)) <= 0:
                continue
            ar = min(M['area'][box[ka][2]].sum(), M['area'][box[kb][2]].sum())
            if ar < min_area:
                continue
            # Доля ПЕРЕКРЫТИЯ в плоскости фасета, а не факт пересечения
            # габаритов: соседние доски в одном ряду лежат в одной плоскости,
            # но перекрытия у них нет — это стык, а не z-fighting.  Тревога
            # только если фасеты реально накладываются друг на друга.
            axis = int(np.argmax(np.abs(na)))
            keep_ax = [i for i in range(3) if i != axis]
            def span(keys):
                pts = M['T'][box[keys][2]].reshape(-1, 3)
                return (pts[:, keep_ax].min(axis=0), pts[:, keep_ax].max(axis=0))
            la, ha = span(ka)
            lb, hb = span(kb)
            ov = np.prod(np.maximum(0.0, np.minimum(ha, hb) - np.maximum(la, lb)))
            frac = ov / max(1e-9, ar)
            if frac < min_frac:
                continue
            out.append(dict(a=M['parts'][ka[0]]['name'],
                            b=M['parts'][kb[0]]['name'], area=round(float(ar), 6),
                            overlap=round(float(ov), 6), frac=round(float(frac), 3)))
    return out


def report(parts, views=VIEWS, do_sweep=False, do_coplanar=True):
    """Текстовый отчёт по дефектам сборки (то же, что печатает `probe`)."""
    M = mesh(parts)
    lines = ['деталей %d, трис %d, вершин %d'
             % (len(parts), len(M['T']), len(M['V']))]
    lines.append('габарит X %.3f..%.3f  Y %.3f..%.3f  Z %.3f..%.3f'
                 % (M['V'][:, 0].min(), M['V'][:, 0].max(),
                    M['V'][:, 1].min(), M['V'][:, 1].max(),
                    M['V'][:, 2].min(), M['V'][:, 2].max()))
    bad = backfaces(M, views)
    lines.append('')
    lines.append('== ВИДИМЫЕ ИЗНАНКИ (дыры), 6 канонных видов ==')
    if not bad:
        lines.append('  нет')
    for k, v in sorted(bad.items(), key=lambda kv: -kv[1]['px']):
        lines.append('  %-20s %6d px' % (k, v['px']))
    if do_sweep:
        sw = sweep(M)
        lines.append('')
        lines.append('== СЕТКА РАКУРСОВ (%d кадров) ==' % sw['frames'])
        lines.append('  худший кадр %d px %s' % (sw['worst'], sw['worst_at'] or ''))
        for k, v in sorted(sw['noisy'].items(), key=lambda kv: -kv[1]):
            lines.append('  %-20s %6d px суммарно' % (k, v))
        if not sw['noisy']:
            lines.append('  ни одна деталь не превысила порог шума')
    gp = gaps(M)
    lines.append('')
    lines.append('== ВИСЯЩИЕ ДЕТАЛИ (нет соседа ближе 0.03) ==')
    if not gp:
        lines.append('  нет')
    for x in gp[:10]:
        lines.append('  %-20s зазор %.4f' % (x['name'], x['gap']))
    if do_coplanar:
        cp = coplanar(M)
        lines.append('')
        lines.append('== Z-FIGHTING (совпадающие плоскости разных деталей) ==')
        if not cp:
            lines.append('  нет')
        lines.append('  (frac — доля меньшего фасета в перекрытии; единицы'
                     ' процентов = стык, ~1.0 = мерцание)')
        for c in sorted(cp, key=lambda c: -c.get('frac', 0))[:15]:
            lines.append('  %-18s <-> %-18s доля %.2f площадь %.4f'
                         % (c['a'], c['b'], c.get('frac', 0), c['area']))
        if len(cp) > 15:
            lines.append('  ... всего %d пар' % len(cp))
    return '\n'.join(lines), M


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description='анализ геометрии постройки')
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('probe', 'shot', 'sweep'):
        sp = sub.add_parser(name)
        if name == 'shot':
            sp.add_argument('png')
        sp.add_argument('--gen', required=True, help='путь к генератору')
        sp.add_argument('--variant', default=None)
        sp.add_argument('--az', type=float, default=AZ)
        sp.add_argument('--el', type=float, default=EL)
        sp.add_argument('--zoom', type=float, default=150.0, help='пикселей на юнит')
        sp.add_argument('--res', default='700,620')
        sp.add_argument('--center', default='0,0,1.45')
        sp.add_argument('--mode', default='sprite')
        if name == 'probe':
            sp.add_argument('--full', action='store_true',
                            help='плюс сетка 32 ракурсов')
            sp.add_argument('--save', default=None)
    args = ap.parse_args()

    if args.cmd == 'probe':
        parts = load_parts(args.gen, args.variant)
        text, _ = report(parts, do_sweep=args.full)
        print(text)
        if args.save:
            with open(args.save, 'w', encoding='utf-8') as f:
                f.write(text + '\n')
            print('\n-> %s' % args.save)
        return
    parts = load_parts(args.gen, args.variant)
    if args.cmd == 'sweep':
        M = mesh(parts)
        sw = sweep(M)
        print('кадров %d, худший %d px %s'
              % (sw['frames'], sw['worst'], sw['worst_at'] or ''))
        for k, v in sorted(sw['per_part'].items(), key=lambda kv: -kv[1])[:12]:
            print('   %-20s %6d px' % (k, v))
        return
    W, Hh = [int(x) for x in args.res.split(',')]
    cx, cy, cz = [float(x) for x in args.center.split(',')]
    M = mesh(parts)
    R = render(M, W=W, Hh=Hh, az=args.az, el=args.el, scale=args.zoom,
               center=(cx, cy, cz), mode=args.mode)
    print('-> %s' % save_png(args.png, R['img']))


if __name__ == '__main__':
    main()
