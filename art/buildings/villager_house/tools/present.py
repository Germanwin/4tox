"""present.py — итоговые листы дома: варианты, повороты, сверка с соседями.

    python3 tools/present.py

    out/vh_variants.png    три варианта дома (поворот 0) крупно
    out/vh_rotations.png   четыре поворота варианта a: силуэт читается всегда
    out/vh_style.png       сверка с атласом, ратушей и хижиной (пишет sheet.py)
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
         '/System/Library/Fonts/Helvetica.ttc',
         '/Library/Fonts/Arial.ttf')


def font(size=13):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'out')
BG = (246, 246, 244)
INK = (60, 60, 60)


def load(name):
    return Image.open(os.path.join(OUT, name)).convert('RGBA')


def grid(items, cols, gap=14, label_h=22, bg=BG):
    w = max(i[1].width for i in items)
    h = max(i[1].height for i in items)
    rows = (len(items) + cols - 1) // cols
    W = cols * w + (cols + 1) * gap
    H = rows * (h + label_h) + (rows + 1) * gap
    sheet = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(sheet)
    for k, (name, img) in enumerate(items):
        r, c = divmod(k, cols)
        x = gap + c * (w + gap)
        y = gap + r * (h + label_h + gap)
        sheet.paste(img, (x + (w - img.width) // 2, y), img)
        d.text((x + 4, y + h + 4), name, fill=INK, font=font())
    return sheet


def main():
    meta = json.load(open(os.path.join(OUT, 'vh_sprites.json'), encoding='utf-8'))
    variants = meta.get('variants') or ['a', 'b', 'c']
    items = []
    for v in variants:
        f = meta['frames'].get('vh_%s_0' % v)
        if f:
            items.append(('вариант %s' % v, load(f['file'])))
    if items:
        sheet = grid(items, len(items))
        sheet.save(os.path.join(OUT, 'vh_variants.png'))
        print('out/vh_variants.png %dx%d' % sheet.size)
    rots = []
    for rot in (0, 90, 180, 270):
        f = meta['frames'].get('vh_%s_%d' % (variants[0], rot))
        if f:
            rots.append(('поворот %d' % rot, load(f['file'])))
    if rots:
        sheet = grid(rots, len(rots))
        sheet.save(os.path.join(OUT, 'vh_rotations.png'))
        print('out/vh_rotations.png %dx%d' % sheet.size)
    return 0


if __name__ == '__main__':
    sys.exit(main())
