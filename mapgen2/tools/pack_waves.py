"""Упаковка спрайтов волн в атлас генератора карт.

    python3 tools/pack_waves.py [--src ../../waves/out] [--pad 2]

Читает готовые спрайты волн (`waves/out/wave_<форма>_<поворот>.png` и
`sprites.json`, который пишет `waves/tools/compose_waves.py`) и складывает их
в один атлас — в том же формате, что `assets/sprites/atlas.json` и
`assets/townhall/atlas.json`: кадр, рамка в пикселях атласа, точка опоры.

Зачем атлас: генератор грузит спрайты одним скриптом (`atlas.js`), который
работает и по `file://`, и одной картинкой — иначе на каждый вариант
приходился бы отдельный запрос и отдельное состояние загрузки.

Метаданные к кадру, без которых не вывести масштаб:

  ppu       пикселей кадра на юнит модели (120 = 960 px / ortho 8.0)
  az_deg    азимут камеры рендера (45°)
  el_deg    подъём камеры рендера (35.2644° — истинная изометрия)
  rotation  0 — вал вдоль течения, 90 — поперёк (см. waves/README.md)

По ним `js/waves.js` считает масштаб спрайта так, чтобы юнит модели лёг
ровно в клетку карты.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # mapgen2/
REPO = os.path.dirname(ROOT)                       # корень 4tox (docs/STRUCTURE.md)
DEFAULT_SRC = os.path.join(REPO, 'art', 'fx', 'waves', 'out')
DST = os.path.join(ROOT, 'assets', 'waves')
RIPPLE_SRC = os.path.join(ROOT, 'assets', 'textures', 'water.png')
RIPPLE_GAIN = 2.6          # во сколько раз усилить разброс яркости воды


def make_ripple(src, dst, gain=RIPPLE_GAIN):
    """Рябь моря: модуль яркости текстуры воды, приведённый к серому у белого.

    Кладётся на море умножением, поэтому важен не цвет текстуры, а её
    неровность: среднее уходит в белый, а разброс усиливается. Считать это
    в игре нельзя — под `file://` картинка считается чужим источником, и
    `getImageData` на холсте с ней падает с SecurityError (на этом уже
    один раз встала загрузка спрайтов). Поэтому модуль готовится здесь и
    лежит рядом с атласом.
    """
    a = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
    lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
    mean = float(lum.mean()) or 1.0
    v = np.clip(255.0 * (1.0 + gain * (lum / mean - 1.0)), 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([v, v, v]), 'RGB').save(dst)
    return int(v.min()), int(v.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--pad', type=int, default=2)
    ap.add_argument('--cols', type=int, default=4)
    args = ap.parse_args()

    meta_path = os.path.join(args.src, 'sprites.json')
    if not os.path.exists(meta_path):
        print('нет %s — сначала соберите волны (waves/tools/compose_waves.py)' % meta_path)
        return 1
    src = json.load(open(meta_path))

    frames = []
    for name in sorted(src['frames']):
        f = src['frames'][name]
        path = os.path.join(args.src, f['file'])
        if not os.path.exists(path):
            print('нет файла %s' % path)
            return 1
        frames.append(dict(name=name, meta=f, img=Image.open(path).convert('RGBA')))

    pad = max(1, args.pad)
    cols = max(1, min(args.cols, len(frames)))
    rows = (len(frames) + cols - 1) // cols
    cell_w = max(f['img'].width for f in frames) + pad * 2
    cell_h = max(f['img'].height for f in frames) + pad * 2
    W, H = cell_w * cols + 1, cell_h * rows + 1

    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out_frames = {}
    for i, f in enumerate(frames):
        x = (i % cols) * cell_w + pad
        y = (i // cols) * cell_h + pad
        atlas.alpha_composite(f['img'], (x, y))
        m = f['meta']
        out_frames[f['name']] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            'anchorX': round(float(m['anchorX']), 2),
            'anchorY': round(float(m['anchorY']), 2),
            'shape': m.get('shape', 0), 'rotation': m.get('rotation', 0),
            'units': m.get('units'),
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': src.get('ppu', 120.0),
        'az_deg': src.get('az_deg', 45.0),
        'el_deg': src.get('el_deg', 35.264389682754654),
        'res': src.get('res', [768, 960]),
        'note': ('спрайты волн: 1 юнит модели = 1 клетка карты, anchorX/anchorY — '
                 'центр вала на уровне воды; rotation 0 — вал вдоль течения, '
                 '90 — поперёк'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    # atlas.js — тот же JSON, но скриптом: работает по file:// без запросов.
    with open(os.path.join(DST, 'atlas.js'), 'w') as fh:
        fh.write('window.WAVE_ATLAS = ')
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write(';\n')

    lo, hi = make_ripple(RIPPLE_SRC, os.path.join(DST, 'ripple.png'))
    print('atlas.png %dx%d, кадров %d, %.0f px на юнит' % (W, H, len(out_frames), meta['ppu']))
    print('ripple.png: модуль яркости воды, %d..%d' % (lo, hi))
    return 0


if __name__ == '__main__':
    sys.exit(main())
