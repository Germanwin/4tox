"""Лист сверки: эталон | рендер хижины | он же зеркально (камера эталона снята с другой стороны).

    python3 ref/compare.py [out/hut_0.png] [ref/compare.png]

Всё на белом фоне, приведено к одной высоте, чтобы читались пропорции.
"""
import sys
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def over_white(im):
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im.convert('RGBA'))
    return bg.convert('RGB')


def fit(im, h):
    k = h / im.height
    return im.resize((max(1, int(im.width * k)), h), Image.LANCZOS)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'out', 'hut_0.png')
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'compare.png')
    height = 520
    ref = over_white(Image.open(os.path.join(HERE, 'ref_full.png')))
    hut = over_white(Image.open(src))
    a = fit(ref, height)
    b = fit(hut, height)
    c = fit(hut.transpose(Image.FLIP_LEFT_RIGHT), height)
    gap = 24
    W = a.width + b.width + c.width + gap * 4
    canvas = Image.new('RGB', (W, height + gap * 2), (255, 255, 255))
    x = gap
    for tile in (a, b, c):
        canvas.paste(tile, (x, gap))
        x += tile.width + gap
    canvas.save(dst)
    print('%s  %dx%d  (эталон | рендер | зеркало)' % (dst, canvas.width, canvas.height))


if __name__ == '__main__':
    main()
