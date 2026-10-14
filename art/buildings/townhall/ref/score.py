"""Оценка вариантов хижины: силуэт + разбивка крыша/стена по цвету с эталоном.

    python3 ref/score.py [папка_перебора]

Считается:
  IoU силуэта   — совпала ли общая форма;
  IoU соломы    — совпало ли, где именно крыша;
  IoU стены     — совпало ли, где именно стена;
  итог = сумма трёх (чем больше, тем лучше).
Классификация соломы одинаковая для эталона и для рендера, поэтому сравнение
честное: светлая солома (r-b>=48, r-g>=10, яркость>=150), тень отбрасывается.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def masks_from_rgb(a):
    r, g, b = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    neutral = (abs(r - g) < 14) & (abs(g - b) < 14)
    bg = (r > 236) & (g > 236) & (b > 236)
    sil = ~bg & ~(neutral & (lum >= 150))
    th = sil & (r - b >= 48) & (r - g >= 10) & (lum >= 150)
    return sil, th


def ref_masks():
    a = np.asarray(Image.open(os.path.join(HERE, 'ref_full.png')).convert('RGB'))
    return masks_from_rgb(a)


def render_masks(path):
    a = np.asarray(Image.open(path).convert('RGBA'))
    sil = a[:, :, 3] > 24
    _, th = masks_from_rgb(a[:, :, :3])
    return sil, (th & sil)


def crop(m):
    ys, xs = np.nonzero(m)
    if not len(ys):
        return m
    return m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def _prep(m, width=520):
    k = width / float(m.shape[1])
    im = Image.fromarray((m * 255).astype(np.uint8)).resize(
        (width, max(1, int(round(m.shape[0] * k)))), Image.LANCZOS)
    return np.asarray(im) > 127


def _iou_pair(A, B):
    h = max(A.shape[0], B.shape[0])
    w = A.shape[1]

    def pad(m):
        out = np.zeros((h, w), bool)
        y = (h - m.shape[0]) // 2
        out[y:y + m.shape[0]] = m
        return out
    A, B = pad(A), pad(B)
    u = (A | B).sum()
    return (A & B).sum() / float(u) if u else 0.0


def compare(ref_pair, ren_pair):
    sil = _iou_pair(_prep(crop(ref_pair[0])), _prep(crop(ren_pair[0])))
    th = _iou_pair(_prep(crop(ref_pair[1])), _prep(crop(ren_pair[1])))
    wall = _iou_pair(_prep(crop(ref_pair[0] & ~ref_pair[1])),
                     _prep(crop(ren_pair[0] & ~ren_pair[1])))
    return sil, th, wall, sil + th + wall


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sweep')
    if not os.path.isdir(d):
        s = compare(ref_masks(), render_masks(d))
        print('силуэт %.3f  солома %.3f  стена %.3f  итог %.3f' % s)
        return
    meta = json.load(open(os.path.join(d, 'variants.json')))
    R = ref_masks()
    rows = []
    for m in meta:
        s = compare(R, render_masks(os.path.join(d, m['file'])))
        rows.append((s[3], s[0], s[1], s[2], m['name']))
    for t, s, th, w, name in sorted(rows, reverse=True):
        print('итог %.3f  (силуэт %.3f  солома %.3f  стена %.3f)  %s' % (t, s, th, w, name))


if __name__ == '__main__':
    main()
