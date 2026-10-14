"""peek.py — «посмотреть глазами»: обрезать кадр по объекту и увеличить.

    python3 tools/peek.py renders/vh_a_0_raw.png            # -> out/peek_a_0.png
    python3 tools/peek.py renders/vh_a_0_raw.png --zoom 3 --pad 6

Числа ловят палитру, бюджет и габарит, но не отвечают на вопрос «читается ли
силуэт». Для этого кадр надо приблизить: спрайт дома занимает в кадре 512 x 640
треть площади, и мелочи вроде шва кладки или переплёта окна на нём не видно.

Если файлов несколько — собирается лист в ряд (для сравнения вариантов и
поворотов).
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def crop(path, pad=4, zoom=1, bg=(250, 250, 250)):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im)[..., 3]
    ys, xs = np.nonzero(a > 8)
    if not len(xs):
        return None
    x0, x1 = max(0, xs.min() - pad), min(im.width, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(im.height, ys.max() + 1 + pad)
    sub = im.crop((x0, y0, x1, y1))
    if zoom != 1:
        sub = sub.resize((sub.width * zoom, sub.height * zoom), Image.NEAREST)
    flat = Image.new('RGBA', sub.size, bg + (255,))
    flat.alpha_composite(sub)
    return flat.convert('RGB'), (x1 - x0, y1 - y0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--out')
    ap.add_argument('--pad', type=int, default=6)
    ap.add_argument('--zoom', type=int, default=2)
    ap.add_argument('--row', action='store_true', help='собрать лист в ряд')
    args = ap.parse_args()

    items = []
    for f in args.files:
        r = crop(f, args.pad, args.zoom)
        if r is None:
            print('пусто: %s' % f)
            continue
        items.append((os.path.basename(f), r[0], r[1]))
        print('%-28s объект %dx%d -> %dx%d' % (os.path.basename(f), r[1][0],
                                               r[1][1], r[0].width, r[0].height))
    if not items:
        return 1
    out = args.out
    if out is None:
        base = os.path.splitext(os.path.basename(args.files[0]))[0]
        out = os.path.join(ROOT, 'out', 'peek_%s.png' % base)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if len(items) == 1 or not args.row:
        items[0][1].save(out)
    else:
        h = max(i[1].height for i in items)
        w = sum(i[1].width for i in items) + 8 * (len(items) - 1)
        sheet = Image.new('RGB', (w, h), (250, 250, 250))
        x = 0
        for _, img, _ in items:
            sheet.paste(img, (x, 0))
            x += img.width + 8
        sheet.save(out)
    print('-> %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
