"""fit_shadow.py — подбор контактной тени ЧИСЛОМ, а не на глаз.

    python3 tools/fit_shadow.py [--variant a] [--top 12] [--apply]

Зачем. Тень под постройкой — не проекция наземного пятна (у неё bbox всегда
h/w = tan 30 = 0.577, а канон требует 0.045..0.263), а плоский эллипс в
ЭКРАННЫХ пикселях. Пороги гейта (`4tox-lowpoly-3d/references/palette.json`,
`shadow`):

    ширина пятна / ширина силуэта   0.70 .. 2.00   (ядро 0.85..1.05)
    h/w (ниже низа силуэта)         0.04 .. 0.40   (ядро 0.13..0.22)
    пик альфы                       0.25 .. 0.90   (ядро 0.30..0.80)
    p90 альфы                       0.08 .. 0.70

Меряет тем же кодом, что гейт (`measure.py::shadow_mask`): тень — это
полупрозрачные почти чёрные пиксели НИЖЕ низа силуэта, с отступом 1 px.

Считается быстро: силуэт (с контуром) берётся из сырого кадра один раз,
дальше для каждого набора параметров пересчитывается только альфа тени.

`--apply` вписывает лучший набор в tools/compose.py (SHADOW = ...).
"""
import argparse
import itertools
import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import compose as C                                             # noqa: E402

CANON = dict(w_over_sil=(0.70, 2.00), h_over_w=(0.04, 0.40),
             max_alpha=(0.25, 0.90), p90_alpha=(0.08, 0.70))
CORE = dict(w_over_sil=0.95, h_over_w=0.175, max_alpha=0.55, p90_alpha=0.45)


def context(raw_path):
    """Силуэт кадра ПОСЛЕ контура + низ силуэта и ширина (тень их не меняет)."""
    img = Image.open(raw_path).convert('RGBA')
    base = np.array(img).astype(np.float32)
    obj_a = base[:, :, 3] / 255.0
    sil = (base[:, :, 3] > 8).astype(np.uint8) * 255
    grown = np.array(Image.fromarray(sil).filter(
        ImageFilter.MaxFilter(2 * C.OUTLINE_DILATE + 1)))
    ring = np.clip(grown.astype(np.float32) - base[:, :, 3], 0, 255) / 255.0
    obj_a = obj_a + ring * (1 - obj_a)
    m = obj_a > (200 / 255.0)
    bot = int(np.where(m.any(axis=1))[0].max())
    sil_w = float(np.ptp(np.where(m.any(axis=0))[0]) + 1)
    return obj_a, bot, sil_w, img.size


def evaluate(obj_a, bot, sil_w, size, sh, shape):
    W, H = size
    yy, xx = np.mgrid[0:H, 0:W]
    t = math.radians(sh['angle_deg'])
    ct, st = math.cos(t), math.sin(t)
    dx = xx - shape[0]
    dy = yy - shape[1]
    u = (dx * ct + dy * st) / max(sh['a'], 1e-6)
    v = (-dx * st + dy * ct) / max(sh['b'], 1e-6)
    m = ((u * u + v * v) <= 1.0).astype(np.uint8) * 255
    m = np.array(Image.fromarray(m).filter(
        ImageFilter.GaussianBlur(max(0.5, sh['blur'])))).astype(np.float32) / 255.0
    sa = m * sh['alpha']
    mixed = np.clip(obj_a + sa * (1 - obj_a), 0, 1) * 255.0
    rows = np.arange(H)[:, None]
    vis = (mixed > 8) & (mixed <= 217) & (rows > bot + 1)
    if not vis.any():
        return None
    sr = np.where(vis.any(axis=1))[0]
    sc = np.where(vis.any(axis=0))[0]
    w = float(sc.max() - sc.min() + 1)
    h = float(sr.max() - sr.min() + 1)
    wide = (mixed > 8) & (mixed <= 217) & (rows > bot)
    al = mixed[wide if wide.any() else vis] / 255.0
    return dict(w=w, h=h, h_over_w=h / max(w, 1.0), w_over_sil=w / sil_w,
                max_alpha=float(al.max()), p90_alpha=float(np.percentile(al, 90)))


def penalty(s):
    if s is None:
        return 9.0
    pen = 0.0
    for key, (lo, hi) in CANON.items():
        v = s[key]
        if v < lo:
            pen += (lo - v) / max(abs(lo), 1e-6)
        elif v > hi:
            pen += (v - hi) / max(abs(hi), 1e-6)
    return pen


def coreness(s):
    if s is None:
        return 9.0
    return sum(abs(s[k] - v) / max(abs(v), 1e-6) for k, v in CORE.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variant', default='a')
    ap.add_argument('--top', type=int, default=10)
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    raw = os.path.join(C.RENDERS, 'vh_%s_0_raw.png' % args.variant)
    ax0, ay0 = C.project((0.0, 0.0, 0.0))
    obj_a, bot, sil_w, size = context(raw)
    print('силуэт: ширина %.0f px, низ y=%d; опора пятна (%.0f, %.0f); кадр %s'
          % (sil_w, bot, ax0, ay0, size))

    rows = []
    for a_, b_, ang, alpha, blur, dx, dy in itertools.product(
            (150.0, 180.0, 210.0, 240.0), (30.0, 38.0, 46.0, 54.0),
            (0.0, 12.0, -12.0), (0.30, 0.40, 0.50), (2.0, 3.0),
            (0.0, 20.0, 40.0), (48.0, 60.0, 72.0, 84.0)):
        sh = dict(a=a_, b=b_, angle_deg=ang, alpha=alpha, blur=blur)
        s = evaluate(obj_a, bot, sil_w, size, sh, (ax0 + dx, ay0 + dy))
        rows.append((penalty(s), coreness(s), sh, s, (ax0 + dx, ay0 + dy)))
    rows.sort(key=lambda r: (r[0], r[1]))
    print('%-6s %5s %5s %5s %4s %5s %4s %4s  %-34s %s'
          % ('штраф', 'a', 'b', 'alpha', 'ang', 'blur', 'dx', 'dy', 'замер',
             'ядро'))
    for pen, cor, sh, s, c in rows[:args.top]:
        txt = ('w/sil %.2f h/w %.3f α %.2f p90 %.2f'
               % (s['w_over_sil'], s['h_over_w'], s['max_alpha'], s['p90_alpha'])
               if s else 'пятна нет')
        print('%6.2f %5.0f %5.0f %5.2f %4.0f %5.1f %4.0f %4.0f  %-34s %.2f'
              % (pen, sh['a'], sh['b'], sh['alpha'], sh['angle_deg'], sh['blur'],
                 c[0] - ax0, c[1] - ay0, txt, cor))
    pen, cor, sh, s, c = rows[0]
    print('\nлучший: a=%.0f b=%.0f ang=%.0f alpha=%.2f blur=%.1f shift=(%.1f, %.1f)'
          % (sh['a'], sh['b'], sh['angle_deg'], sh['alpha'], sh['blur'],
             c[0] - ax0, c[1] - ay0))
    print('штраф %.2f, в каноне: %s' % (pen, pen == 0.0))

    if args.apply and pen == 0.0:
        src = open(os.path.join(HERE, 'compose.py'), encoding='utf-8').read()
        block = ('SHADOW = dict(a=%.1f, b=%.1f, angle_deg=%.1f, alpha=%.2f, '
                 'blur=%.1f,\n              shift=(%.1f, %.1f))'
                 % (sh['a'], sh['b'], sh['angle_deg'], sh['alpha'], sh['blur'],
                    c[0] - ax0, c[1] - ay0))
        i = src.index('SHADOW = dict(')
        j = src.index('\n\n', i)
        open(os.path.join(HERE, 'compose.py'), 'w', encoding='utf-8').write(
            src[:i] + block + src[j:])
        print('вписано в tools/compose.py')
    return 0 if pen == 0.0 else 1


if __name__ == '__main__':
    sys.exit(main())
