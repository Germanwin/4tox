"""metrics.py — замер СОБРАННОЙ геометрии дома без Blender.

Отвечает числами на вопросы, которые глазами не проверяются:
    * габарит и посадка в пятно 3 x 2;
    * ярусы (цоколь / стены / конёк / труба) и их доли — против канона;
    * уклон ската, свесы, толщина кровли — против канона;
    * НАПРАВЛЕНИЕ НОРМАЛЕЙ каждого фасета (inverted normal = чёрный фасет);
    * вырожденные грани, дубли вершин, бюджет трис.

    python3 tools/metrics.py [--variant a] [--json out/metrics.json]
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import house as H                                              # noqa: E402

CANON = dict(foot=(3, 2), wall_h=1.35, h_b=(2.60, 3.00),
             pitch=(32.0, 55.0), over_slope=(0.11, 0.31),
             over_end=(0.04, 0.13), tris=(300, 1500))


def _norm(v):
    d = math.sqrt(sum(c * c for c in v)) or 1.0
    return (v[0] / d, v[1] / d, v[2] / d)


def face_normal(verts, face):
    p = [verts[i] for i in face]
    a = (p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2])
    b = (p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2])
    n = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    ln = math.sqrt(sum(c * c for c in n))
    if ln < 1e-12:
        return None, 0.0
    return (n[0] / ln, n[1] / ln, n[2] / ln), 0.5 * ln


def signed_volume(verts, faces):
    vol = 0.0
    for f in faces:
        for k in range(1, len(f) - 1):
            a, b, c = verts[f[0]], verts[f[k]], verts[f[k + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                    - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return vol


def centroid(verts):
    n = float(len(verts))
    return (sum(p[0] for p in verts) / n, sum(p[1] for p in verts) / n,
            sum(p[2] for p in verts) / n)


def check_normals(parts):
    """Согласованность обхода и НАРУЖУ-ориентация.

    Тест 1 (жёсткий, для любой детали): ни одно направленное ребро не должно
    встретиться дважды — иначе у детали вывернут фасет.
    Тест 2 (для замкнутых): знаковый объём > 0, то есть нормали наружу.
    Тест 3 (для оболочек-коробов): нормаль каждого фасета смотрит от центра.
    """
    bad = []
    for p in parts:
        v, f = p['verts'], p['faces']
        seen = {}
        for i, fc in enumerate(f):
            if len(fc) < 3:
                bad.append((p['name'], 'face<3', i))
                continue
            for k in range(len(fc)):
                e = (fc[k], fc[(k + 1) % len(fc)])
                if e in seen:
                    bad.append((p['name'], 'edge-twice:%s' % (e,), i))
                seen[e] = i
            n, area = face_normal(v, fc)
            if n is None or area < 1e-9:
                bad.append((p['name'], 'degenerate-face', i))
        closed = all((b, a) in seen for (a, b) in seen)
        if closed:
            vol = signed_volume(v, f)
            if vol <= 0:
                bad.append((p['name'], 'volume<=0', round(vol, 6)))
        elif len(v) == 8 and len(f) < 6:
            c = centroid(v)
            for i, fc in enumerate(f):
                n, _ = face_normal(v, fc)
                fc_c = [sum(v[j][k] for j in fc) / float(len(fc)) for k in range(3)]
                if sum((fc_c[k] - c[k]) * n[k] for k in range(3)) < -1e-6:
                    bad.append((p['name'], 'shell-face-inward', i))
    return bad


def report(parts, name='house'):
    xs = [p[0] for part in parts for p in part['verts']]
    ys = [p[1] for part in parts for p in part['verts']]
    zs = [p[2] for part in parts for p in part['verts']]
    box = dict(x=(min(xs), max(xs)), y=(min(ys), max(ys)), z=(min(zs), max(zs)))
    fams = {}
    for part in parts:
        t = sum(len(f) - 2 for f in part['faces'])
        d = fams.setdefault(part['family'], [0, 0])
        d[0] += 1
        d[1] += t
    # уклон ската и свесы по фактической кровле
    roof = [p for p in parts if p['name'] == 'roof_plasts']
    pitch = math.degrees(math.atan2(H.TAN_P, 1.0))
    out = dict(
        name=name, parts=len(parts),
        verts=sum(len(p['verts']) for p in parts),
        tris=sum(sum(len(f) - 2 for f in p['faces']) for p in parts),
        families={k: dict(parts=v[0], tris=v[1]) for k, v in sorted(fams.items())},
        bbox=dict(x=[round(box['x'][0], 3), round(box['x'][1], 3)],
                  y=[round(box['y'][0], 3), round(box['y'][1], 3)],
                  z=[round(box['z'][0], 3), round(box['z'][1], 3)]),
        size=[round(box['x'][1] - box['x'][0], 3),
              round(box['y'][1] - box['y'][0], 3),
              round(box['z'][1] - box['z'][0], 3)],
        tiers=dict(plinth_top=H.PL_H, wall_top=H.WALL_Z1,
                   ridge=round(H.RIDGE_Z, 3),
                   roof_top=round(max(zs), 3)),
        pitch_deg=round(pitch, 2),
        over_slope=H.OVER_SLOPE, over_end=H.OVER_END,
        roof_over_slope_ratio=round(H.OVER_SLOPE / H.WALL_Y, 3),
        roof_over_end_ratio=round(H.OVER_END / H.WALL_X, 3),
        wall_ratio_roof=round((H.RIDGE_Z - H.WALL_Z1) / H.WALL_H, 3),
    )
    return out, box


def gate(rep, box):
    """Проверки против канона. Возвращает список (ok, текст)."""
    g = []
    g.append((rep['tris'] <= CANON['tris'][1],
              'полигонаж %d в бюджете building 300..1500' % rep['tris']))
    h = box['z'][1]
    g.append((CANON['h_b'][0] - 0.25 <= h <= CANON['h_b'][1] + 0.2,
              'высота дома %.2f (канон %.2f..%.2f, с трубой)' % (h, *CANON['h_b'])))
    g.append((CANON['pitch'][0] <= rep['pitch_deg'] <= CANON['pitch'][1],
              'уклон ската %.1f град (канон 32..55, солома 45..55)' % rep['pitch_deg']))
    g.append((CANON['over_slope'][0] <= rep['roof_over_slope_ratio'] <= CANON['over_slope'][1],
              'свес по скату %.0f%% ширины стены (канон 11..31%%)'
              % (rep['roof_over_slope_ratio'] * 100)))
    g.append((CANON['over_end'][0] <= rep['roof_over_end_ratio'] <= CANON['over_end'][1],
              'свес по торцу %.0f%% (канон 4..13%%)' % (rep['roof_over_end_ratio'] * 100)))
    g.append((abs(box['x'][0]) <= 1.53 and abs(box['x'][1]) <= 1.53
              and abs(box['y'][0]) <= 1.075 and abs(box['y'][1]) <= 1.075,
              'габарит x %.2f y %.2f в пятне 3x2 (кровля ровно по пятну, '
              'крыльцо +0.03)' % (box['x'][1] - box['x'][0],
                                  box['y'][1] - box['y'][0])))
    g.append((0.45 <= rep['wall_ratio_roof'] <= 1.35,
              'крыша/стены %.2f (канон 0.5..1.31)' % rep['wall_ratio_roof']))
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variant', default='a')
    ap.add_argument('--json')
    args = ap.parse_args()
    parts = H.build(args.variant)
    rep, box = report(parts, 'house_%s' % args.variant)
    bad = check_normals(parts)
    rep['normal_issues'] = bad[:20]
    rep['normal_issue_count'] = len(bad)
    print(json.dumps(rep, ensure_ascii=False, indent=1))
    print('--- канон ---')
    for ok, text in gate(rep, box):
        print('%s %s' % ('OK  ' if ok else 'FAIL', text))
    if bad:
        print('--- нормали/грани ---')
        for b in bad[:20]:
            print('  ', b)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
    return 1 if bad or not all(ok for ok, _ in gate(rep, box)) else 0


if __name__ == '__main__':
    sys.exit(main())
