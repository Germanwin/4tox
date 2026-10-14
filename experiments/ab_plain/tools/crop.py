# -*- coding: utf-8 -*-
"""crop.py — вырезать и увеличить кусок кадра для осмотра формы.

Числа говорят, что деталь есть; читается ли она в спрайте — видно только
глазами, и для этого нужен крупный план, а не кадр 512 x 640.

    python3 tools/crop.py renders/abp_qa_left.png out/crop_win.png 120 260 260 220 2
"""
import os
import sys

from PIL import Image


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    x, y, w, h = [int(v) for v in sys.argv[3:7]]
    k = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
    im = Image.open(src).convert('RGBA')
    # подложка, иначе прозрачный фон в превью читается как чёрный
    bg = Image.new('RGBA', im.size, (245, 245, 245, 255))
    im = Image.alpha_composite(bg, im)
    box = im.crop((x, y, x + w, y + h))
    box = box.resize((int(w * k), int(h * k)), Image.NEAREST)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    box.save(dst)
    print('%s -> %s  (%dx%d из %dx%d @x%.0f)'
          % (src, dst, box.width, box.height, w, h, k))
    return 0


if __name__ == '__main__':
    sys.exit(main())
