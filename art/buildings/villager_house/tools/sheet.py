"""sheet.py — лист сверки: мой дом рядом с соседями по деревне.

    python3 tools/sheet.py [--out out/vh_style.png]

Соседи — не абстракция, а реальные ассеты игры:
    * кадры атласа `mapgen2/assets/sprites/atlas.png` (96 ppu) — деревья и камни,
      с них снят канон стиля;
    * ратуша `townhall/out/th_a_0.png` (80 ppu) — ЭТАЛОН, с которого снят дом;
    * хижина `townhall/out/hutrect_a_0.png` (80 ppu) — уже принятая постройка.

Все кадры приводятся к общему масштабу (96 ppu) и сажаются на общую линию
земли по своей точке опоры: только так видно, что дом одного роста с соседями
и той же плотности фасетов. Иначе лист врёт: у атласа 96 ppu, у построек 80.

Ряд 2 — четыре поворота дома: проверка, что силуэт читается с любой стороны.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Корень 4tox — три уровня вверх от проекта (docs/STRUCTURE.md).
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
OUT = os.path.join(ROOT, 'out')
GAME = os.path.join(REPO, 'mapgen2')
PPU_COMMON = 96.0
BG = (246, 246, 244)


def load_frame(path, ppu, anchor=None, box=None):
    im = Image.open(path).convert('RGBA')
    if box:
        im = im.crop(box)
    if abs(ppu - PPU_COMMON) > 1e-6:
        k = PPU_COMMON / ppu
        im = im.resize((max(1, int(round(im.width * k))),
                        max(1, int(round(im.height * k)))), Image.NEAREST)
        if anchor:
            anchor = (anchor[0] * k, anchor[1] * k)
    return im, anchor


def atlas_frames():
    meta = json.load(open(os.path.join(GAME, 'assets', 'sprites', 'atlas.json'),
                          encoding='utf-8'))
    atlas = Image.open(os.path.join(GAME, 'assets', 'sprites', 'atlas.png'))
    out = {}
    for name, f in meta['frames'].items():
        out[name] = (atlas.crop((f['x'], f['y'], f['x'] + f['w'],
                                 f['y'] + f['h'])).convert('RGBA'),
                     (f['anchorX'], f['anchorY']), meta['ppu'])
    return out


def place(sheet, img, anchor, x_ground, y_ground, label=None):
    """Поставить кадр так, чтобы его точка опоры легла в (x_ground, y_ground)."""
    if anchor is None:
        anchor = (img.width / 2.0, img.height)
    px = int(round(x_ground - anchor[0]))
    py = int(round(y_ground - anchor[1]))
    sheet.alpha_composite(img, (px, py))
    return px, py


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(OUT, 'vh_style.png'))
    ap.add_argument('--variant', default='a')
    args = ap.parse_args()

    af = atlas_frames()
    items = []
    for key in ('tree_oak_0', 'tree_pine_0', 'bush_0', 'rock_boulder_0'):
        if key in af:
            img, anc, ppu = af[key]
            items.append((key, img, anc, ppu))
    th = os.path.join(REPO, 'art', 'buildings', 'townhall', 'out', 'th_a_0.png')
    if os.path.exists(th):
        img, anc = load_frame(th, 80.0, (431 * 0.63, 440 * 0.80))
        items.append(('ратуша (эталон)', img, anc, 96.0))
    hu = os.path.join(REPO, 'art', 'buildings', 'townhall', 'out', 'hutrect_a_0.png')
    if os.path.exists(hu):
        img, anc = load_frame(hu, 80.0, (147.0, 210.0))
        items.append(('хижина (в игре)', img, anc, 96.0))
    sp = json.load(open(os.path.join(OUT, 'vh_sprites.json'), encoding='utf-8'))
    f0 = sp['frames']['vh_%s_0' % args.variant]
    mine = os.path.join(OUT, 'vh_%s_0.png' % args.variant)
    img, anc = load_frame(mine, 80.0, (f0['anchorX'], f0['anchorY']))
    items.append(('МОЙ ДОМ %s' % args.variant, img, anc, 96.0))

    W = sum(i[1].width for i in items) + 40 * (len(items) + 1)
    H1 = max(i[1].height for i in items) + 60
    sheet = Image.new('RGBA', (W, H1), BG + (255,))
    x = 40
    for name, img, anc, ppu in items:
        gy = H1 - 40
        place(sheet, img, anc, x + (anc[0] if anc else img.width / 2), gy)
        x += img.width + 40

    rows = [sheet]
    rots = []
    for rot in (0, 90, 180, 270):
        key = 'vh_%s_%d' % (args.variant, rot)
        f = sp['frames'][key]
        img, anc = load_frame(os.path.join(OUT, f['file']), 80.0,
                              (f['anchorX'], f['anchorY']))
        rots.append((key, img, anc))
    W2 = sum(i[1].width for i in rots) + 30 * (len(rots) + 1)
    H2 = max(i[1].height for i in rots) + 40
    row2 = Image.new('RGBA', (W2, H2), BG + (255,))
    x = 30
    for name, img, anc in rots:
        place(row2, img, anc, x + anc[0], H2 - 30)
        x += img.width + 30
    rows.append(row2)

    Wc = max(r.width for r in rows)
    Hc = sum(r.height for r in rows) + 20
    final = Image.new('RGBA', (Wc, Hc), BG + (255,))
    y = 0
    for r in rows:
        final.alpha_composite(r, (0, y))
        y += r.height + 20
    final.convert('RGB').save(args.out)
    print('лист сверки -> %s (%dx%d)' % (args.out, final.width, final.height))
    return 0


if __name__ == '__main__':
    sys.exit(main())
