"""Лист сравнения: эталонный атлас и спрайты ратуши на одной картинке.

    python3 tools/sheet.py [--src out] [--out out/compare.png]
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FONT_CANDIDATES = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/SFNSMono.ttf',
    '/Library/Fonts/Arial.ttf',
]


def font(size):
    for f in FONT_CANDIDATES:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                continue
    return ImageFont.load_default()


def checker(w, h, cell=16, a=(228, 228, 228), b=(200, 200, 200)):
    img = Image.new('RGB', (w, h), a)
    d = ImageDraw.Draw(img)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=b)
    return img


def paste_row(canvas, images, labels, y, fnt, bg):
    d = ImageDraw.Draw(canvas)
    x = 12
    lh = 0
    for im, lab in zip(images, labels):
        if im is None:
            continue
        canvas.paste(im, (x, y), im)
        d.text((x + 2, y + im.height + 4), lab, font=fnt, fill=(30, 30, 30))
        x += im.width + 22
        lh = max(lh, im.height + 30)
    return y + lh + 14


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--atlas', default=os.path.join(
        REPO, 'mapgen2', 'assets', 'sprites', 'atlas.png'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'out', 'compare.png'))
    args = ap.parse_args()

    fnt = font(20)
    fnt_b = font(26)

    # --- эталон: вырезаем деревья/кусты/камни, масштабируем x1.6 для наглядности
    ref = []
    ref_lab = []
    if os.path.exists(args.atlas):
        A = Image.open(args.atlas).convert('RGBA')
        boxes = {
            'дуб': (3, 874, 110, 1021), 'сосна': (883, 881, 979, 1021),
            'куст': (672, 799, 746, 868), 'валун': (451, 666, 506, 722),
            'камень': (683, 648, 765, 722),
        }
        sc = 1.6
        for lab, (x0, y0, x1, y1) in boxes.items():
            im = A.crop((x0, y0, x1, y1))
            im = im.resize((int(im.width * sc), int(im.height * sc)), Image.LANCZOS)
            ref.append(im)
            ref_lab.append(lab)

    sprites = []
    labels = []
    for v in ('a', 'b', 'c'):
        p = os.path.join(args.src, 'th_%s_0.png' % v)
        if os.path.exists(p):
            sprites.append(Image.open(p).convert('RGBA'))
            labels.append('ратуша %s' % v)
    cuts = []
    cut_lab = []
    for v in ('a', 'b', 'c'):
        p = os.path.join(args.src, 'cut_%s.png' % v)
        if os.path.exists(p):
            cuts.append(Image.open(p).convert('RGBA'))
            cut_lab.append('силуэт %s' % v)

    rows = [(ref, ref_lab, 'ЭТАЛОН (атлас mapgen2)'),
            (sprites, labels, 'РАТУША — спрайты с тенью'),
            (cuts, cut_lab, 'РАТУША — только силуэт')]
    width = max([12 + sum(i.width + 22 for i in r[0]) for r in rows] + [900])
    height = 0
    for imgs, _, _ in rows:
        height += (max([i.height for i in imgs]) if imgs else 0) + 62
    canvas = checker(width + 12, height + 20)
    d = ImageDraw.Draw(canvas)
    y = 12
    for imgs, labs, title in rows:
        d.text((12, y), title, font=fnt_b, fill=(20, 20, 20))
        y += 36
        if not imgs:
            continue
        y = paste_row(canvas, imgs, labs, y, fnt, None)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    canvas.convert('RGB').save(args.out)
    print('лист: %s  %dx%d' % (args.out, canvas.width, canvas.height))


if __name__ == '__main__':
    main()
