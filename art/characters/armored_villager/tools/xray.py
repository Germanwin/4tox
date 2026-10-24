"""xray.py — просвет фигуры БЕЗ Blender: софт-рендер, изнанки, z-fighting, зазоры.

Blender — это способ отдать форму заказчику, а итерации по дефектам надо делать
быстро и с любого ракурса. Здесь своя ортокамера (перспектива не нужна: спрайт
канонный), z-буфер и плоское затенение по палитре — тем же правилом «тон по
нормали», что и build.py. Плюс четыре теста, которых глазом не сделать:

    backfaces — видимые ИЗВНЕ изнанки: значит у детали выброшена наружная грань
                (или обход вывернут) и в спрайте будет чёрная полоса;
    coplanar  — совпадающие плоскости РАЗНЫХ деталей: z-fighting, мерцание;
    gaps      — деталь кончается в воздухе, не доставая соседа;
    px        — сколько пикселей занимает деталь при 96 ppu: всё, что меньше
                2 px, в спрайт не доедет (канон: деталь < 0.02 юнита — шум).

Запуск:
    $PY3 tools/xray.py probe                 # отчёт по дефектам
    $PY3 tools/xray.py shot out/look.png --az 45 --el 35 --zoom 3 --center 0,0,0.4
    $PY3 tools/xray.py sheet out/look.png    # 4 поворота + профиль + вид сверху
"""
import argparse
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import person as H          # noqa: E402
import palette as PAL       # noqa: E402

import palette as _PAL
SUN = np.array(_PAL.SUN_DIR)   # один источник истины: palette.SUN_DIR
SUN = SUN / np.linalg.norm(SUN)
AZ = 45.0
EL = math.degrees(math.atan(1.0 / math.sqrt(2.0)))


def _triangles(f):
    """Веер: все грани фигуры выпуклые (кольца, короба, полосы фартука)."""
    return [(f[0], f[k], f[k + 1]) for k in range(1, len(f) - 1)]


# --------------------------------------------------------------------------
# МЕШ
# --------------------------------------------------------------------------
def mesh(parts):
    verts, tri, part_i, poly, fam = [], [], [], [], []
    for pi, p in enumerate(parts):
        off = len(verts)
        verts.extend([tuple(map(float, v)) for v in p['verts']])
        for fi, f in enumerate(p['faces']):
            for t in _triangles(f):
                tri.append(tuple(off + i for i in t))
                part_i.append(pi)
                poly.append(fi)
                fam.append(p['family'])
    V = np.asarray(verts, float)
    T = V[np.asarray(tri, int)]
    e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
    cr = np.cross(e1, e2)
    ln = np.linalg.norm(cr, axis=1)
    N = cr / np.maximum(ln, 1e-12)[:, None]
    # НОРМАЛЬ ПОЛИГОНА, а не треугольника. Blender красит ПОЛИГОН целиком: у
    # четырёхугольника лофта четыре точки не лежат в одной плоскости, и его
    # диагональ при покраске по треугольникам проступает сменой тона — прибор
    # показывал «мусор» там, где пайплайн даёт ровный фасет.
    Pn = np.zeros_like(N)
    for k in np.unique(np.asarray(poly, int) * 100000 + np.asarray(part_i, int)):
        sel = (np.asarray(poly, int) == k // 100000) & (np.asarray(part_i, int) == k % 100000)
        v = N[sel].sum(axis=0)
        n = np.linalg.norm(v)
        Pn[sel] = v / n if n > 1e-12 else N[sel][0]
    return dict(V=V, T=T, N=N, Pn=Pn, part=np.asarray(part_i, int),
                poly=np.asarray(poly, int), fam=np.asarray(fam), area=ln / 2.0,
                parts=parts)


def rot_z(M, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    R = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    out = dict(M)
    out['T'] = M['T'] @ R.T
    out['N'] = M['N'] @ R.T
    out['V'] = M['V'] @ R.T
    return out


def cam_basis(az_deg=AZ, el_deg=EL):
    """Канонная камера игры: смотрим из (+X, +Y, +Z).

    Это НЕ произвол и не «на глаз»: игра считает ближе к камере того, у кого
    больше `x + y` (js/render.js: sx = (x−y)·tw/2, sy = (x+y)·tw/4; mapgen2/
    README: «по земле он честно ближе камеры (x + y больше), и по порядку
    глубины рисуется поверх»). Значит камера стоит в квадранте +X +Y, а модель,
    которая смотрит в +X, видна СПЕРЕДИ-СЛЕВА — с лицом.

    Общий пайплайн проекта (townhall/tools/thpipe.py::setup_camera) ставит
    камеру в (−X, +Y, +Z), то есть на 90° мимо: у него мировая ось +X уходит
    влево-вверх, а игра двигает объект вправо-вниз. Атлас героя отрендерен
    именно так (доказательство — замер топора: он висит у правого бедра,
    references/hero-reference.md). Здесь канон игры, а не привычка пайплайна.
    """
    az, el = math.radians(az_deg), math.radians(el_deg)
    eye = np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az),
                    math.sin(el)])
    r = np.array([math.cos(az), -math.sin(az), 0.0])
    u = np.array([-math.sin(el) * math.cos(az), -math.sin(el) * math.sin(az),
                  math.cos(el)])
    return dict(eye=eye, f=-eye, r=r, u=u)


def flat_rgb(M):
    """(m,3) sRGB 0..1: семейство + тон по нормали ПОЛИГОНА — как в build.py."""
    b = np.clip(M['Pn'] @ SUN, 0.0, None) + 0.15
    out = np.zeros((len(M['T']), 3))
    for f in set(M['fam'].tolist()):
        light, mid = PAL.thresholds(f)
        cache = [np.array(PAL.hex_rgb(PAL.tones(f)[t])) / 255.0 for t in range(3)]
        sel = M['fam'] == f
        bb = b[sel]
        t = np.where(bb >= light, 0, np.where(bb >= mid, 1, 2))
        out[sel] = np.stack([cache[int(x)] for x in t])
    return out


# --------------------------------------------------------------------------
# РЕНДЕР
# --------------------------------------------------------------------------
def render(M, W=512, Hh=640, az=AZ, el=EL, scale=96.0, center=(0.0, 0.0, 0.40),
           mode='sprite'):
    cb = cam_basis(az, el)
    P = M['T'].reshape(-1, 3)
    sx = ((P @ cb['r'] - float(np.dot(center, cb['r']))) * scale + W / 2.0).reshape(-1, 3)
    sy = (Hh / 2.0 - (P @ cb['u'] - float(np.dot(center, cb['u']))) * scale).reshape(-1, 3)
    dep = (P @ cb['eye'] - float(np.dot(center, cb['eye']))).reshape(-1, 3)
    front = M['Pn'] @ cb['eye']
    if mode == 'back':
        col = np.where(front[:, None] < 0.0, np.array([1.0, 0.0, 0.0]),
                       np.array([0.55, 0.55, 0.55]))
    elif mode == 'normal':
        col = (M['N'] * 0.5 + 0.5)
    elif mode == 'id':
        rng = np.random.RandomState(7)
        col = (rng.rand(len(M['parts']), 3) * 0.7 + 0.3)[M['part']]
    else:
        col = flat_rgb(M)
    img = np.ones((Hh, W, 3)) * 0.13
    zbuf = np.full((Hh, W), -1e9)
    idbuf = np.full((Hh, W), -1, int)
    area2 = ((sx[:, 1] - sx[:, 0]) * (sy[:, 2] - sy[:, 0])
             - (sx[:, 2] - sx[:, 0]) * (sy[:, 1] - sy[:, 0]))
    for i in range(len(M['T'])):
        # Порог ПРОПУСКА — только против точного нуля. Раньше стояло 1e-9, и
        # «щелевые» треугольники (длинные и узкие, area2 ~1e-8) выбрасывались
        # целиком: в кадре оставались дыры в 1 px, а на азимутах 0/90/180/270
        # они выстраивались по сетке и читались как «мусор» на платье. Глазом
        # это выглядело дефектом модели, хотя дефект был в приборе.
        if abs(area2[i]) < 1e-12:
            continue
        x0 = max(0, int(math.floor(sx[i].min())))
        x1 = min(W - 1, int(math.ceil(sx[i].max())))
        y0 = max(0, int(math.floor(sy[i].min())))
        y1 = min(Hh - 1, int(math.ceil(sy[i].max())))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5,
                             np.arange(y0, y1 + 1) + 0.5)
        w0 = ((sx[i, 1] - gx) * (sy[i, 2] - gy)
              - (sx[i, 2] - gx) * (sy[i, 1] - gy)) / area2[i]
        w1 = ((sx[i, 2] - gx) * (sy[i, 0] - gy)
              - (sx[i, 0] - gx) * (sy[i, 2] - gy)) / area2[i]
        ins = (w0 >= -1e-9) & (w1 >= -1e-9) & (w0 + w1 <= 1.0 + 1e-9)
        if not ins.any():
            continue
        d = w0 * dep[i, 0] + w1 * dep[i, 1] + (1.0 - w0 - w1) * dep[i, 2]
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
VIEWS = tuple((az, el) for az in (45, 135, 225, 315)
              for el in (EL, 5.0, -30.0)) + ((45.0, 60.0), (225.0, 60.0))


def backface_pixels(M, views=VIEWS):
    """Пиксели, где первым по глубине идёт фасет, смотрящий ОТ камеры."""
    bad = {}
    for az, el in views:
        R = render(M, az=az, el=el, mode='back', scale=96.0)
        red = (R['img'][:, :, 0] > 0.9) & (R['img'][:, :, 1] < 0.1)
        px = R['id'][red]
        for i in np.unique(px):
            if i < 0:
                continue
            key = M['parts'][int(M['part'][i])]['name']
            d = bad.setdefault(key, {'px': 0, 'views': []})
            d['px'] += int((px == i).sum())
            d['views'].append('%g/%g' % (az, el))
    return bad


def coplanar(M, eps=2e-3, min_area=4e-4):
    """Пары полигонов разных деталей в одной плоскости с перекрытием."""
    planes, tris = {}, {}
    for i in range(len(M['T'])):
        k = (int(M['part'][i]), int(M['poly'][i]))
        planes.setdefault(k, (M['N'][i], float(M['N'][i] @ M['T'][i, 0])))
        tris.setdefault(k, []).append(i)
    box = {}
    for k, tl in tris.items():
        pts = M['T'][tl].reshape(-1, 3)
        box[k] = (pts.min(axis=0), pts.max(axis=0), tl)
    keys = list(box)
    out = []
    for a in range(len(keys)):
        ka = keys[a]
        na, da = planes[ka]
        for b in range(a + 1, len(keys)):
            kb = keys[b]
            if ka[0] == kb[0]:
                continue
            nb, db = planes[kb]
            if abs(abs(float(na @ nb)) - 1.0) > 1e-3:
                continue
            if na @ nb < 0:
                db = -db
            if abs(da - db) > eps:
                continue
            lo = np.maximum(box[ka][0], box[kb][0])
            hi = np.minimum(box[ka][1], box[kb][1])
            if float(np.prod(np.maximum(0.0, hi - lo))) <= 0:
                continue
            ar = min(M['area'][box[ka][2]].sum(), M['area'][box[kb][2]].sum())
            if ar < min_area:
                continue
            out.append(dict(a=M['parts'][ka[0]]['name'],
                            b=M['parts'][kb[0]]['name'], area=round(float(ar), 6),
                            normal=[round(float(x), 3) for x in na]))
    return out


def _sample_points(part):
    V = np.asarray(part['verts'], float)
    pts = [V]
    for f in part['faces']:
        P = V[list(f)]
        pts.append(P.mean(axis=0, keepdims=True))
        for k in range(len(f)):
            pts.append(((P[k] + P[(k + 1) % len(f)]) / 2.0)[None, :])
    return np.vstack(pts)


def _pt_tri_dist(P, T):
    A, B, C = T[:, 0], T[:, 1], T[:, 2]
    best = np.full(len(P), 1e9)
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
        for e0, e1 in ((a, b), (b, c), (c, a)):
            e = e1 - e0
            t = np.clip(((P - e0) @ e) / max(1e-12, float(e @ e)), 0, 1)
            d = np.minimum(d, np.linalg.norm(P - (e0 + t[:, None] * e), axis=1))
        best = np.minimum(best, np.where(inside, np.linalg.norm(P - proj, axis=1), d))
    return best


def neighbours(M, max_gap=0.06):
    parts = M['parts']
    pts = [_sample_points(p) for p in parts]
    box = []
    for p in parts:
        V = np.asarray(p['verts'], float)
        box.append((V.min(axis=0), V.max(axis=0)))
    out = []
    for i, p in enumerate(parts):
        best = (1e9, None)
        for j in range(len(parts)):
            if i == j:
                continue
            corner = np.maximum(0.0, np.maximum(box[i][0] - box[j][1],
                                                box[j][0] - box[i][1]))
            if np.linalg.norm(corner) > max_gap:
                continue
            d = min(float(_pt_tri_dist(pts[i], M['T'][M['part'] == j]).min()),
                    float(_pt_tri_dist(pts[j], M['T'][M['part'] == i]).min()))
            if d < best[0]:
                best = (d, parts[j]['name'])
        out.append(dict(name=p['name'], family=p['family'], gap=round(best[0], 4),
                        to=best[1]))
    return out


def projected_px(M, ppu=96.0):
    """Крупность детали в пикселях при данном ppu — ловит «деталь не доедет»."""
    out = []
    for p in M['parts']:
        V = np.asarray(p['verts'], float)
        w = h = 0.0
        for az in (45.0, 135.0, 225.0, 315.0):
            cb = cam_basis(az, EL)
            sx, sy = V @ cb['r'] * ppu, V @ cb['u'] * ppu
            w = max(w, sx.max() - sx.min())
            h = max(h, sy.max() - sy.min())
        out.append(dict(name=p['name'], w=round(float(w), 1), h=round(float(h), 1),
                        tris=sum(len(f) - 2 for f in p['faces'])))
    return out


def report(do_coplanar=True, gap_max=0.06, pose=None, axe=False, logs=False,
           variant='m'):
    """Просвет фигуры. `pose` — поза кадра (например, удар рубки): топор и
    поднятая рука появляются только в ней, и без этого аргумента их детали в
    отчёт не попадают вовсе (tools/axe_probe.py зовёт его так).

    `axe` / `logs` — предметы в руках: без них просвет кадра носки покажет
    фигуру с ПУСТЫМИ руками и честно не увидит ни одного бревна, то есть
    промолчит про ровно то, ради чего его и зовут."""
    parts = H.build(variant=variant, pose=pose, axe=axe, logs=logs)
    M = mesh(parts)
    L = ['деталей %d, трис %d, вершин %d' % (len(parts), len(M['T']), len(M['V'])),
         'габарит X %.3f..%.3f  Y %.3f..%.3f  Z %.3f..%.3f'
         % (M['V'][:, 0].min(), M['V'][:, 0].max(), M['V'][:, 1].min(),
            M['V'][:, 1].max(), M['V'][:, 2].min(), M['V'][:, 2].max())]
    bb = backface_pixels(M)
    L.append('\n== ВИДИМЫЕ ИЗНАНКИ (дыры) ==')
    if not bb:
        L.append('  нет')
    for k, v in sorted(bb.items(), key=lambda kv: -kv[1]['px']):
        L.append('  %-22s %6d px  виды %s' % (k, v['px'], ','.join(v['views'][:4])))
    nb = neighbours(M, gap_max)
    L.append('\n== ЗАЗОРЫ (деталь -> ближайшая, юниты; >0.010 = висит в воздухе) ==')
    for d in sorted(nb, key=lambda d: -d['gap']):
        if d['gap'] > 0.010:
            L.append('  %-22s %6.4f  -> %s' % (d['name'], d['gap'], d['to']))
    L.append('\n== КРУПНОСТЬ ДЕТАЛЕЙ (px при 96 ppu; <2 px в спрайт не доедет) ==')
    for d in sorted(projected_px(M), key=lambda d: min(d['w'], d['h'])):
        flag = 'МЕЛКО' if min(d['w'], d['h']) < 1.9 else '     '
        L.append('  %s %-22s %5.1f x %-5.1f  трис %d'
                 % (flag, d['name'], d['w'], d['h'], d['tris']))
    if do_coplanar:
        cp = coplanar(M)
        L.append('\n== Z-FIGHTING (совпадающие плоскости разных деталей) ==')
        if not cp:
            L.append('  нет')
        for c in sorted(cp, key=lambda c: -c['area'])[:20]:
            L.append('  %-20s <-> %-20s area %.5f n=%s'
                     % (c['a'], c['b'], c['area'], c['normal']))
    return '\n'.join(L), M


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description='просвет фигуры без Blender')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('probe')
    p.add_argument('--save')
    p.add_argument('--no-coplanar', action='store_true')
    p.add_argument('--anim', default=None, help='idle/walk/work — поза кадра')
    p.add_argument('--frame', type=int, default=0)
    p.add_argument('--axe', action='store_true', help='с топором (кадры рубки)')
    p.add_argument('--variant', default='m', help='m — мужчина, f — женщина, k — броня')
    s = sub.add_parser('shot')
    s.add_argument('png')
    s.add_argument('--az', type=float, default=AZ)
    s.add_argument('--el', type=float, default=EL)
    s.add_argument('--rot', type=float, default=0.0)
    s.add_argument('--pose', default=None, help='JSON позы')
    s.add_argument('--zoom', type=float, default=96.0)
    s.add_argument('--res', default='512,640')
    s.add_argument('--center', default='0,0,0.40')
    s.add_argument('--mode', default='sprite')
    sh = sub.add_parser('sheet')
    sh.add_argument('png')
    sh.add_argument('--zoom', type=float, default=384.0)
    sh.add_argument('--pose', default=None)
    args = ap.parse_args()

    if args.cmd == 'probe':
        pose = None
        if args.anim:
            import poses as PO
            pose = PO.pose(args.anim, args.frame)
        want = {}
        if args.anim:
            import poses as PO
            want = PO.props(args.anim)
        text, _ = report(do_coplanar=not args.no_coplanar, pose=pose,
                         axe=args.axe or want.get('axe', False), variant=args.variant,
                         logs=want.get('logs', False))
        print(text)
        if args.save:
            open(args.save, 'w', encoding='utf-8').write(text + '\n')
        return
    pose = json.loads(getattr(args, 'pose', None) or 'null') or None
    if args.cmd == 'shot':
        W, Hh = [int(x) for x in args.res.split(',')]
        cx, cy, cz = [float(x) for x in args.center.split(',')]
        M = rot_z(mesh(H.build(pose=pose)), args.rot)
        R = render(M, W=W, Hh=Hh, az=args.az, el=args.el, scale=args.zoom,
                   center=(cx, cy, cz), mode=args.mode)
        print('-> %s' % save_png(args.png, R['img']))
        return
    if args.cmd == 'sheet':
        tiles = []
        for rot in (0, 90, 180, 270):
            M = rot_z(mesh(H.build(pose=pose)), rot)
            tiles.append(render(M, W=200, Hh=260, az=AZ, el=EL, scale=args.zoom,
                                center=(0.0, 0.0, 0.42))['img'])
        M = mesh(H.build(pose=pose))
        for az, el in ((45.0, 1.0), (45.0, 80.0)):
            tiles.append(render(M, W=200, Hh=260, az=az, el=el, scale=args.zoom,
                                center=(0.0, 0.0, 0.42))['img'])
        print('-> %s' % save_png(args.png, np.concatenate(tiles, axis=1)))
        return


if __name__ == '__main__':
    main()
