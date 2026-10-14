"""Пост-обработка рендеров хижины: контактная тень, контур, обрезка.

    python3 tools/compose_hut.py [--rotations 0,90,180,270] [--no-outline]

Читает renders/hut_<поворот>_raw.png, пишет out/hut_<поворот>.png и
out/hut_sprites.json — тот же формат, что out/sprites.json у ратуши.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import geom
import compose

ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

# Пятно хижины: стена 2.04 x 1.68 плюс свес крыши, тень — по свесу.
SHADOW_RX, SHADOW_RY = 1.32, 1.14


def shadows():
    return [geom.shadow_for(0.0, 0.0, SHADOW_RX, SHADOW_RY)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--no-outline', action='store_true')
    args = ap.parse_args()

    path = os.path.join(OUT, 'hut_sprites.json')
    sprites = {}
    if os.path.exists(path):
        try:
            sprites = json.load(open(path)).get('frames', {})
        except Exception:
            sprites = {}

    for rot in [int(r) for r in args.rotations.split(',')]:
        raw = os.path.join(RENDERS, 'hut_%d_raw.png' % rot)
        if not os.path.exists(raw):
            print('НЕТ РЕНДЕРА: %s' % raw)
            continue
        dst = os.path.join(OUT, 'hut_%d.png' % rot)
        img, ax, ay = compose.compose(raw, shadows(), outline=not args.no_outline,
                                      save_path=dst)
        sprites['hut_%d' % rot] = dict(file=os.path.basename(dst), w=img.width,
                                       h=img.height, anchorX=round(ax, 2),
                                       anchorY=round(ay, 2), rotation=rot)
        print('COMPOSED hut_%d %dx%d опора=(%.1f,%.1f)' % (rot, img.width, img.height, ax, ay))

    with open(path, 'w') as f:
        json.dump(dict(ppu=geom.PPU, ortho=geom.ORTHO, res=[geom.RES_X, geom.RES_Y],
                       note='1 юнит модели = 1 клетка; хижина ~2 x 2 клетки',
                       frames=sprites), f, ensure_ascii=False, indent=1)
    print('hut_sprites.json записан')


if __name__ == '__main__':
    main()
