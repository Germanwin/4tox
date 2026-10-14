"""Наложение рендера хижины на эталон: где расходится силуэт.

    python3 ref/overlay.py [out/hut_0.png] [ref/overlay.png]

Рендер приводится к ширине силуэта эталона, центрируется по нему и рисуется
поверх полупрозрачно; контур рендера — красным, контур эталона — синим.
Так видно, что именно не совпало: длина конька, высота стены, свес, дверь.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))


def sil_box(alpha):
    ys, xs = np.nonzero(alpha > 24)
    return xs.min(), ys.min(), xs.max(), ys.max()


def outline(alpha):
    im = Image.fromarray((alpha > 24).astype(np.uint8) * 255)
    grown = np.array(im.filter(ImageFilter.MaxFilter(3)))
    edge = (grown > 0) & (alpha <= 24)
    return edge


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), 'out', 'hut_0.png')
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'overlay.png')

    ref = Image.open(os.path.join(HERE, 'ref_full.png')).convert('RGBA')
    r = np.asarray(ref)
    r_alpha = np.where((r[:, :, :3].mean(2) < 236), 255, 0).astype(np.uint8)
    rx0, ry0, rx1, ry1 = sil_box(r_alpha)

    hut = Image.open(src).convert('RGBA')
    if os.environ.get('MIRROR', '1') == '1':
        hut = hut.transpose(Image.FLIP_LEFT_RIGHT)
    h = np.asarray(hut)
    h_alpha = h[:, :, 3]
    hx0, hy0, hx1, hy1 = sil_box(h_alpha)

    k = (rx1 - rx0 + 1) / float(hx1 - hx0 + 1)
    hut = hut.resize((max(1, int(round(hut.width * k))), max(1, int(round(hut.height * k)))),
                     Image.LANCZOS)
    h = np.asarray(hut)
    h_alpha = h[:, :, 3]
    hx0, hy0, hx1, hy1 = sil_box(h_alpha)

    # совмещаем центры силуэтов
    dx = int(round((rx0 + rx1) / 2 - (hx0 + hx1) / 2))
    dy = int(round((ry0 + ry1) / 2 - (hy0 + hy1) / 2))

    out = np.array(ref).astype(np.float32)
    H, W = out.shape[:2]
    canvas = np.zeros((H, W, 4), np.float32)
    ys0, xs0 = max(0, dy), max(0, dx)
    sy0, sx0 = max(0, -dy), max(0, -dx)
    hh = min(H - ys0, h.shape[0] - sy0)
    ww = min(W - xs0, h.shape[1] - sx0)
    canvas[ys0:ys0 + hh, xs0:xs0 + ww] = h[sy0:sy0 + hh, sx0:sx0 + ww].astype(np.float32) / 255.0

    a = canvas[:, :, 3:4]
    # рендер поверх эталона вполовину, чтобы сравнивать формы
    rgb = out[:, :, :3]
    mix = rgb * (1 - a * 0.65) + canvas[:, :, :3] * 255 * (a * 0.65)
    out[:, :, :3] = mix

    # красный — контур рендера, синий — контур эталона
    e_h = outline((canvas[:, :, 3] * 255).astype(np.uint8))
    out[e_h] = [230, 30, 30, 255]
    e_r = outline(r_alpha)
    out[e_r & ~e_h] = [30, 60, 230, 255]

    Image.fromarray(out.astype(np.uint8)).convert('RGB').save(dst)
    print('%s: рендер ширина %d -> масштаб %.3f, сдвиг (%d,%d)' % (
        dst, hx1 - hx0 + 1, k, dx, dy))


if __name__ == '__main__':
    main()
