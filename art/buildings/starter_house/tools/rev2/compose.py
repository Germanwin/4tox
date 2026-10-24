"""compose.py — пост-обработка кадров дома: контур, контактная тень, обрезка.

    python3 tools/compose.py [--variants a,b,c] [--rotations 0,90,180,270]

Читает renders/vh_<вар>_<поворот>_raw.png (512 x 640, 80 px на юнит), пишет
out/vh_<вар>_<поворот>.png и out/vh_sprites.json.

Два канонных элемента рисуются ЗДЕСЬ, а не в меше:

* **контур** `#0E120E`: расширение силуэта на OUTLINE_DILATE пикселей
  (2 px при 96 ppu -> 1.67 px при 80; берём 2 px, канон 0.6..3.5);
* **контактная тень** — ПЛОСКИЙ ЭЛЛИПС В ЭКРАННЫХ ПИКСЕЛЯХ. Проекция
  наземного пятна в этой изометрии всегда даёт bbox h/w = tan 30 = 0.577,
  а канон требует 0.045..0.263, поэтому пятно рисуется сразу на экране
  (`4tox-lowpoly-3d/references/pitfalls.md`, §1). Пятно растянуто вдоль
  линии контакта: у дома это передняя кромка пятна застройки, на экране
  она идёт под 30 градусов.

Параметры пятна подобраны замером (tools/fit_shadow.py -> этот файл):
ширина пятна / ширина силуэта, h/w ниже силуэта и пик альфы обязаны попасть
в пороги гейта.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

RES_X, RES_Y = 512, 640
PPU = 80.0
AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
RIGHT = (math.cos(AZ), -math.sin(AZ), 0.0)
UP = (-math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))

OUTLINE_RGB = (14, 18, 14)
OUTLINE_DILATE = 1                 # px при 80 ppu ~ 2 px при 96
SHADOW_RGB = (11, 14, 11)

# --- пятно: полуоси в пикселях кадра 80 ppu, наклон большой оси на экране ---
# Пятно тени под стартовым домом: пятно 2 x 3 (короткая сторона 2 клетки),
# поэтому эллипс короче, чем у дома 3 x 2 (a=136).  Полуоси подобраны замером
# по кадру: ширина пятна ≈ силуэт, h/w в допуске 0.13..0.22.
# Пятно тени под стартовым домом.  Дом УЖЕ и ГЛУБЖЕ, чем дом жителя (пятно
# 2 x 3), поэтому пятно шире и сдвинуто вперёд: гейт требует, чтобы ширина
# пятна была 0.70..2.0 ширины силуэта, а h/w 0.13..0.22.
SHADOW = dict(a=196.0, b=46.0, angle_deg=8.0, alpha=0.42, blur=3.5,
              shift=(22.0, 82.0))


def project(p, screen=(RES_X, RES_Y), ppu=PPU):
    x, y, z = p
    sx = x * RIGHT[0] + y * RIGHT[1] + z * RIGHT[2]
    sy = x * UP[0] + y * UP[1] + z * UP[2]
    return screen[0] / 2.0 + sx * ppu, screen[1] / 2.0 - sy * ppu


def ellipse_mask(size, sh):
    W, H = size
    yy, xx = np.mgrid[0:H, 0:W]
    t = math.radians(sh['angle_deg'])
    ct, st = math.cos(t), math.sin(t)
    dx = xx - sh['cx']
    dy = yy - sh['cy']
    u = (dx * ct + dy * st) / max(sh['a'], 1e-6)
    v = (-dx * st + dy * ct) / max(sh['b'], 1e-6)
    return ((u * u + v * v) <= 1.0).astype(np.uint8) * 255


def compose(raw_path, shadows, outline=True, crop=True, pad=3, save_path=None,
            ppu=None, screen=(RES_X, RES_Y)):
    """Один кадр: контур + пятна тени + обрезка.

    `ppu` — масштаб кадра (80 для игры, 384 для гейта @4x): и полуоси пятна,
    и размытие, и сдвиг, и толщина контура умножаются на ppu/80, иначе на
    кадре 4x тень уезжает под дом, а контур становится вчетверо тоньше нормы.
    """
    img = Image.open(raw_path).convert('RGBA')
    W, H = img.size
    k = (ppu or PPU) / PPU
    ax, ay = project((0.0, 0.0, 0.0), screen=screen, ppu=ppu or PPU)
    dilate = max(1, int(round(OUTLINE_DILATE * k)))

    shadow = np.zeros((H, W), np.uint8)
    for sh in shadows:
        sh = dict(sh)
        sh['a'] *= k
        sh['b'] *= k
        sh['blur'] = sh['blur'] * k
        sh['cx'] = ax + sh['shift'][0] * k
        sh['cy'] = ay + sh['shift'][1] * k
        m = ellipse_mask((W, H), sh)
        m = np.array(Image.fromarray(m).filter(
            ImageFilter.GaussianBlur(max(0.5, sh['blur']))))
        shadow = np.maximum(shadow, m)

    base = np.array(img).astype(np.float32)
    obj_a = base[:, :, 3] / 255.0

    if outline:
        sil = (base[:, :, 3] > 8).astype(np.uint8) * 255
        grown = np.array(Image.fromarray(sil).filter(
            ImageFilter.MaxFilter(2 * dilate + 1)))
        ring = np.clip(grown.astype(np.float32) - base[:, :, 3], 0, 255)
        bot_a = ring / 255.0
        out_a = obj_a + bot_a * (1 - obj_a)
        col = np.array(OUTLINE_RGB, np.float32)[None, None, :]
        rgb = (base[:, :, :3] * obj_a[..., None]
               + col * (bot_a * (1 - obj_a))[..., None]) / np.maximum(out_a[..., None], 1e-6)
        base = np.concatenate([rgb, (out_a * 255)[..., None]], axis=2)
        obj_a = out_a

    sa = (shadow.astype(np.float32) / 255.0) * SHADOW['alpha']
    mixed_a = np.clip(obj_a + sa * (1 - obj_a), 0, 1)
    sh_rgb = np.array(SHADOW_RGB, np.float32)[None, None, :]
    w_sh = (sa * (1 - obj_a))[..., None]
    rgb = (base[:, :, :3] * obj_a[..., None] + sh_rgb * w_sh) / \
        np.maximum(mixed_a[..., None], 1e-6)
    out = np.clip(np.concatenate([rgb, (mixed_a * 255)[..., None]], axis=2),
                  0, 255).astype(np.uint8)

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
    ap.add_argument('--tag-prefix', default='vh',
                    help='префикс сырых кадров: <prefix>_<поворот>_raw.png')
    ap.add_argument('--variants', default='a,b,c')
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--no-outline', action='store_true')
    ap.add_argument('--tag', default='vh', help='префикс сырых кадров')
    ap.add_argument('--ppu', type=float, default=PPU)
    ap.add_argument('--res', default='%d,%d' % (RES_X, RES_Y))
    args = ap.parse_args()
    res = tuple(int(v) for v in args.res.split(','))
    if abs(args.ppu - PPU) > 1e-6:
        pad_default = 8
    else:
        pad_default = 3

    variants = args.variants.split(',')
    rotations = [int(r) for r in args.rotations.split(',')]
    sprites_path = os.path.join(OUT, '%s_sprites.json'
                                % ('vh' if args.tag == 'vh' else args.tag))
    frames = {}
    if os.path.exists(sprites_path):
        try:
            frames = json.load(open(sprites_path,
                                    encoding='utf-8')).get('frames', {})
        except Exception:
            frames = {}
    for v in variants:
        for rot in rotations:
            if args.tag == 'vh' and v == 'a':
                raw = os.path.join(RENDERS, '%s_%d_raw.png'
                                   % (args.tag_prefix, rot))
                name = '%s_%d' % (args.tag_prefix, rot)
            else:
                raw = os.path.join(RENDERS, '%s_%s_%d_raw.png'
                                   % (args.tag, v, rot))
                name = '%s_%s_%d' % (args.tag, v, rot)
            if not os.path.exists(raw):
                print('НЕТ РЕНДЕРА: %s' % raw)
                continue
            dst = os.path.join(OUT, name + '.png')
            img, ax, ay = compose(raw, [SHADOW], outline=not args.no_outline,
                                  pad=pad_default, save_path=dst,
                                  ppu=args.ppu, screen=res)
            fp = [3, 2] if rot % 180 == 0 else [2, 3]
            frames[name] = dict(
                file=os.path.basename(dst), w=img.width, h=img.height,
                anchorX=round(ax, 2), anchorY=round(ay, 2), variant=v,
                rotation=rot, footprint=fp)
            print('COMPOSED %s %dx%d опора=(%.1f,%.1f) пятно=%s'
                  % (name, img.width, img.height, ax, ay, fp))

    with open(sprites_path, 'w', encoding='utf-8') as f:
        json.dump(dict(ppu=PPU, ortho=RES_Y / PPU, res=[RES_X, RES_Y],
                       az_deg=45.0, el_deg=math.degrees(EL),
                       footprint=[3, 2], variants=variants,
                       note='дом жителя: 1 юнит = 1 клетка; пятно 3 x 2 '
                            '(при повороте 2 x 3); anchorX/anchorY — центр пятна',
                       shadow=SHADOW, outline=dict(rgb=OUTLINE_RGB,
                                                   dilate=OUTLINE_DILATE),
                       frames=frames), f, ensure_ascii=False, indent=1)
    print('%s_sprites.json записан' % os.path.basename(sprites_path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
