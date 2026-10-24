"""contain.py — торчит ли деталь из-под соседней, ПО ВСЕМ 360°.

Проверка не глазом и не с одного ракурса: берутся точки внутренней детали
(вершины, середины рёбер, центры граней) и считается, внутри ли они замкнутой
оболочки внешней детали. Луч пускается по трём осям, ответ — по большинству:
так не врёт ни на одной грани и не зависит от азимута.

    $PY tools/contain.py --outer helmet --inner head --above 0.885
    $PY tools/contain.py --outer cuirass --inner sleeve_l,sleeve_r --above 0.72
"""
import argparse
import sys

import numpy as np

import person as H


def tris(part):
    V = np.asarray(part['verts'], float)
    out = []
    for f in part['faces']:
        P = V[list(f)]
        for k in range(1, len(f) - 1):
            out.append(P[[0, k, k + 1]])
    return np.asarray(out)


def samples(part):
    V = np.asarray(part['verts'], float)
    pts = [V]
    for f in part['faces']:
        P = V[list(f)]
        pts.append(P.mean(axis=0, keepdims=True))
        for k in range(len(f)):
            pts.append(((P[k] + P[(k + 1) % len(f)]) / 2.0)[None, :])
    return np.vstack(pts)


def inside(T, P, d):
    """Точка внутри замкнутой оболочки T: нечётное число пересечений."""
    hit = np.zeros(len(P), bool)
    for i in range(len(T)):
        a, b, c = T[i]
        e1, e2 = b - a, c - a
        pv = np.cross(d, e2)
        det = e1 @ pv
        if abs(det) < 1e-12:
            continue
        inv = 1.0 / det
        tv = P - a
        u = (tv @ pv) * inv
        qv = np.cross(tv, e1)
        v = (qv @ d) * inv
        t = (qv @ e2) * inv
        m = (u >= 0) & (u <= 1) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
        hit ^= m
    return hit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--outer', required=True)
    ap.add_argument('--inner', required=True)
    ap.add_argument('--above', type=float, default=None,
                    help='проверять только точки внутренней детали выше z')
    ap.add_argument('--below', type=float, default=None,
                    help='и только ниже z')
    ap.add_argument('--variant', default='k')
    a = ap.parse_args()
    parts = H.build(variant=a.variant)
    by = {p['name']: p for p in parts}
    T = tris(by[a.outer])
    bad = []
    for nm in a.inner.split(','):
        P = samples(by[nm])
        if a.above is not None:
            P = P[P[:, 2] >= a.above]
        if a.below is not None:
            P = P[P[:, 2] <= a.below]
        # ЛУЧИ КОСЫЕ, А НЕ ПО ОСЯМ: кольца лофта имеют вершины ровно на 0° и
        # 90°, и осевой луч проходит через вершину — пересечение то есть, то
        # нет. Косой луч вершину не задевает; ответ — по большинству из 4.
        dirs = (np.array([1.0, 0.37, 0.11]), np.array([0.29, 1.0, 0.13]),
                np.array([0.41, 0.23, 1.0]), np.array([-0.31, 0.27, 1.0]))
        votes = sum(inside(T, P, d).astype(int) for d in dirs)
        ins = votes >= 3
        for pt in P[~ins]:
            bad.append((nm, tuple(round(float(x), 3) for x in pt)))
    print('точек проверено: %d, снаружи: %d' % (len(P), len(bad)))
    for nm, pt in sorted(bad, key=lambda t: -t[1][2])[:20]:
        print('  СНАРУЖИ %-8s %s' % (nm, pt))
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
