"""Пост-обработка рендеров прямоугольной хижины: тень, контур, обрезка.

    python3 tools/compose_hut_rect.py [--variants a,b,c] [--rotations 0,90,180,270]

Читает renders/hutrect_<вариант>_<поворот>_raw.png, пишет
out/hutrect_<вариант>_<поворот>.png и out/hutrect_sprites.json.
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

# Пятно 3 x 2: тень по свесу кровли, чуть уже пятна застройки.
SHADOW_RX, SHADOW_RY = 1.44, 1.00


def shadows(variant):
    if variant == 'c':
        return [geom.shadow_for(0.0, 0.0, SHADOW_RX * 1.04, SHADOW_RY * 1.06)]
    if variant == 'b':
        return [geom.shadow_for(0.0, 0.0, SHADOW_RX, SHADOW_RY),
                geom.shadow_for(1.02, -0.32, 0.34, 0.30)]      # труба
    return [geom.shadow_for(0.0, 0.0, SHADOW_RX, SHADOW_RY)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants', default='a,b,c')
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--no-outline', action='store_true')
    args = ap.parse_args()

    path = os.path.join(OUT, 'hutrect_sprites.json')
    spr = {}
    if os.path.exists(path):
        try:
            spr = json.load(open(path)).get('frames', {})
        except Exception:
            spr = {}

    for v in args.variants.split(','):
        for rot in [int(r) for r in args.rotations.split(',')]:
            raw = os.path.join(RENDERS, 'hutrect_%s_%d_raw.png' % (v, rot))
            if not os.path.exists(raw):
                print('НЕТ РЕНДЕРА: %s' % raw)
                continue
            name = 'hutrect_%s_%d' % (v, rot)
            dst = os.path.join(OUT, name + '.png')
            img, ax, ay = compose.compose(raw, shadows(v),
                                          outline=not args.no_outline, save_path=dst)
            spr[name] = dict(file=os.path.basename(dst), w=img.width, h=img.height,
                             anchorX=round(ax, 2), anchorY=round(ay, 2),
                             variant=v, rotation=rot, footprint=[3, 2])
            print('COMPOSED %-18s %dx%d опора=(%.1f,%.1f)' % (name, img.width,
                                                              img.height, ax, ay))

    with open(path, 'w') as f:
        json.dump(dict(ppu=geom.PPU, ortho=geom.ORTHO, res=[geom.RES_X, geom.RES_Y],
                       az_deg=45.0, el_deg=35.264389682754654,
                       footprint=[3, 2], variants=['a', 'b', 'c'],
                       note='1 юнит = 1 клетка; хижина 3 x 2 клетки, X — длинная сторона',
                       frames=spr), f, ensure_ascii=False, indent=1)
    print('hutrect_sprites.json записан')


if __name__ == '__main__':
    main()
