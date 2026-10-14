"""Пост-обработка рендеров ратуши: мягкая тень-пятно и опциональный контур.

    python3 tools/compose.py [--no-outline] [--variants a,b,c]

Читает renders/th_<вариант>_<поворот>_raw.png, пишет out/th_<вариант>_<поворот>.png
и out/sprites.json со спрайтами и точками опоры.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import geom

ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')


def ellipse_mask(size, shape):
    W, H = size
    yy, xx = np.mgrid[0:H, 0:W]
    t = math.radians(shape['angle_deg'])
    ct, st = math.cos(t), math.sin(t)
    dx = xx - shape['cx']
    dy = yy - shape['cy']
    u = (dx * ct + dy * st) / max(shape['a'], 1e-6)
    v = (-dx * st + dy * ct) / max(shape['b'], 1e-6)
    return ((u * u + v * v) <= 1.0).astype(np.uint8) * 255


def compose(raw_path, shadows, outline=True, crop=True, pad=3, save_path=None):
    img = Image.open(raw_path).convert('RGBA')
    W, H = img.size
    ax, ay = geom.project(0.0, 0.0, 0.0)

    dx_px, dy_px = geom.SHADOW_SHIFT_PX
    wx, wy = geom.world_offset(dx_px, dy_px)
    shadow = np.zeros((H, W), np.uint8)
    for sh in shadows:
        sh = dict(sh)
        sh['cx'], sh['cy'] = geom.project(wx, wy, geom.SHADOW_LIFT)
        m = ellipse_mask((W, H), sh)
        m = np.array(Image.fromarray(m).filter(
            ImageFilter.GaussianBlur(max(0.5, sh['blur'] * geom.PPU))))
        shadow = np.maximum(shadow, m)

    base = np.array(img).astype(np.float32)
    obj_a = base[:, :, 3] / 255.0

    if outline:
        sil = (base[:, :, 3] > 8).astype(np.uint8) * 255
        grown = np.array(Image.fromarray(sil).filter(
            ImageFilter.MaxFilter(2 * geom.OUTLINE_DILATE + 1)))
        ring = np.clip(grown.astype(np.float32) - base[:, :, 3], 0, 255)
        bot_a = ring / 255.0
        out_a = obj_a + bot_a * (1 - obj_a)
        col = np.array(geom.OUTLINE_RGB, np.float32)[None, None, :]
        rgb = (base[:, :, :3] * obj_a[..., None] +
               col * (bot_a * (1 - obj_a))[..., None]) / np.maximum(out_a[..., None], 1e-6)
        base = np.concatenate([rgb, (out_a * 255)[..., None]], axis=2)
        obj_a = out_a

    # контактная тень: под объектом и чуть просвечивает по краям силуэта
    sa = (shadow.astype(np.float32) / 255.0) * geom.SHADOW_ALPHA
    mixed_a = np.clip(obj_a + sa * (1 - obj_a), 0, 1)
    sh_rgb = np.array(geom.SHADOW_RGB, np.float32)[None, None, :]
    w_sh = (sa * (1 - obj_a))[..., None]
    rgb = (base[:, :, :3] * obj_a[..., None] + sh_rgb * w_sh) / \
        np.maximum(mixed_a[..., None], 1e-6)
    out = np.clip(np.concatenate([rgb, (mixed_a * 255)[..., None]], axis=2), 0, 255)
    out = out.astype(np.uint8)

    res = Image.fromarray(out, 'RGBA')
    ax_i, ay_i = ax, ay
    if crop:
        ys, xs = np.nonzero(out[:, :, 3] > 4)
        if len(ys):
            x0, x1 = max(0, int(xs.min()) - pad), min(W, int(xs.max()) + 1 + pad)
            y0, y1 = max(0, int(ys.min()) - pad), min(H, int(ys.max()) + 1 + pad)
            res = res.crop((x0, y0, x1, y1))
            ax_i, ay_i = ax - x0, ay - y0
    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        res.save(save_path)
    return res, float(ax_i), float(ay_i)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants', default='a,b,c')
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--no-outline', action='store_true')
    args = ap.parse_args()

    variants = args.variants.split(',')
    rotations = [int(r) for r in args.rotations.split(',')]
    # не терять ранее собранные варианты: дополняем существующий список
    sprites_path = os.path.join(OUT, 'sprites.json')
    sprites = {}
    if os.path.exists(sprites_path):
        try:
            sprites = json.load(open(sprites_path)).get('frames', {})
        except Exception:
            sprites = {}
    for v in variants:
        for rot in rotations:
            raw = os.path.join(RENDERS, 'th_%s_%d_raw.png' % (v, rot))
            if not os.path.exists(raw):
                print('НЕТ РЕНДЕРА: %s' % raw)
                continue
            dst = os.path.join(OUT, 'th_%s_%d.png' % (v, rot))
            img, ax, ay = compose(raw, geom.shadows_for(v),
                                  outline=not args.no_outline, save_path=dst)
            key = 'townhall_%s_%d' % (v, rot)
            sprites[key] = dict(file=os.path.basename(dst), w=img.width, h=img.height,
                                anchorX=round(ax, 2), anchorY=round(ay, 2), variant=v,
                                rotation=rot)
            # служебная обрезка без тени — для сравнения силуэта с эталоном
            if rot == 0:
                cut, cax, cay = compose(raw, [], outline=not args.no_outline,
                                        crop=True, pad=2,
                                        save_path=os.path.join(OUT, 'cut_%s.png' % v))
                sprites['cut_' + v] = dict(file='cut_%s.png' % v, w=cut.width,
                                           h=cut.height, anchorX=round(cax, 2),
                                           anchorY=round(cay, 2))
            print('COMPOSED %s %dx%d опора=(%.1f,%.1f)' % (key, img.width, img.height, ax, ay))

    with open(sprites_path, 'w') as f:
        json.dump(dict(ppu=geom.PPU, ortho=geom.ORTHO, res=[geom.RES_X, geom.RES_Y],
                       note='1 юнит модели = 1 клетка; ратуша 4 клетки по X, 3 по Y',
                       frames=sprites), f, ensure_ascii=False, indent=1)
    print('sprites.json записан')


if __name__ == '__main__':
    main()
