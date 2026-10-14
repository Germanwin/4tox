"""Упаковка спрайтов прямоугольной хижины в атлас генератора карт.

    python3 tools/pack_hut_rect.py [--src ../../townhall/out] [--pad 2]

Читает `townhall/out/hutrect_sprites.json` (его пишет
`townhall/tools/compose_hut_rect.py`) и складывает 12 кадров — 3 варианта
x 4 поворота — в `assets/hut/atlas.png` + `atlas.json` + `atlas.js`,
ровно в том же формате, что `assets/townhall/`.

Пятно застройки хижины — 3 x 2 клетки (X — длинная сторона), при повороте
на 90° — 2 x 3.
"""
import argparse
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_SRC = os.path.join(ROOT, '..', 'townhall', 'out')
DST = os.path.join(ROOT, 'assets', 'hut')

VARIANTS = ('a', 'b', 'c')
ROTATIONS = (0, 90, 180, 270)


def footprint(rotation):
    return (3, 2) if rotation % 180 == 0 else (2, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--pad', type=int, default=2)
    args = ap.parse_args()

    meta_path = os.path.join(args.src, 'hutrect_sprites.json')
    if not os.path.exists(meta_path):
        print('нет %s — сначала: townhall/tools/compose_hut_rect.py' % meta_path)
        return 1
    src = json.load(open(meta_path))

    frames = []
    for v in VARIANTS:
        for rot in ROTATIONS:
            key = 'hutrect_%s_%d' % (v, rot)
            f = src['frames'].get(key)
            if not f:
                print('нет кадра %s' % key)
                return 1
            path = os.path.join(args.src, f['file'])
            if not os.path.exists(path):
                print('нет файла %s' % path)
                return 1
            frames.append(dict(name=key, variant=v, rotation=rot,
                               img=Image.open(path).convert('RGBA'),
                               anchorX=float(f['anchorX']),
                               anchorY=float(f['anchorY'])))

    pad = max(1, args.pad)
    cell_w = max(f['img'].width for f in frames) + pad * 2
    cell_h = max(f['img'].height for f in frames) + pad * 2
    W, H = cell_w * len(ROTATIONS) + 1, cell_h * len(VARIANTS) + 1
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    out_frames = {}
    for f in frames:
        x = ROTATIONS.index(f['rotation']) * cell_w + pad
        y = VARIANTS.index(f['variant']) * cell_h + pad
        atlas.alpha_composite(f['img'], (x, y))
        out_frames[f['name']] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            'anchorX': round(f['anchorX'], 2), 'anchorY': round(f['anchorY'], 2),
            'variant': f['variant'], 'rotation': f['rotation'],
            'footprint': list(footprint(f['rotation'])),
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': src.get('ppu', 80.0),
        'az_deg': src.get('az_deg', 45.0),
        'el_deg': src.get('el_deg', 35.264389682754654),
        'res': src.get('res', [512, 640]),
        'variants': {v: list(footprint(0)) for v in VARIANTS},
        'note': ('спрайты хижины: 1 юнит модели = 1 клетка карты, пятно 3 x 2 '
                 '(при повороте 2 x 3); anchorX/anchorY — центр пятна застройки'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(DST, 'atlas.js'), 'w') as fh:
        fh.write('window.HUT_ATLAS = ')
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write(';\n')

    print('assets/hut/atlas.png %dx%d, кадров %d, %.1f px на юнит' % (
        W, H, len(out_frames), meta['ppu']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
