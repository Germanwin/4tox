"""sheet.py — лист поворотов кузницы: из готовых спрайтов out/abs_<rot>.png.

    $PY3 tools/sheet.py     # -> out/abs_rotations.png  (4 поворота + подписи)
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'out')
BG = (246, 246, 244)
INK = (70, 70, 70)
FONTS = ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
         '/System/Library/Fonts/Helvetica.ttc',
         '/Library/Fonts/Arial.ttf')


def font(size=15):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main():
    rots = [0, 90, 180, 270]
    ims = [Image.open(os.path.join(OUT, 'abs_%d.png' % r)).convert('RGBA')
           for r in rots]
    pad, cap = 16, 26
    W = sum(i.width for i in ims) + pad * (len(ims) + 1)
    H = max(i.height for i in ims) + pad * 2 + cap
    sheet = Image.new('RGBA', (W, H), BG + (255,))
    d = ImageDraw.Draw(sheet)
    f = font(15)
    x = pad
    for r, im in zip(rots, ims):
        sheet.alpha_composite(im, (x, pad))
        d.text((x + im.width / 2 - 14, pad + im.height + 4),
               '%d°' % r, fill=INK, font=f)
        x += im.width + pad
    p = os.path.join(OUT, 'abs_rotations.png')
    sheet.convert('RGB').save(p)
    print('-> %s  %dx%d' % (p, W, H))
    return 0


if __name__ == '__main__':
    sys.exit(main())
