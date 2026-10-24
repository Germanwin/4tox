"""place_barracks.py — приёмка посадки казармы в пятно 4 x 3.

    $PY3 tools/place_barracks.py

Что проверяется (правило заказчика 2026-10-13: основание стоит серединой в
середине пятна и с зазором до всех четырёх кромок):

  1) атлас собран: 2 варианта x 4 поворота, пятно 4 x 3 (на 90/270 — 3 x 4),
     ppu и камера канонные;
  2) крупность спрайта равна ОБЩЕМУ правилу посадки `siteMul(4)` из
     `mapgen2/js/buildings.js` ((1 − 2·BASE_MARGIN/сторона) · MARGIN_K = 0.7667),
     а не подобрана;
  3) наземный контур в атласе — тот же, что даёт модель (поворот в поворот);
  4) после сдвига точки опоры на середину контура (`anchorShift`) и поджатия
     на крупность (`scaleAt`) контур ложится ВНУТРЬ пятна, зазор по ДЛИННОЙ
     стороне — в ратушиной полосе 0.400..0.497 (допуск −0.02/+0.04, как у
     `mapgen2/tools/place.js`), и ни с одной кромки не меньше BASE_MARGIN;
  5) середина контура совпадает с серединой пятна (<= 0.05 клетки);
  6) спрайт — это действительно ЭТА модель: габарит силуэта по пикселям
     сходится с проекцией габарита модели (ловит устаревший рендер).

ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ `mapgen2/tools/place.js`
------------------------------------------------
`place.js` — приёмочный тест ТРЁХ построек, которые уже стоят в игре: он
перебирает `Buildings.TYPE_IDS` и грузит атласы в браузер. Казарма в игру НЕ
поставлена (так решил заказчик), типа `barracks` в `TYPES` нет, и `place.js`
её не увидит. Поэтому посадка проверяется здесь — ТЕМИ ЖЕ формулами
(`fitMul`, `siteMul`, `anchorShift`, `BASE_MARGIN`, полоса `place.js`
0.400..0.497), продублированными только потому, что браузера в этой проверке
нет. Если правило в игре поменяют, числа разъедутся и эта проверка скажет
об этом первой.

Контур берётся из атласа (поле `ground`, посчитано по модели) — как у дома
жителя и у лагеря. Пиксельный замер тут не годится: на плацу стоят разреженные
предметы, сплошного цоколя под ними нет (разбор — в шапке `pack_barracks.py`).
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
ATLAS = os.path.join(GAME, 'assets', 'barracks')

sys.path.insert(0, HERE)
import pack_barracks as P                                      # noqa: E402

BASE_MARGIN = 1.0 / 3.0
MARGIN_K = 0.92
TOL_PX = 4.0
TOL_GROUND = 0.02
# Полоса `place.js`: отступы ратуши (0.400..0.497) плюс 0.02 снизу и 0.04 сверху
BAND_LO, BAND_HI = 0.400 - 0.02, 0.497 + 0.04


def site_mul(side):
    return (1.0 - 2.0 * BASE_MARGIN / side) * MARGIN_K


def project(x, y, z, ppu, az, el):
    """Мир -> пиксели кадра относительно точки опоры.

        px = -(x + y) * pxc,   py = (-(x - y) - 2z) * pyc

    Формула камеры пайплайна (`blender_live.setup`); сверена с альфа-каналом
    рендера по IoU 0.98 на всех четырёх поворотах.
    """
    pxc = math.cos(math.radians(az)) * ppu
    pyc = math.sin(math.radians(el)) * pxc
    return (-(x + y) * pxc, (-(x - y) - 2.0 * z) * pyc)


def main():
    fails = []

    def check(name, ok, extra=''):
        print('%s %s%s' % ('  ok  ' if ok else '  FAIL', name,
                           ('   ' + extra) if extra else ''))
        if not ok:
            fails.append(name)

    with open(os.path.join(ATLAS, 'atlas.json'), encoding='utf-8') as fh:
        meta = json.load(fh)
    print('атлас %s' % os.path.join(os.path.relpath(ATLAS, GAME), 'atlas.json'))

    frames = {f['variant']: {} for f in meta['frames'].values()}
    for f in meta['frames'].values():
        frames[f['variant']][f['rotation']] = f

    check('2 варианта x 4 поворота',
          sorted(frames) == ['a', 'b']
          and all(sorted(v) == [0, 90, 180, 270] for v in frames.values()),
          'варианты %s' % sorted(frames))
    fp_ok = all(f['footprint'] == ([4, 3] if f['rotation'] in (0, 180) else [3, 4])
                for v in frames.values() for f in v.values())
    check('пятно 4 x 3 на 0/180 и 3 x 4 на 90/270', fp_ok,
          '%s' % {f['rotation']: f['footprint']
                  for f in frames['a'].values()})
    check('камера и масштаб канонные',
          abs(meta['ppu'] - 96.0) < 1e-6 and abs(meta['az_deg'] - 45.0) < 1e-6
          and abs(meta['el_deg'] - 35.264389682754654) < 1e-9,
          'ppu %s, az %s, el %s' % (meta['ppu'], meta['az_deg'], meta['el_deg']))

    rule = site_mul(4)
    check('крупность спрайта — siteMul(4) (правило x 0.92)',
          abs(meta['mul'] - rule) < 1e-4,
          'mul %s, правило %.4f' % (meta['mul'], rule))

    gen = P.load_generator()
    atlas = Image.open(os.path.join(ATLAS, meta['atlas'])).convert('RGBA')
    arr = np.asarray(atlas)

    print('\nпосадка по кадрам (клетки карты):')
    for var in sorted(frames):
        parts = gen.build(var)
        for rot in sorted(frames[var]):
            f = frames[var][rot]
            spr = arr[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']]
            sa = spr[:, :, 3]
            ys, xs = np.nonzero(sa > 200)
            if not len(xs):
                check('%s_%d: кадр не пустой' % (var, rot), False)
                continue

            gm = P.ground_from_model(parts, rot)
            check('%s_%d: наземный контур в атласе — тот же, что у модели'
                  % (var, rot),
                  all(abs(a - b) <= TOL_GROUND for a, b in zip(gm, f['ground'])),
                  'модель [%.3f %.3f %.3f %.3f] атлас %s'
                  % (gm[0], gm[1], gm[2], gm[3],
                     ['%.3f' % v for v in f['ground']]))

            hw, hh = f['footprint'][0] / 2.0, f['footprint'][1] / 2.0
            shx = (f['ground'][0] + f['ground'][1]) / 2.0 * meta['mul']
            shy = (f['ground'][2] + f['ground'][3]) / 2.0 * meta['mul']
            dr = [f['ground'][0] * meta['mul'] - shx,
                  f['ground'][1] * meta['mul'] - shx,
                  f['ground'][2] * meta['mul'] - shy,
                  f['ground'][3] * meta['mul'] - shy]
            left, right = hw + dr[0], hw - dr[1]
            back, front = hh + dr[2], hh - dr[3]
            long_gap = min(left, right) if hw >= hh else min(back, front)
            cx, cy = (dr[0] + dr[1]) / 2.0, (dr[2] + dr[3]) / 2.0
            print('    %s_%d: запас л%+.3f п%+.3f з%+.3f ф%+.3f | шихта '
                  '%.2f x %.2f | середина %+.3f/%+.3f'
                  % (var, rot, left, right, back, front,
                     dr[1] - dr[0], dr[3] - dr[2], cx, cy))
            check('%s_%d: зазор с любой кромки не меньше BASE_MARGIN (%.3f)'
                  % (var, rot, BASE_MARGIN),
                  min(left, right, back, front) >= BASE_MARGIN - 1e-6,
                  'минимум %.3f' % min(left, right, back, front))
            check('%s_%d: зазор по длинной стороне в ратушиной полосе %.3f..%.3f'
                  % (var, rot, BAND_LO, BAND_HI),
                  BAND_LO <= long_gap <= BAND_HI,
                  'зазор %.3f' % long_gap)
            check('%s_%d: середина контура — в середине пятна (<= 0.05)'
                  % (var, rot),
                  abs(cx) <= 0.05 and abs(cy) <= 0.05,
                  '%+.3f/%+.3f' % (cx, cy))

            pts = [v for p in parts for v in p['verts']]
            th = math.radians(rot)
            c, s = math.cos(th), math.sin(th)
            pxs, pys = [], []
            for v in pts:
                x, y = v[0] * c - v[1] * s, v[0] * s + v[1] * c
                dx, dy = project(x, y, v[2], meta['ppu'], meta['az_deg'],
                                 meta['el_deg'])
                pxs.append(dx)
                pys.append(dy)
            ax, ay = f['anchorX'], f['anchorY']
            want = (ax + min(pxs), ax + max(pxs), ay + min(pys), ay + max(pys))
            got = (xs.min(), xs.max(), ys.min(), ys.max())
            dev = max(abs(a - b) for a, b in zip(want, got))
            check('%s_%d: силуэт спрайта — проекция габарита модели'
                  % (var, rot), dev <= TOL_PX + 2.0,
                  'расхождение %.1f px (порог %.1f)' % (dev, TOL_PX + 2.0))

    print('\nИТОГ: %s' % ('ПРИНЯТО' if not fails else 'НЕ ПРИНЯТО (%d)' % len(fails)))
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main())
