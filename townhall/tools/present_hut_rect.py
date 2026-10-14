"""Итоговые листы прямоугольной хижины: варианты, повороты, сверка с атласом.

    python3 tools/present_hut_rect.py

Пишет:
    out/hutrect_variants.png   три варианта крупно
    out/hutrect_rotations.png  три варианта x четыре поворота
    out/hutrect_style.png      сверка стиля: хижина + деревья атласа + ратуша
                               в одном масштабе (80 px на юнит)
"""
import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'out')
GAME = os.path.join(ROOT, '..', 'mapgen2', 'assets')
SPR = os.path.join(GAME, 'sprites')
TH = os.path.join(GAME, 'townhall')
HUT = os.path.join(GAME, 'hut')

WHITE = (255, 255, 255)
VARIANTS = ('a', 'b', 'c')
ROTATIONS = (0, 90, 180, 270)


def load(path, bg=WHITE):
    im = Image.open(path).convert('RGBA')
    out = Image.new('RGB', im.size, bg)
    out.paste(im, (0, 0), im)
    return out


def grid(items, cols, out_path, gap=6, bg=WHITE, label=None):
    w = max(i.width for i in items)
    h = max(i.height for i in items)
    rows = math.ceil(len(items) / cols)
    pad_top = 0
    canvas = Image.new('RGB', (cols * w + (cols - 1) * gap,
                               rows * h + (rows - 1) * gap + pad_top), bg)
    for i, im in enumerate(items):
        x = (i % cols) * (w + gap) + (w - im.width) // 2
        y = (i // cols) * (h + gap) + pad_top + (h - im.height) // 2
        canvas.paste(im, (x, y))
    canvas.save(out_path)
    print('[ok] %-26s %dx%d' % (os.path.basename(out_path), canvas.width, canvas.height))
    return canvas


def sprite_from_atlas(atlas_img, meta, name, scale=1.0):
    f = meta['frames'][name]
    im = atlas_img.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
    if scale != 1.0:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                       Image.LANCZOS)
    return im


def compose_style(out_path):
    """Хижина рядом с деревьями атласа и ратушей — всё в 80 px на юнит."""
    sprites = Image.open(os.path.join(SPR, 'atlas.png')).convert('RGBA')
    s_meta = json.load(open(os.path.join(SPR, 'atlas.json')))
    k = 80.0 / s_meta['ppu']                     # атлас нарисован в 96 px/юнит
    picks = ['tree_pine_0', 'tree_pine_90', 'tree_oak_0', 'tree_oak_90',
             'tree_autumn_0', 'tree_birch_0', 'rock_boulder_0', 'bush_0']
    trees = [sprite_from_atlas(sprites, s_meta, n, k) for n in picks
             if n in s_meta['frames']]

    th = Image.open(os.path.join(TH, 'atlas.png')).convert('RGBA')
    th_meta = json.load(open(os.path.join(TH, 'atlas.json')))
    th_img = None
    f = th_meta['frames'].get('townhall_a_0')
    if f:
        th_img = th.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))

    hu = Image.open(os.path.join(HUT, 'atlas.png')).convert('RGBA')
    hu_meta = json.load(open(os.path.join(HUT, 'atlas.json')))
    h = hu_meta['frames']['hutrect_a_0']
    hut = hu.crop((h['x'], h['y'], h['x'] + h['w'], h['y'] + h['h']))

    row = trees + [hut] + ([th_img] if th_img else [])
    gap = 14
    W = sum(i.width for i in row) + gap * (len(row) - 1) + 40
    H = max(i.height for i in row) + 40
    canvas = Image.new('RGB', (W, H), WHITE)
    # выравниваем по земле: опора дерева — anchorY из меты, у хижины — её anchorY
    x = 20
    for i, im in enumerate(row):
        canvas.paste(im, (x, H - 20 - im.height), im)
        x += im.width + gap
    canvas.save(out_path)
    print('[ok] %-26s %dx%d' % (os.path.basename(out_path), W, H))


def main():
    variants = [load(os.path.join(OUT, 'hutrect_%s_0.png' % v)) for v in VARIANTS]
    grid(variants, 3, os.path.join(OUT, 'hutrect_variants.png'), gap=20)

    rot = []
    for v in VARIANTS:
        for r in ROTATIONS:
            rot.append(load(os.path.join(OUT, 'hutrect_%s_%d.png' % (v, r))))
    grid(rot, 4, os.path.join(OUT, 'hutrect_rotations.png'), gap=10)

    compose_style(os.path.join(OUT, 'hutrect_style.png'))


if __name__ == '__main__':
    main()
