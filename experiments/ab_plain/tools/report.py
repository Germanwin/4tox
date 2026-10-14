# -*- coding: utf-8 -*-
"""report.py — числа и проверки кузницы -> out/report.txt.

Гоняется без Blender: форма живёт в building.py, поэтому трис, габарит, уклон,
свесы и замкнутость считаются здесь, а не «на глаз по картинке».

    python3 tools/report.py            # все варианты
    python3 tools/report.py a          # только один
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import building as B                                              # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), 'out', 'report.txt')
TOL = 1e-9


# --------------------------------------------------------------------------
# ПРОВЕРКИ ГЕОМЕТРИИ
# --------------------------------------------------------------------------
def face_normal(vs, f):
    a, b, c = vs[f[0]], vs[f[1]], vs[f[2]]
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    return 0.5 * math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)


def part_checks(p):
    """Замкнутость, согласованность обхода, объём, вырожденные грани."""
    vs, fs = p['verts'], p['faces']
    edges = {}
    degen = 0
    for f in fs:
        if face_normal(vs, f) < 1e-9:
            degen += 1
        for i in range(len(f)):
            e = (f[i], f[(i + 1) % len(f)])
            edges[e] = edges.get(e, 0) + 1
    closed = all(c == 1 for c in edges.values()) and \
        all(edges.get((b, a), 0) == 1 for (a, b) in edges)
    # объём по теореме о дивергенции: положительный -> нормали наружу
    vol = 0.0
    for f in fs:
        a = vs[f[0]]
        for i in range(1, len(f) - 1):
            b, c = vs[f[i]], vs[f[i + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                    - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return closed, vol, degen


def roof_underside(g, y):
    """Низ тела кровли над координатой |y| (что видно снизу)."""
    return g.z_ridge - abs(y) * g.tan - B.ROOF_T


def roof_surface(g, y):
    """Верх тела кровли над координатой |y| — сквозь него ничего не торчит."""
    return g.z_ridge - abs(y) * g.tan


# --------------------------------------------------------------------------
# ОТЧЁТ ПО ВАРИАНТУ
# --------------------------------------------------------------------------
def variant_report(key):
    parts = B.build(key)
    cfg = B.VARIANTS[key]
    g = B.Geo(cfg['pitch'], cfg['over_slope'], cfg['over_end'],
              wall_h=cfg['wall_h'], gate_w=cfg['gate_w'], gate_h=cfg['gate_h'],
              win_wall=cfg['win_wall'], win_u=cfg['win_u'])
    st = B.stats(parts)
    bb = B.bounds(parts)
    fam = {}
    for p in parts:
        fam[p['family']] = fam.get(p['family'], 0) + sum(len(f) - 2 for f in p['faces'])
    bad_closed = [p['name'] for p in parts if not part_checks(p)[0]]
    bad_vol = [(p['name'], part_checks(p)[1]) for p in parts if part_checks(p)[1] <= TOL]
    bad_degen = [(p['name'], part_checks(p)[2]) for p in parts if part_checks(p)[2]]
    ymax = max(abs(bb['y'][0]), abs(bb['y'][1]))
    xmax = max(abs(bb['x'][0]), abs(bb['x'][1]))
    # ничего, кроме кровли и трубы, не торчит СКВОЗЬ скат
    under = []
    for p in parts:
        if p['name'].startswith(('roof_', 'chimney_')):
            continue
        for (x, y, z) in p['verts']:
            if abs(y) <= g.y_eave + 1e-9 and z > roof_surface(g, y) + 0.004:
                under.append('%s z=%.3f при y=%.2f (скат %.3f)'
                             % (p['name'], z, y, roof_surface(g, y)))
                break
    gates = [p['name'] for p in parts if p['name'].startswith('gate_leaf_')]
    glass = [p['name'] for p in parts if p['name'] == 'win_glass']
    mf = B.min_feature(parts)
    rows = []
    A = rows.append
    A('вариант %s' % key)
    A('  треугольники      %d   (бюджет building 300..1500: %s)'
      % (st['tris'], 'ОК' if 300 <= st['tris'] <= 1500 else 'ПРОВАЛ'))
    A('  вершины/детали    %d / %d' % (st['verts'], st['parts']))
    A('  габарит X x Y x Z %.3f x %.3f x %.3f'
      % (bb['size'][0], bb['size'][1], bb['size'][2]))
    A('  пятно             X [%+.3f %+.3f]  Y [%+.3f %+.3f]  (лимит +-%.1f)'
      % (bb['x'][0], bb['x'][1], bb['y'][0], bb['y'][1], B.FP / 2))
    A('  высота            %.3f  (низ z=%+.3f, верх z=%+.3f)'
      % (bb['size'][2], bb['z'][0], bb['z'][1]))
    A('  уклон ската       %.1f град  (канон 32..55)'
      % math.degrees(g.pitch))
    A('  свес по скату     %.3f = %.1f%% глубины стены (канон 11..31%%)'
      % (g.over_slope, 100.0 * g.over_slope / (2 * B.HY)))
    A('  свес по торцу     %.3f = %.1f%% длины стены (канон 4..13%%)'
      % (g.over_end, 100.0 * g.over_end / (2 * B.HX)))
    A('  кровля шире стен  кромка ската y=%.3f против стены y=%.3f -> %s'
      % (g.y_eave, B.HY, 'ОК' if g.y_eave > B.HY else 'ПРОВАЛ'))
    A('  конёк z           %.3f;  труба до z=%.3f (+%.3f над коньком)'
      % (g.z_ridge, bb['z'][1], bb['z'][1] - g.z_ridge))
    A('  труба от конька   |x|=%.3f (канон 0.3..0.6), y=%.3f (на скате)'
      % (abs(B.CHIM_X), B.CHIM_Y))
    A('  воротца           %.2f x %.2f, створок %d;  окно %.2f на стене %s, шт %d'
      % (cfg['gate_w'], cfg['gate_h'], len(gates), B.WIN, cfg['win_wall'], len(glass)))
    A('  мин. деталь       %.3f «%s» (канон: не мельче 0.02)' % mf)
    A('  треугольники по семействам: %s'
      % ', '.join('%s %d' % (k, fam[k]) for k in sorted(fam)))
    A('  семейства вне палитры: %s'
      % (', '.join(sorted(set(fam) - set(B.FAMILIES))) or 'нет'))
    A('  замкнутость       %s' % ('все детали замкнуты' if not bad_closed
                                  else 'РАЗОМКНУТО: %s' % bad_closed))
    A('  нормали наружу    %s' % ('объём > 0 у всех деталей' if not bad_vol
                                  else 'ВЫВЕРНУТО: %s' % bad_vol))
    A('  вырожденные грани %s' % ('нет' if not bad_degen else 'ЕСТЬ: %s' % bad_degen))
    A('  каркас под кровлей %s' % ('не торчит' if not under
                                   else 'ТОРЧИТ: %s' % '; '.join(under[:4])))
    ok = (300 <= st['tris'] <= 1500 and xmax <= B.FP / 2 + TOL
          and ymax <= B.FP / 2 + TOL and abs(bb['z'][0]) < 0.01
          and not bad_closed and not bad_vol and not bad_degen and not under
          and 32 <= math.degrees(g.pitch) <= 55 and mf[0] >= 0.02)
    A('  ВЕРДИКТ           %s' % ('ОК' if ok else 'ЕСТЬ ПРОВАЛЫ'))
    return rows, ok


def main():
    keys = [sys.argv[1]] if len(sys.argv) > 1 else sorted(B.VARIANTS)
    rows, allok = [], True
    for k in keys:
        r, ok = variant_report(k)
        rows += r + ['']
        allok = allok and ok
    text = '\n'.join(rows)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(text)
    print(text)
    print('report -> %s  (%s)' % (OUT, 'ОК' if allok else 'ПРОВАЛЫ'))
    return 0 if allok else 1


if __name__ == '__main__':
    sys.exit(main())
