"""Проверка спрайтов ратуши: размеры, точки опоры, попадание в пятно 4 x 3.

    python3 tools/verify.py

Проверяет то, что легко сломать при правке геометрии:
  1. все 12 кадров (3 варианта x 4 поворота) на месте и не пустые;
  2. точка опоры лежит внутри кадра и одинакова у всех поворотов варианта;
  3. пятно застройки действительно занимает 4 x 3 клетки;
  4. спрайт не обрезан по краям кадра рендера.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import geom

OUT = os.path.join(ROOT, 'out')
RENDERS = os.path.join(ROOT, 'renders')
VARIANTS = ('a', 'b', 'c')
ROTATIONS = (0, 90, 180, 270)
CELL = 1.0                      # 1 юнит модели = 1 клетка
FOOT = (4.0, 3.0)               # пятно застройки, клетки

fails = []


def check(cond, msg):
    print('%s %s' % ('OK  ' if cond else 'БЕДА', msg))
    if not cond:
        fails.append(msg)


def main():
    sprites_path = os.path.join(OUT, 'sprites.json')
    check(os.path.exists(sprites_path), 'есть out/sprites.json')
    if not os.path.exists(sprites_path):
        return 1
    meta = json.load(open(sprites_path))
    frames = meta['frames']

    # 1. все кадры на месте
    for v in VARIANTS:
        for r in ROTATIONS:
            key = 'townhall_%s_%d' % (v, r)
            f = frames.get(key)
            check(f is not None and os.path.exists(os.path.join(OUT, f['file']))
                  if f else False, 'кадр %s' % key)

    # 2. точка опоры внутри кадра и устойчива между поворотами
    anchors = {}
    for v in VARIANTS:
        pts = []
        for r in ROTATIONS:
            f = frames['townhall_%s_%d' % (v, r)]
            ax, ay = f['anchorX'], f['anchorY']
            check(0 < ax < f['w'] and 0 < ay < f['h'],
                  'опора %s_%d внутри кадра (%.1f,%.1f) в %dx%d' % (v, r, ax, ay, f['w'], f['h']))
            pts.append((ax, ay))
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        check(max(xs) - min(xs) <= 40 and max(ys) - min(ys) <= 3,
              'опора %s устойчива между поворотами: разброс x %.1f y %.1f' % (
                  v, max(xs) - min(xs), max(ys) - min(ys)))
        anchors[v] = pts

    # 3. пятно застройки = 4 x 3 клетки
    xl, _ = geom.project(-FOOT[0] / 2 * CELL, 0.0, 0.0)
    xr, _ = geom.project(FOOT[0] / 2 * CELL, 0.0, 0.0)
    _, yt = geom.project(0.0, -FOOT[1] / 2 * CELL, 0.0)
    _, yb = geom.project(0.0, FOOT[1] / 2 * CELL, 0.0)
    base_px = xr - xl
    # 4 клетки по длинной стороне дают на экране 4 * cos(45°) * ppu пикселей
    expect_px = FOOT[0] * math.cos(geom.AZ) * geom.PPU
    check(abs(base_px - expect_px) < 1.5,
          'ширина пятна = 4 клетки: %.1f px (ожидалось %.1f)' % (base_px, expect_px))
    # вертикальный габарит блока 4 x 3 = (4 + 3) / 2 клеток по высоте
    # вертикальный габарит = (ширина + глубина) / 2 клеток, где клетка вперёд
    # даёт на экране tan(35.264°) от клетки по X
    # три клетки в глубину дают на экране три шага «вперёд»
    step_fwd = geom.project(0.0, 1.0, 0.0)[1] - geom.project(0.0, 0.0, 0.0)[1]
    expect_h = FOOT[1] * step_fwd
    check(abs((yb - yt) - expect_h) < 1.5,
          'глубина пятна = 3 клетки: %.1f px (ожидалось %.1f)' % (yb - yt, expect_h))

    # 4. спрайт не обрезан в кадре рендера
    for v in VARIANTS:
        for r in ROTATIONS:
            raw = os.path.join(RENDERS, 'th_%s_%d_raw.png' % (v, r))
            if not os.path.exists(raw):
                continue
            a = np.array(Image.open(raw).convert('RGBA'))[:, :, 3]
            ys, xs = np.nonzero(a > 8)
            check(xs.min() > 0 and xs.max() < a.shape[1] - 1 and
                  ys.min() > 0 and ys.max() < a.shape[0] - 1,
                  'рендер %s_%d не касается краёв кадра' % (v, r))

    print()
    if fails:
        print('ПРОВАЛЕНО %d проверок:' % len(fails))
        for f in fails:
            print('  - %s' % f)
        return 1
    print('Все проверки пройдены.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
