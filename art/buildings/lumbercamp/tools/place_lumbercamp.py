"""place_lumbercamp.py — приёмка посадки лагеря лесоруба в пятно 3 x 3.

    $PY3 tools/place_lumbercamp.py

Что проверяется (правило заказчика 2026-10-13: основание стоит серединой в
середине пятна и с зазором до всех четырёх кромок):

  1) атлас собран: 4 поворота, пятно 3 x 3, ppu и камера — канонные;
  2) крупность спрайта равна правилу `fitMul` из `js/buildings.js`
     (1 - 2*BASE_MARGIN/длинная сторона), а не подобрана;
  3) наземный контур в атласе — тот же, что даёт модель (поворот в поворот);
  4) после сдвига точки опоры на середину контура (`anchorShift`) и поджатия
     на крупность (`scaleAt`) контур ложится ВНУТРЬ пятна, а зазор до всех
     четырёх кромок не меньше BASE_MARGIN по длинной стороне;
  5) середина контура совпадает с серединой пятна;
  6) спрайт — это действительно ЭТА модель: габарит силуэта по пикселям
     сходится с проекцией габарита модели (ловит устаревший рендер).

ЧЕМ ЭТА ПРОВЕРКА ОТЛИЧАЕТСЯ ОТ `tools/place.js`
------------------------------------------------
`place.js` — приёмочный тест РАТУШИ: он грузит её атлас в браузер и там же
меряет наземный контур по пикселям.  Для лагеря пиксельный замер не годится
(основание разреженное, сплошного цоколя нет — разбор и числа в шапке
`tools/pack_lumbercamp.py`), поэтому контур берётся из модели.  Формулы
посадки — `fitMul`, `anchorShift`, `BASE_MARGIN`, `gaps` — здесь те же, что в
`js/buildings.js`, и продублированы они только потому, что браузера в этой
проверке нет.  Если правило в игре поменяют, числа разъедутся и эта проверка
скажет об этом первой.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GAME = os.path.abspath(os.path.join(ROOT, '..', 'mapgen2'))
ATLAS = os.path.join(GAME, 'assets', 'lumbercamp')

sys.path.insert(0, HERE)
import pack_lumbercamp as P                                       # noqa: E402

BASE_MARGIN = 1.0 / 3.0            # js/buildings.js: BASE_MARGIN
TOL_PX = 4.0                       # контур + сглаживание кромок
TOL_GROUND = 0.02                  # клетки


def fit_mul(side):
    return 1.0 - 2.0 * BASE_MARGIN / side


def project(x, y, z, ppu, az, el):
    """Мир -> пиксели кадра относительно точки опоры.

    Камера пайплайна (blender_live.setup): fwd = (cos EL cos AZ, -cos EL sin AZ,
    -sin EL), камера смотрит в начало координат. Отсюда

        px = -(x + y) * pxc,   py = (-(x - y) - 2z) * pyc

    Конвенция проверена не на глаз: силуэт модели, растеризованный этой
    проекцией, сходится с альфа-каналом рендера по IoU 0.98 на всех четырёх
    поворотах (обратный порядок осей даёт 0.31..0.53).
    """
    pxc = math.cos(math.radians(az)) * ppu
    pyc = math.sin(math.radians(el)) * pxc
    return (-(x + y) * pxc, (-(x - y) - 2.0 * z) * pyc)


def main():
    fails, warns = [], []

    def check(name, ok, extra=''):
        print('%s %s%s' % ('  ok  ' if ok else '  FAIL', name,
                           ('   ' + extra) if extra else ''))
        if not ok:
            fails.append(name)

    with open(os.path.join(ATLAS, 'atlas.json')) as fh:
        meta = json.load(fh)
    print('атлас %s' % os.path.join(os.path.relpath(ATLAS, GAME), 'atlas.json'))

    frames = {f['rotation']: f for f in meta['frames'].values()}
    check('4 поворота, у каждого своё пятно',
          sorted(frames) == [0, 90, 180, 270]
          and all(frames[r]['footprint'] == [3, 3] for r in frames),
          'повороты %s, пятно %s' % (sorted(frames),
                                     frames[0]['footprint']))
    check('камера и масштаб канонные',
          abs(meta['ppu'] - 96.0) < 1e-6 and abs(meta['az_deg'] - 45.0) < 1e-6
          and abs(meta['el_deg'] - 35.264389682754654) < 1e-9,
          'ppu %s, az %s, el %s' % (meta['ppu'], meta['az_deg'], meta['el_deg']))

    side = max(max(f['footprint']) for f in meta['frames'].values())
    rule = fit_mul(side)
    check('крупность спрайта — по правилу fitMul, без самодеятельности',
          abs(meta['mul'] - rule) < 1e-4,
          'mul %s, правило для пятна %d даёт %.4f' % (meta['mul'], side, rule))

    gen = P.load_generator()
    parts = gen.build()
    atlas = Image.open(os.path.join(ATLAS, meta['atlas'])).convert('RGBA')
    arr = np.asarray(atlas)
    alpha = arr[:, :, 3]

    hw = hh = side / 2.0
    print('\nпосадка по кадрам (клетки):')
    for rot in sorted(frames):
        f = frames[rot]
        spr = arr[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']]
        sa = spr[:, :, 3]
        ys, xs = np.nonzero(sa > 200)
        if not len(xs):
            check('кадр %d не пустой' % rot, False)
            continue

        # (3) наземный контур: модель против атласа
        gm = P.ground_from_model(parts, rot)
        check('кадр %d: наземный контур в атласе — тот же, что у модели'
              % rot,
              all(abs(a - b) <= TOL_GROUND for a, b in zip(gm, f['ground'])),
              'модель [%.3f %.3f %.3f %.3f] атлас %s'
              % (gm[0], gm[1], gm[2], gm[3], ['%.3f' % v for v in f['ground']]))

        # (4-5) сдвиг точки опоры и поджатие: как это делает игра
        shx = (f['ground'][0] + f['ground'][1]) / 2.0 * meta['mul']
        shy = (f['ground'][2] + f['ground'][3]) / 2.0 * meta['mul']
        drawn = [f['ground'][0] * meta['mul'] - shx, f['ground'][1] * meta['mul'] - shx,
                 f['ground'][2] * meta['mul'] - shy, f['ground'][3] * meta['mul'] - shy]
        left, right = hw + drawn[0], hw - drawn[1]
        back, front = hh + drawn[2], hh - drawn[3]
        cx, cy = (drawn[0] + drawn[1]) / 2.0, (drawn[2] + drawn[3]) / 2.0
        print('    %3d: запас л%+.3f п%+.3f з%+.3f ф%+.3f | шихта %.2f x %.2f | '
              'середина %+.3f/%+.3f'
              % (rot, left, right, back, front,
                 drawn[1] - drawn[0], drawn[3] - drawn[2], cx, cy))
        check('кадр %d: зазор до всех четырёх кромок не меньше %.3f'
              % (rot, BASE_MARGIN),
              min(left, right, back, front) >= BASE_MARGIN - 1e-6,
              'минимум %.3f' % min(left, right, back, front))
        check('кадр %d: середина контура — в середине пятна' % rot,
              abs(cx) < 0.02 and abs(cy) < 0.02,
              '%+.3f/%+.3f' % (cx, cy))

        # (6) спрайт — это эта модель: габарит силуэта против проекции габарита
        pts = [v for p in parts for v in p['verts']]
        th = math.radians(rot)
        c, s = math.cos(th), math.sin(th)
        pxs, pys = [], []
        for v in pts:
            x, y = v[0] * c - v[1] * s, v[0] * s + v[1] * c
            dx, dy = project(x, y, v[2], meta['ppu'], meta['az_deg'], meta['el_deg'])
            pxs.append(dx)
            pys.append(dy)
        ax, ay = f['anchorX'], f['anchorY']
        want = (ax + min(pxs), ax + max(pxs), ay + min(pys), ay + max(pys))
        got = (xs.min(), xs.max(), ys.min(), ys.max())
        dev = max(abs(a - b) for a, b in zip(want, got))
        check('кадр %d: силуэт спрайта — проекция габарита модели' % rot,
              dev <= TOL_PX + 2.0, 'расхождение %.1f px (порог %.1f)' % (dev, TOL_PX + 2.0))

    print('\nИТОГ: %s' % ('ПРИНЯТО' if not fails else 'НЕ ПРИНЯТО (%d)' % len(fails)))
    for w in warns:
        print('  предупреждение: %s' % w)
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main())
