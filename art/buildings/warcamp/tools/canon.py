"""canon.py — приёмка постройки по канону, без Blender.

Отвечает числами на то, что глазами не проверяется:
    * габарит и посадка в пятно застройки;
    * ярусы (цоколь / стены / конёк / труба) и их доли;
    * уклон ската, свесы по скату и по торцу;
    * бюджет трис класса объекта;
    * НАПРАВЛЕНИЕ НОРМАЛЕЙ: вывернутый фасет в спрайте чёрный, и заметить его
      на рендере труднее, чем в отчёте;
    * вырожденные грани, рёбра «дважды в одну сторону», нулевой объём.

    $PY3 canon.py --gen tools/building.py            # отчёт + приговор
    $PY3 canon.py --gen tools/building.py --json out/report.json

Числа берутся из `SPEC` генератора (словарь в модуле) — генератор знает свои
размеры, приёмка не должна их угадывать.  Чего в SPEC нет, берётся из канона.
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import forge as F                                              # noqa: E402
import xray as X                                               # noqa: E402

# Канон класса `building` (см. references/anatomy.md).  Диапазоны — из набора
# эталонных построек, а не «на глаз»: за их пределами силуэт перестаёт
# читаться как постройка этого стиля.
CANON = dict(
    footprint=(3, 2),
    h_b=(2.60, 3.00),          # полная высота с трубой
    wall_h=(1.20, 1.50),
    pitch=(32.0, 55.0),        # солома 45..55, тёс 32..35
    over_slope=(0.11, 0.31),   # доля ширины стены
    over_end=(0.04, 0.13),
    roof_wall=(0.45, 1.35),    # высота кровли / высота стен
    min_detail=0.02,           # деталь мельче не доедет до спрайта
    tris=(300, 1500),
)

DEFAULT_SPEC = dict(footprint=(3, 2), wall_h=1.35, pitch_deg=47.0,
                    over_slope=0.18, over_end=0.11, wall_x=2.76, wall_y=1.64,
                    z_plinth=0.16, z_wall=1.51, class_='building')


def load_spec(gen_path, variant=None):
    """SPEC генератора поверх канонных умолчаний + полный список деталей."""
    parts = X.load_parts(gen_path, variant)
    spec = dict(DEFAULT_SPEC)
    import importlib.util
    spec_mod = importlib.util.spec_from_file_location(
        'forge_gen2', os.path.abspath(gen_path))
    mod = importlib.util.module_from_spec(spec_mod)
    spec_mod.loader.exec_module(mod)
    spec.update(getattr(mod, 'SPEC', {}) or {})
    return parts, spec


# --------------------------------------------------------------------------
# НОРМАЛИ И ГРАНИ
# --------------------------------------------------------------------------
def _signed_volume(verts, faces):
    vol = 0.0
    for f in faces:
        for k in range(1, len(f) - 1):
            a, b, c = verts[f[0]], verts[f[k]], verts[f[k + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                    - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return vol


def check_normals(parts):
    """Согласованность обхода и НАРУЖУ-ориентация. Пусто = чисто.

    Тест 1 (жёсткий): ни одно направленное ребро не встречается дважды —
    иначе у детали вывернут фасет.
    Тест 2 (для замкнутых): знаковый объём > 0, то есть нормали наружу.
    Тест 3 (для оболочек-коробов): нормаль каждого фасета смотрит от центра.
    """
    bad = []
    for p in parts:
        v, f = p['verts'], p['faces']
        seen = {}
        for i, fc in enumerate(f):
            if len(fc) < 3:
                bad.append((p['name'], 'фасет меньше треугольника', i))
                continue
            for k in range(len(fc)):
                e = (fc[k], fc[(k + 1) % len(fc)])
                if e in seen:
                    bad.append((p['name'], 'ребро дважды в одну сторону', i))
                seen[e] = i
            n = F.face_normal(v, fc)
            if n is None or _area(v, fc) < 1e-9:
                bad.append((p['name'], 'вырожденный фасет', i))
        closed = all((b, a) in seen for (a, b) in seen)
        if closed:
            if _signed_volume(v, f) <= 0:
                bad.append((p['name'], 'объём<=0 (нормали внутрь)',
                            round(_signed_volume(v, f), 6)))
        elif len(v) == 8 and len(f) < 6:
            c = [sum(q[k] for q in v) / float(len(v)) for k in range(3)]
            for i, fc in enumerate(f):
                n = F.face_normal(v, fc)
                fc_c = [sum(v[j][k] for j in fc) / float(len(fc))
                        for k in range(3)]
                if sum((fc_c[k] - c[k]) * n[k] for k in range(3)) < -1e-6:
                    bad.append((p['name'], 'фасет смотрит внутрь', i))
    return bad


def _area(verts, f):
    p = [verts[i] for i in f]
    s = 0.0
    for k in range(1, len(p) - 1):
        a = (p[k][0] - p[0][0], p[k][1] - p[0][1], p[k][2] - p[0][2])
        b = (p[k + 1][0] - p[0][0], p[k + 1][1] - p[0][1],
             p[k + 1][2] - p[0][2])
        cr = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
              a[0] * b[1] - a[1] * b[0])
        s += 0.5 * math.sqrt(sum(c * c for c in cr))
    return s


# --------------------------------------------------------------------------
# ГАБАРИТ, ЯРУСЫ, ПРОПОРЦИИ
# --------------------------------------------------------------------------
def measure(parts, spec):
    xs = [p[0] for part in parts for p in part['verts']]
    ys = [p[1] for part in parts for p in part['verts']]
    zs = [p[2] for part in parts for p in part['verts']]
    box = dict(x=(min(xs), max(xs)), y=(min(ys), max(ys)), z=(min(zs), max(zs)))
    fam = {}
    for part in parts:
        d = fam.setdefault(part['family'], [0, 0])
        d[0] += 1
        d[1] += sum(len(f) - 2 for f in part['faces'])
    ridge = spec.get('ridge_z')
    wall = spec.get('z_wall', 1.51)
    roof_h = (ridge - wall) if ridge else None
    return dict(
        parts=len(parts),
        verts=sum(len(p['verts']) for p in parts),
        tris=sum(sum(len(f) - 2 for f in p['faces']) for p in parts),
        families={k: dict(parts=v[0], tris=v[1]) for k, v in sorted(fam.items())},
        bbox=dict(x=[round(box['x'][0], 3), round(box['x'][1], 3)],
                  y=[round(box['y'][0], 3), round(box['y'][1], 3)],
                  z=[round(box['z'][0], 3), round(box['z'][1], 3)]),
        size=[round(box['x'][1] - box['x'][0], 3),
              round(box['y'][1] - box['y'][0], 3),
              round(box['z'][1] - box['z'][0], 3)],
        tiers=dict(plinth_top=spec.get('z_plinth'), wall_top=wall,
                   ridge=ridge, roof_top=round(max(zs), 3)),
        pitch_deg=spec.get('pitch_deg'),
        over_slope=spec.get('over_slope'), over_end=spec.get('over_end'),
        over_slope_ratio=round(spec.get('over_slope', 0) /
                               spec.get('wall_y', 1.64), 3),
        over_end_ratio=round(spec.get('over_end', 0) /
                             spec.get('wall_x', 2.76), 3),
        roof_wall_ratio=(round(roof_h / spec['wall_h'], 3)
                         if roof_h and spec.get('wall_h') else None),
        box=box)


def gate(rep, spec, palette=None):
    """Список (ok, текст) — приговор по канону.

    Диапазоны берутся из SPEC['canon'], если генератор их задал: у сарая 2x2 и
    у дома 3x2 канон разный (амбар приземистый, крыша вполовину стен), и
    приёмка не должна мерить сарай линейкой дома.
    """
    C = dict(CANON)
    C.update(spec.get('canon', {}) or {})
    P = palette or F.Palette()
    lo, hi = P.budget(spec.get('class_', 'building')) or C['tris']
    g = []
    g.append((lo <= rep['tris'] <= hi,
              'полигонаж %d в бюджете класса %s %d..%d'
              % (rep['tris'], spec.get('class_', 'building'), lo, hi)))
    h = rep['bbox']['z'][1]
    g.append((C['h_b'][0] - 0.25 <= h <= C['h_b'][1] + 0.2,
              'высота постройки %.2f (канон %.2f..%.2f)'
              % (h, *C['h_b'])))
    # У ДВОРА без стен (лагерь, стоянка, площадка) нет ни стены, ни ската:
    # мерить их линейкой дома нельзя.  Канон класса — yard.md; высота задаётся
    # своим диапазоном h_b, а не «высотой стены».
    if spec.get('class_') != 'yard':
        g.append((C['wall_h'][0] - 0.2 <= spec.get('wall_h', 1.35)
                  <= C['wall_h'][1] + 0.2,
                  'высота стен %.2f (канон %.2f..%.2f)'
                  % (spec.get('wall_h', 1.35), *C['wall_h'])))
    if rep.get('pitch_deg'):
        g.append((C['pitch'][0] <= rep['pitch_deg'] <= C['pitch'][1],
                  'уклон ската %.1f град (канон %.0f..%.0f)'
                  % (rep['pitch_deg'], *C['pitch'])))
    if rep.get('over_slope_ratio'):
        g.append((C['over_slope'][0] <= rep['over_slope_ratio']
                  <= C['over_slope'][1],
                  'свес по скату %.0f%% ширины стены (канон %.0f..%.0f%%)'
                  % (rep['over_slope_ratio'] * 100, C['over_slope'][0] * 100,
                     C['over_slope'][1] * 100)))
    if rep.get('over_end_ratio'):
        g.append((C['over_end'][0] <= rep['over_end_ratio']
                  <= C['over_end'][1],
                  'свес по торцу %.0f%% (канон %.0f..%.0f%%)'
                  % (rep['over_end_ratio'] * 100, C['over_end'][0] * 100,
                     C['over_end'][1] * 100)))
    if rep.get('roof_wall_ratio'):
        g.append((C['roof_wall'][0] <= rep['roof_wall_ratio']
                  <= C['roof_wall'][1],
                  'кровля/стены %.2f (канон %.2f..%.2f)'
                  % (rep['roof_wall_ratio'], *C['roof_wall'])))
    fx, fy = spec.get('footprint', C['footprint'])
    bx, by = rep['bbox']['x'], rep['bbox']['y']
    g.append((abs(bx[0]) <= fx / 2.0 + 0.03 and abs(bx[1]) <= fx / 2.0 + 0.03
              and abs(by[0]) <= fy / 2.0 + 0.03
              and abs(by[1]) <= fy / 2.0 + 0.03,
              'габарит %.2f x %.2f в пятне %dx%d (запас 0.03)'
              % (bx[1] - bx[0], by[1] - by[0], fx, fy)))
    # минимальная деталь: ничего мельче min_detail по любому габариту
    tiny = []
    for p in rep.get('_parts', []):
        xs = [v[0] for v in p['verts']]
        ys = [v[1] for v in p['verts']]
        zs = [v[2] for v in p['verts']]
        s = sorted([max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)])
        if s[1] < C['min_detail']:
            tiny.append(p['name'])
    g.append((not tiny, 'деталей мельче %.2f — %d%s'
              % (C['min_detail'], len(tiny),
                 (' (%s)' % ', '.join(tiny[:4])) if tiny else '')))
    return g


def main():
    ap = argparse.ArgumentParser(description='приёмка постройки по канону')
    ap.add_argument('--gen', required=True)
    ap.add_argument('--json', dest='json_out')
    ap.add_argument('--variant', default=None)
    args = ap.parse_args()
    parts, spec = load_spec(args.gen, args.variant)
    rep = measure(parts, spec)
    rep['_parts'] = parts
    bad = check_normals(parts)
    rep['normal_issues'] = bad[:20]
    rep['normal_issue_count'] = len(bad)
    verdict = gate(rep, spec)
    rep.pop('_parts', None)
    print(json.dumps(rep, ensure_ascii=False, indent=1))
    print('--- канон ---')
    for ok, text in verdict:
        print('%s %s' % ('OK  ' if ok else 'FAIL', text))
    if bad:
        print('--- нормали/грани ---')
        for b in bad[:20]:
            print('  ', b)
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
    ok_all = not bad and all(ok for ok, _ in verdict)
    print('ИТОГ: %s' % ('ПРИНЯТО' if ok_all else 'НЕ ПРИНЯТО'))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
