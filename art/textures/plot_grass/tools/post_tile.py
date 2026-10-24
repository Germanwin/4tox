# -*- coding: utf-8 -*-
"""Пост-обработка плитки: 512 для игры, 1024 для архива, превью и проверки.

Blender отдаёт сырой кадр 1024 x 1024 (рендер уже бесшовный: девять копий
периодической сетки). Здесь он уменьшается до 512 (игровой размер: две клетки
по 256 px), проверяется стык и собираются доказательства — плитка 3 x 3 и
сравнение с травой карты.
"""

import json
import os
import sys

from PIL import Image
import numpy as np

import grass_tile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
PROJ = os.path.join(ROOT, 'art', 'textures', 'plot_grass')
RAW = os.path.join(PROJ, 'renders', 'plot_grass_flat_1024_raw.png')
OUT = os.path.join(PROJ, 'out')
GAME = os.path.join(ROOT, 'mapgen2', 'assets', 'textures')
MAP_GRASS = os.path.join(ROOT, 'mapgen2', 'assets', 'textures', 'grass.png')


def stats(a):
    a = a.reshape(-1, 3).astype(float)
    return {
        'mean': [round(float(x), 1) for x in a.mean(0)],
        'p10': [int(x) for x in np.percentile(a, 10, axis=0)],
        'p50': [int(x) for x in np.percentile(a, 50, axis=0)],
        'p90': [int(x) for x in np.percentile(a, 90, axis=0)],
    }


def seam(a):
    """Стык кромок против соседних внутренних столбцов/строк."""
    im = a.astype(float)
    def md(x, y):
        return float(np.abs(x - y).mean())
    inner_v = float(np.mean([md(im[:, i], im[:, i + 1]) for i in range(0, im.shape[1] - 1, 37)]))
    inner_h = float(np.mean([md(im[i], im[i + 1]) for i in range(0, im.shape[0] - 1, 37)]))
    return {
        'vertical': round(md(im[:, -1], im[:, 0]), 2),
        'vertical_inner': round(inner_v, 2),
        'horizontal': round(md(im[-1, :], im[0, :]), 2),
        'horizontal_inner': round(inner_h, 2),
    }


def main():
    raw = Image.open(RAW).convert('RGB')
    if raw.size != (1024, 1024):
        raise SystemExit('ожидался кадр 1024 x 1024, а пришёл %s' % (raw.size,))
    os.makedirs(OUT, exist_ok=True)

    big = raw.copy()
    small = raw.resize((512, 512), Image.LANCZOS)
    big.save(os.path.join(OUT, 'plot_grass_1024.png'), optimize=True)
    small.save(os.path.join(OUT, 'plot_grass_512.png'), optimize=True)

    # 3 x 3: видно, сходится ли повтор и нет ли светлых швов
    tiled = Image.new('RGB', (1536, 1536))
    for y in range(3):
        for x in range(3):
            tiled.paste(big, (x * 1024, y * 1024))
    tiled.resize((768, 768), Image.LANCZOS).save(
        os.path.join(OUT, 'plot_grass_3x3.png'), optimize=True)

    # Сравнение с травой карты: та же клетка, другой тон
    map_im = Image.open(MAP_GRASS).convert('RGB').resize((512, 512), Image.LANCZOS)
    compare = Image.new('RGB', (1024, 512))
    compare.paste(map_im, (0, 0))
    compare.paste(small, (512, 0))
    compare.save(os.path.join(OUT, 'compare_map_vs_plot.png'), optimize=True)

    # 256 — ровно то, что увидит игра на максимальном зуме (2 клетки x 128 px)
    small.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, 'plot_grass_256.png'), optimize=True)

    # В игру — 512: при 128 px/клетку это два экранных пикселя на пиксель
    # текстуры, запас на зум и на резкость кромки.
    small.save(os.path.join(GAME, 'plot_grass.png'), optimize=True)

    a = np.asarray(small)
    report = {
        'source': os.path.relpath(RAW, ROOT),
        'game': os.path.relpath(os.path.join(GAME, 'plot_grass.png'), ROOT),
        'mode': 'flat emission: no lights, no cast shadows (atlas style)',
        'seed': grass_tile.SEED,
        'palette': {k: list(v) for k, v in grass_tile.MATERIALS.items()},
        'sizes': {'raw': list(raw.size), 'game': list(small.size),
                  'tile_cells': 2, 'px_per_cell': 256},
        'color': stats(a),
        'map_grass_color': stats(np.asarray(map_im)),
        'seam': seam(a),
        'bytes': {p: os.path.getsize(p) for p in [
            os.path.join(OUT, 'plot_grass_512.png'),
            os.path.join(OUT, 'plot_grass_1024.png'),
            os.path.join(GAME, 'plot_grass.png')]},
    }
    with open(os.path.join(OUT, 'plot_grass_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
