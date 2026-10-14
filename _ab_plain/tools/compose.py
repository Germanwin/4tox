# -*- coding: utf-8 -*-
"""compose.py — пост-обработка кадров: контур, контактная тень, 1x и @4x, листы.

Контур и тень — это ПОСТ, а не геометрия (канон стиля): в меше их быть не
должно. Тень рисуется плоским эллипсом в ЭКРАННЫХ пикселях с большой осью по
линии контакта — проекция наземного пятна даёт bbox h/w = tan 30 = 0.577, а
канон требует 0.04..0.40 (references/pitfalls.md).

    python3 tools/compose.py                # все сырые кадры из renders/
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
OUTLINE = (14, 19, 14)                    # #0E130E — обводка канона
SHADOW_RGB = (0, 0, 0)

# пятно: ширина/силуэт 0.85..1.05, h/w 0.13..0.22 (ядро канона)
SHADOW_W_K = 0.95
SHADOW_H_K = 0.175
SHADOW_ALPHA = 0.34
SHADOW_BLUR = 3.0
SHADOW_SHIFT = (0.0, 5.0)


def load_raw(path):
    im = Image.open(path).convert('RGBA')
    return im


def alpha_bbox(im):
    a = np.asarray(im)[..., 3]
    ys, xs = np.nonzero(a > 8)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def add_shadow(im, anchor, k=1.0):
    """Плоский эллипс под объектом, большая ось — по линии контакта.

    Центр пятна считается от НИЗА СИЛУЭТА, а не от якоря: гейт мерит только ту
    часть пятна, что лежит ниже силуэта (`measure.shadow_mask`, rows > bot + 1),
    и пятно, посаженное по якорю (центр пятна застройки — середина ромба), под
    силуэт не попадает вовсе — ширина/силуэт выходит 0.01 вместо 0.85..1.05.
    Смещение 0.30 h от низа силуэта ставит под кромку самую широкую часть
    эллипса."""
    bb = alpha_bbox(im)
    if bb is None:
        return im
    sil_w = bb[2] - bb[0] + 1
    w = sil_w * SHADOW_W_K
    h = max(4.0 * k, w * SHADOW_H_K)
    cx = anchor[0] + SHADOW_SHIFT[0] * k
    cy = bb[3] + 1 + 0.30 * h + SHADOW_SHIFT[1] * k
    lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.ellipse([cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0],
              fill=(SHADOW_RGB[0], SHADOW_RGB[1], SHADOW_RGB[2],
                    int(255 * SHADOW_ALPHA)))
    lay = lay.filter(ImageFilter.GaussianBlur(SHADOW_BLUR * k))
    return Image.alpha_composite(lay, im)


def add_outline(im, dilate=1):
    """Тёмная обводка по силуэту: расширенная альфа под объектом."""
    a = np.asarray(im)[..., 3]
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.bitmap((0, 0), Image.fromarray(a), fill=OUTLINE + (255,))
    layer = layer.filter(ImageFilter.MaxFilter(2 * dilate + 1))
    return Image.alpha_composite(layer, im)


def compose_one(src, dst, anchor, dilate=1, shadow=True, k=1.0):
    im = load_raw(src)
    if shadow:
        im = add_shadow(im, anchor, k)
    im = add_outline(im, max(1, int(round(dilate * k))))
    im.save(dst)
    return im


def upscale(im, k=4):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def sheet(frames, path, cols=None, bg=(238, 238, 235)):
    """Лист сверки: кадры в ряд (повороты или варианты)."""
    ims = [Image.open(p).convert('RGBA') for p in frames]
    cols = cols or len(ims)
    rows = (len(ims) + cols - 1) // cols
    w, h = ims[0].size
    out = Image.new('RGBA', (w * cols, h * rows), bg + (255,))
    for i, im in enumerate(ims):
        out.alpha_composite(im, ((i % cols) * w, (i // cols) * h))
    out.convert('RGB').save(path)
    return path


def main():
    meta_path = os.path.join(ROOT, 'out', 'sprites.json')
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
    anchor = tuple(meta.get('anchor', [256, 320]))
    raws = sorted(f for f in os.listdir(RENDERS)
                  if f.endswith('_raw.png') and f.startswith('abp_'))
    made = []
    for f in raws:
        src = os.path.join(RENDERS, f)
        if '@4x' in f:
            dst = os.path.join(RENDERS, f[:-8] + '.png')
            compose_one(src, dst, (anchor[0] * 4, anchor[1] * 4),
                        dilate=meta.get('outline_dilate', 1), k=4.0)
            made.append(dst)
            continue
        dst = os.path.join(RENDERS, f[:-8] + '.png')
        compose_one(src, dst, anchor, dilate=meta.get('outline_dilate', 1))
        made.append(dst)
    # лист поворотов варианта a и лист вариантов
    rots = [os.path.join(RENDERS, 'abp_a_%d.png' % r) for r in (0, 90, 180, 270)]
    rots = [p for p in rots if os.path.exists(p)]
    if rots:
        sheet(rots, os.path.join(RENDERS, 'abp_rotations.png'))
        made.append(os.path.join(RENDERS, 'abp_rotations.png'))
    vars_ = [os.path.join(RENDERS, 'abp_%s_0.png' % v) for v in ('a', 'b', 'c')]
    vars_ = [p for p in vars_ if os.path.exists(p)]
    if len(vars_) > 1:
        sheet(vars_, os.path.join(RENDERS, 'abp_variants.png'))
        made.append(os.path.join(RENDERS, 'abp_variants.png'))
    print('собрано кадров: %d' % len(made))
    for p in made:
        print('   ', os.path.basename(p))
    return 0


if __name__ == '__main__':
    sys.exit(main())
