"""check_atlas.py — СВЕРКА атласа руин с целыми атласами и с моделью.

    $PY3 tools/check_atlas.py

Три проверки, все печатаются числом:

1. **anchor/ground/mul/footprint/ppu** каждого кадра руин против целого атласа
   того же типа и поворота.  Расхождение — FAIL (правило заказчика: подмена
   спрайта не должна сдвигать постройку).
2. **Кадры на месте**: 20 кадров, имена `<тип>_<поворот>`, у каждого свой
   `variant` = имя типа, `rotation` = 0/90/180/270.
3. **Основание по модели** против скопированного `ground`: печатается
   расхождение центра и габарита.  Это НЕ FAIL: у ратуши `ground` считан по
   пикселям целого кадра и асимметричен, у руины основание симметрично; число
   выводится, чтобы расхождение было видно, а не спрятано.
"""
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')

ROTATIONS = (0, 90, 180, 270)
TYPES = ('townhall', 'house', 'lumbercamp', 'barracks', 'warcamp')
GROUND_Z = 0.025


def load_gen(t):
    path = os.path.join(HERE, 'ruin_%s.py' % t)
    spec = importlib.util.spec_from_file_location('check_' + t, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['check_' + t] = mod
    spec.loader.exec_module(mod)
    return mod


def ground_from_model(parts, rotation):
    """Контакт с полом в клетках карты — той же конвенцией, что у соседей."""
    th = math.radians(rotation)
    c, s = math.cos(th), math.sin(th)
    xs, ys = [], []
    for p in parts:
        lo = min(v[2] for v in p['verts'])
        if lo > GROUND_Z:
            continue
        for v in p['verts']:
            if v[2] > lo + 0.05:
                continue
            x, y = v[0] * c - v[1] * s, v[0] * s + v[1] * c
            xs.append(-x)
            ys.append(y)
    return [round(min(xs), 3), round(max(xs), 3), round(min(ys), 3),
            round(max(ys), 3)]


def main():
    with open(os.path.join(GAME, 'assets', 'ruins', 'atlas.json'),
              encoding='utf-8') as f:
        ruins = json.load(f)
    fails, warns = [], []
    print('== 20 кадров ==')
    names = set()
    for t in TYPES:
        for rot in ROTATIONS:
            name = '%s_%d' % (t, rot)
            names.add(name)
            fr = ruins['frames'].get(name)
            if fr is None:
                fails.append('нет кадра %s' % name)
                continue
            if fr['variant'] != t:
                fails.append('%s: variant %r, ждали %r'
                             % (name, fr['variant'], t))
            if fr['rotation'] != rot:
                fails.append('%s: rotation %r' % (name, fr['rotation']))
    if len(ruins['frames']) != 20:
        fails.append('кадров %d, ждали 20' % len(ruins['frames']))
    extra = set(ruins['frames']) - names
    if extra:
        fails.append('лишние кадры: %s' % ', '.join(sorted(extra)))
    print('  кадров %d, имён не хватает/лишних: %d'
          % (len(ruins['frames']), len(extra)))

    print('\n== anchor / ground / mul / footprint против целых атласов ==')
    for t in TYPES:
        whole_path = os.path.join(REPO, ruins['types'][t]['source'])
        with open(whole_path, encoding='utf-8') as f:
            whole = json.load(f)
        # целые кадры: префиксы из targets.py (a для четырёх, x для лагеря)
        prefixes = {'townhall': 'townhall_a_', 'house': 'sh_a_',
                    'lumbercamp': 'lc_a_', 'barracks': 'br_a_',
                    'warcamp': 'wc_'}
        for rot in ROTATIONS:
            name = '%s_%d' % (t, rot)
            fr = ruins['frames'][name]
            wf = whole['frames'][prefixes[t] + str(rot)]
            bad = []
            if abs(fr['anchorX'] - wf['anchorX']) > 0.01:
                bad.append('anchorX %.2f vs %.2f'
                           % (fr['anchorX'], wf['anchorX']))
            if abs(fr['anchorY'] - wf['anchorY']) > 0.01:
                bad.append('anchorY %.2f vs %.2f'
                           % (fr['anchorY'], wf['anchorY']))
            for k in range(4):
                if abs(fr['ground'][k] - wf['ground'][k]) > 0.001:
                    bad.append('ground[%d] %.3f vs %.3f'
                               % (k, fr['ground'][k], wf['ground'][k]))
            if list(fr['footprint']) != list(wf['footprint']):
                bad.append('footprint %s vs %s'
                           % (fr['footprint'], wf['footprint']))
            if abs(fr['mul'] - whole['mul']) > 1e-6:
                bad.append('mul %.4f vs %.4f' % (fr['mul'], whole['mul']))
            if abs(fr['ppu_native'] - whole['ppu']) > 1e-6:
                bad.append('ppu %.1f vs %.1f' % (fr['ppu_native'],
                                                 whole['ppu']))
            if bad:
                fails.append('%s: %s' % (name, '; '.join(bad)))
        print('  %-11s anchor/ground/mul/footprint/ppu %s'
              % (t, 'СОВПАЛИ' if not any(f.startswith(t) for f in fails)
                 else 'РАСХОЖДЕНИЕ'))

    print('\n== основание по модели против скопированного ground ==')
    for t in TYPES:
        gen = load_gen(t)
        parts = gen.build()
        for rot in ROTATIONS:
            g = ground_from_model(parts, rot)
            gs = ruins['frames']['%s_%d' % (t, rot)]['ground']
            mx = (g[0] + g[1]) / 2.0 - (gs[0] + gs[1]) / 2.0
            my = (g[2] + g[3]) / 2.0 - (gs[2] + gs[3]) / 2.0
            dx = (g[1] - g[0]) - (gs[1] - gs[0])
            dy = (g[3] - g[2]) - (gs[3] - gs[2])
            print('  %-11s %3d  модель x %+.3f..%+.3f y %+.3f..%+.3f  '
                  'середина %+.2f,%+.2f  габарит %+.2f,%+.2f'
                  % (t, rot, g[0], g[1], g[2], g[3], mx, my, dx, dy))
            if abs(mx) > 0.30 or abs(my) > 0.30:
                warns.append('%s_%d: середина основания ушла на %.2f,%.2f '
                             'клетки от целой' % (t, rot, mx, my))

    print('\n== ИТОГ ==')
    for f in fails:
        print('FAIL', f)
    for w in warns:
        print('WARN', w)
    print('ИТОГ: %s (провалов %d, предупреждений %d)'
          % ('ПРИНЯТО' if not fails else 'НЕ ПРИНЯТО', len(fails), len(warns)))
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main())
