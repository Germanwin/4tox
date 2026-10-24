"""xray.py — диагностика геометрии дома БЕЗ Blender: софтверный рендер + детект.

Зачем: сборка в живом Blender — это способ отдать форму заказчику, но итерации
по дефектам надо делать быстро и с любого ракурса. Здесь своя ортокамера
(перспектива не нужна: спрайт канонный), z-буфер и плоское затенение по
палитре — тем же правилом «тон по нормали», что и build.py. Плюс три
аналитических теста, которые глазом не сделать:

    backfaces  — видимые ИЗВНЕ изнанки: значит у детали выброшена наружная
                 грань (или нормаль вывернута) и в модели дыра;
    coplanar   — совпадающие плоскости у РАЗНЫХ деталей: z-fighting в кадре;
    sticking   — деталь торчит наружу из той, в которую должна быть вписана
                 (стена сквозь стекло, обвязка сквозь кровлю).

Запуск:
    $PY3 tools/xray.py probe            # отчёт по дефектам варианта a
    $PY3 tools/xray.py shot out/x.png --az 45 --el 35 --zoom 3 --center 0.8,0.83,0.72
"""
import argparse
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import building as H       # noqa: E402


def _triangulate(verts, f):
    """Триангуляция фасета для анализа (у генератора фасеты уже плоские)."""
    idx = list(f)
    if len(idx) == 3:
        return [(idx[0], idx[1], idx[2])]
    return [(idx[0], idx[k], idx[k + 1]) for k in range(1, len(idx) - 1)]

import palette as PAL      # noqa: E402

SUN = np.array([-0.36, 0.30, 0.88])
SUN = SUN / np.linalg.norm(SUN)
FACES = ('+x', '-x', '+y', '-y', '+z', '-z')


# --------------------------------------------------------------------------
# МЕШ
# --------------------------------------------------------------------------

def mesh(parts):
    """Собрать треугольники и их атрибуты.

    Возвращает dict:
        V  (n,3)      вершины
        T  (m,3,3)    треугольники
        N  (m,3)      нормали (из обхода граней — как их видит Blender)
        part (m,)     индекс детали
        poly (m,)     индекс полигона внутри детали
        fam  (m,)     семейство палитры
        area (m,)
    """
    verts, tri, part, poly, fam = [], [], [], [], []
    for pi, p in enumerate(parts):
        off = len(verts)
        verts.extend([tuple(map(float, v)) for v in p['verts']])
        for fi, f in enumerate(p['faces']):
            # НЕ веер: невыпуклый контур (пила кровли, козырёк) веером режется
            # неверно, и анализатор показывал несуществующие изнанки
            for t in _triangulate(p['verts'], f):
                tri.append(tuple(off + i for i in t))
                part.append(pi)
                poly.append(fi)
                fam.append(p['family'])
    V = np.asarray(verts, float)
    T = V[np.asarray(tri, int)]
    e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
    cr = np.cross(e1, e2)
    ln = np.linalg.norm(cr, axis=1)
    N = cr / np.maximum(ln, 1e-12)[:, None]
    return dict(V=V, T=T, N=N, part=np.asarray(part, int), poly=np.asarray(poly, int),
                fam=np.asarray(fam), area=ln / 2.0, parts=parts)


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
    f = -eye                                   # из камеры в сцену
    r = np.cross(np.array([0.0, 0.0, 1.0]), f)
    r = r / np.linalg.norm(r)
    u = np.cross(f, r)
    return dict(eye=eye, f=f, r=r, u=u)


# --------------------------------------------------------------------------
# ЦВЕТ: тон по нормали — тем же правилом, что build.py
# --------------------------------------------------------------------------
def flat_rgb(M):
    """(m,3) sRGB 0..1 для каждого треугольника: цвет — ИЗ ПАЛИТРЫ РАТУШИ.

    Тонов по нормали здесь нет: у ратуши двенадцать плоских материалов, и
    цвет одинаков на всей плоскости.  Лёгкая модуляция по нормали нужна лишь
    чтобы анализ различал грани (иначе силуэт сливается).
    """
    SUN = np.array([-0.36, 0.30, 0.88])
    SUN = SUN / np.linalg.norm(SUN)
    lit = np.clip(M['N'] @ SUN, 0.0, None) * 0.55 + 0.60
    out = np.zeros((len(M['T']), 3))
    for fam in set(M['fam'].tolist()):
        h = PAL.HEX.get(fam, 0x808080)
        base = np.array([((h >> 16) & 255), ((h >> 8) & 255), (h & 255)]) / 255.0
        sel = M['fam'] == fam
        out[sel] = np.clip(base[None, :] * lit[sel][:, None], 0, 1)
    return out


def render(M, W=512, Hh=640, az=45.0, el=35.2644, scale=80.0, center=(0.0, 0.0, 1.4),
           mode='sprite', rgba=None):
    """Ортокамера + z-буфер. mode: sprite | id | back | normal | depth."""
    cb = cam_basis(az, el)
    P = M['T'].reshape(-1, 3)
    sx = (P @ cb['r'] - np.dot(center, cb['r'])) * scale + W / 2.0
    sy = Hh / 2.0 - (P @ cb['u'] - np.dot(center, cb['u'])) * scale
    dep = P @ cb['eye'] - np.dot(center, cb['eye'])
    sx = sx.reshape(-1, 3)
    sy = sy.reshape(-1, 3)
    dep = dep.reshape(-1, 3)

    front = np.cross(cb['eye'], M['N']).dot(np.zeros(3)) if False else (M['N'] @ cb['eye'])
    if mode == 'sprite':
        col = flat_rgb(M) if rgba is None else rgba
    elif mode == 'normal':
        col = (M['N'] * 0.5 + 0.5)
    elif mode == 'back':
        col = np.where(front[:, None] < 0.0, np.array([1.0, 0.0, 0.0]),
                       np.array([0.55, 0.55, 0.55]))
    elif mode == 'depth':
        d = dep.mean(axis=1)
        col = np.clip((d - d.min()) / max(1e-9, np.ptp(d)), 0, 1)[:, None] * np.array(
            [[0.2, 0.4, 0.9]]) + 0.1
    else:
        rng = np.random.RandomState(3)
        pal = rng.rand(len(M['parts']), 3) * 0.7 + 0.3
        col = pal[M['part']]

    img = np.ones((Hh, W, 3)) * 0.13
    zbuf = np.full((Hh, W), -1e9)
    idbuf = np.full((Hh, W), -1, int)
    area2 = (sx[:, 1] - sx[:, 0]) * (sy[:, 2] - sy[:, 0]) - \
            (sx[:, 2] - sx[:, 0]) * (sy[:, 1] - sy[:, 0])
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
        w0 = ((sx[i, 1] - gx) * (sy[i, 2] - gy) - (sx[i, 2] - gx) * (sy[i, 1] - gy)) / area2[i]
        w1 = ((sx[i, 2] - gx) * (sy[i, 0] - gy) - (sx[i, 0] - gx) * (sy[i, 2] - gy)) / area2[i]
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
def backface_pixels(M, views=((45, 35.2644), (135, 35.2644), (225, 35.2644),
                              (315, 35.2644), (45, -30.0), (45, 5.0))):
    """Пиксели, где первым по глубине идёт фасет, смотрящий ОТ камеры.

    Такой пиксель значит: наружной грани тут нет, видно нутро детали.
    Возвращает dict: имя детали -> {'px': n, 'view': ...} и суммарную карту.
    """
    bad = {}
    for az, el in views:
        R = render(M, az=az, el=el, mode='back')
        ids = R['id']
        red = (R['img'][:, :, 0] > 0.9) & (R['img'][:, :, 1] < 0.1)
        px = ids[red]
        for i in np.unique(px):
            if i < 0:
                continue
            p = int(M['part'][i])
            key = M['parts'][p]['name']
            d = bad.setdefault(key, {'px': 0, 'views': []})
            d['px'] += int((px == i).sum())
            d['views'].append('%g/%g' % (az, el))
    return bad


def _poly_planes(M):
    """Плоскости полигонов деталей (не треугольников): (n, d) + ссылки."""
    out = []
    seen = set()
    for i in range(len(M['T'])):
        key = (int(M['part'][i]), int(M['poly'][i]))
        if key in seen:
            continue
        seen.add(key)
        out.append((key, M['N'][i], float(M['N'][i] @ M['T'][i, 0])))
    return out


def coplanar(M, eps=2e-3, min_area=4e-4):
    """Пары полигонов РАЗНЫХ деталей в одной плоскости с перекрытием.

    Это z-fighting: в кадре две грани дерутся за пиксель, кромка мерцает.
    """
    polys = _poly_planes(M)
    tris_of_poly = {}
    for i in range(len(M['T'])):
        tris_of_poly.setdefault((int(M['part'][i]), int(M['poly'][i])), []).append(i)
    # AABB полигонов
    box = {}
    for k, tri in tris_of_poly.items():
        pts = M['T'][tri].reshape(-1, 3)
        box[k] = (pts.min(axis=0), pts.max(axis=0), tri)
    keys = list(box)
    out = []
    for a in range(len(keys)):
        ka = keys[a]
        na, da = polys[[p[0] for p in polys].index(ka)][1:]
        if na is None:
            continue
        pa = M['parts'][ka[0]]['name']
        for b in range(a + 1, len(keys)):
            kb = keys[b]
            if ka[0] == kb[0]:
                continue
            nb, db = polys[[p[0] for p in polys].index(kb)][1:]
            if abs(abs(float(na @ nb)) - 1.0) > 1e-3:
                continue
            if na @ nb < 0:
                db = -db
            if abs(da - db) > eps:
                continue
            lo = np.maximum(box[ka][0], box[kb][0])
            hi = np.minimum(box[ka][1], box[kb][1])
            ov = np.prod(np.maximum(0.0, hi - lo))
            if ov <= 0:
                continue
            ar = min(M['area'][box[ka][2]].sum(), M['area'][box[kb][2]].sum())
            if ar < min_area:
                continue
            out.append(dict(a=pa, b=M['parts'][kb[0]]['name'], overlap=round(float(ov), 6),
                            area=round(float(ar), 6),
                            normal=[round(float(x), 3) for x in na]))
    return out


def _sample_points(part):
    pts = [np.asarray(part['verts'], float)]
    V = pts[0]
    for f in part['faces']:
        P = V[list(f)]
        pts.append(P.mean(axis=0, keepdims=True))
        for k in range(len(f)):
            pts.append(((P[k] + P[(k + 1) % len(f)]) / 2.0)[None, :])
    return np.vstack(pts)


def _pt_tri_dist(P, T):
    """(m,) расстояние от точек P до треугольников T (n,3,3) — минимум по n."""
    A, B, C = T[:, 0], T[:, 1], T[:, 2]
    best = np.full(len(P), 1e9)
    # барицентрическая проекция на плоскость + зажим внутрь треугольника
    for i in range(len(T)):
        a, b, c = A[i], B[i], C[i]
        ab, ac, ap = b - a, c - a, P - a
        d00, d01, d11 = ab @ ab, ab @ ac, ac @ ac
        d20, d21 = ap @ ab, ap @ ac
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-14:
            continue
        v = (d11 * d20 - d01 * d21) / den
        w = (d00 * d21 - d01 * d20) / den
        u = 1.0 - v - w
        proj = a + v[:, None] * ab + w[:, None] * ac
        inside = (u >= 0) & (v >= 0) & (w >= 0)
        d = np.linalg.norm(P - proj, axis=1)
        # вне треугольника — минимум по трём рёбрам
        for e0, e1 in ((a, b), (b, c), (c, a)):
            e = e1 - e0
            t = np.clip(((P - e0) @ e) / max(1e-12, float(e @ e)), 0, 1)
            d = np.minimum(d, np.linalg.norm(P - (e0 + t[:, None] * e), axis=1))
        d = np.where(inside, np.linalg.norm(P - proj, axis=1), d)
        best = np.minimum(best, d)
    return best


def neighbours(M, max_gap=0.05):
    """Для каждой детали — ближайшая другая деталь и зазор до неё."""
    parts = M['parts']
    pts = [_sample_points(p) for p in parts]
    boxes = []
    for p in parts:
        V = np.asarray(p['verts'], float)
        boxes.append((V.min(axis=0), V.max(axis=0)))
    out = []
    for i, p in enumerate(parts):
        best = (1e9, None)
        for j in range(len(parts)):
            if i == j:
                continue
            lo = np.maximum(boxes[i][0], boxes[j][0])
            hi = np.minimum(boxes[i][1], boxes[j][1])
            corner = np.maximum(0.0, np.maximum(boxes[i][0] - boxes[j][1],
                                                boxes[j][0] - boxes[i][1]))
            if np.linalg.norm(corner) > max_gap:
                continue
            tri = M['T'][M['part'] == j]
            d1 = _pt_tri_dist(pts[i], tri).min()
            d2 = _pt_tri_dist(pts[j], M['T'][M['part'] == i]).min()
            d = float(min(d1, d2))
            if d < best[0]:
                best = (d, parts[j]['name'])
        out.append(dict(name=p['name'], family=p['family'], gap=round(best[0], 4),
                        to=best[1]))
    return out


def report(variant='a', gap_max=0.05, do_coplanar=True):
    parts = H.build(variant)
    M = mesh(parts)
    lines = []
    lines.append('вариант %s: деталей %d, трис %d, вершин %d'
                 % (variant, len(parts), len(M['T']), len(M['V'])))
    lines.append('габарит X %.3f..%.3f  Y %.3f..%.3f  Z %.3f..%.3f'
                 % (M['V'][:, 0].min(), M['V'][:, 0].max(), M['V'][:, 1].min(),
                    M['V'][:, 1].max(), M['V'][:, 2].min(), M['V'][:, 2].max()))

    bb = backface_pixels(M)
    lines.append('\n== ВИДИМЫЕ ИЗНАНКИ (дыры) ==')
    if not bb:
        lines.append('  нет')
    for k, v in sorted(bb.items(), key=lambda kv: -kv[1]['px']):
        lines.append('  %-22s %6d px  виды %s' % (k, v['px'], ','.join(v['views'][:3])))

    nb = neighbours(M, gap_max)
    lines.append('\n== ЗАЗОРЫ (деталь -> ближайшая, юниты) ==')
    for d in sorted(nb, key=lambda d: -d['gap']):
        if d['gap'] > 0.010:
            lines.append('  %-22s %6.4f  -> %s' % (d['name'], d['gap'], d['to']))

    if do_coplanar:
        cp = coplanar(M)
        lines.append('\n== Z-FIGHTING (совпадающие плоскости разных деталей) ==')
        if not cp:
            lines.append('  нет')
        for c in sorted(cp, key=lambda c: -c['area'])[:40]:
            lines.append('  %-20s <-> %-20s area %.5f n=%s'
                         % (c['a'], c['b'], c['area'], c['normal']))
        if len(cp) > 40:
            lines.append('  ... всего %d пар' % len(cp))
    return '\n'.join(lines), M


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description='диагностика геометрии дома')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('probe')
    p.add_argument('--variant', default='a')
    p.add_argument('--no-coplanar', action='store_true')
    p.add_argument('--save', default=None, help='куда положить отчёт .txt')
    s = sub.add_parser('shot')
    s.add_argument('png')
    s.add_argument('--variant', default='a')
    s.add_argument('--az', type=float, default=45.0)
    s.add_argument('--el', type=float, default=35.2644)
    s.add_argument('--rot', type=float, default=0.0)
    s.add_argument('--zoom', type=float, default=80.0)
    s.add_argument('--res', default='512,640')
    s.add_argument('--center', default='0,0,1.4')
    s.add_argument('--mode', default='sprite')
    args = ap.parse_args()

    if args.cmd == 'probe':
        text, M = report(args.variant, do_coplanar=not args.no_coplanar)
        print(text)
        if args.save:
            with open(args.save, 'w', encoding='utf-8') as f:
                f.write(text + '\n')
            print('\n-> %s' % args.save)
        return
    W, Hh = [int(x) for x in args.res.split(',')]
    cx, cy, cz = [float(x) for x in args.center.split(',')]
    M = rot_z(mesh(H.build(args.variant)), args.rot)
    R = render(M, W=W, Hh=Hh, az=args.az, el=args.el, scale=args.zoom,
               center=(cx, cy, cz), mode=args.mode)
    print('-> %s' % save_png(args.png, R['img']))


if __name__ == '__main__':
    main()
