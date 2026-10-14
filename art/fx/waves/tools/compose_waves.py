"""Пост-обработка рендеров волн: тень-пятно под валом, тёмный контур, обрезка.

    python3 tools/compose_waves.py [--outline] [--shadow]

Контур и тень по умолчанию выключены: у волны нет ни того, ни другого в
природе — пена лежит на воде, а не стоит на земле, и тёмный контур по
силуэту превращает тонкий гребень в осколок льда. Обе ручки оставлены
на случай, если море захочется сделать «мультяшнее».

Читает renders/wave_<форма>_<поворот>_raw.png, пишет out/wave_<форма>_<поворот>.png
и out/sprites.json — в том же виде, что townhall/out/sprites.json, чтобы
mapgen2/tools/pack_waves.py упаковал это в атлас без переделок.

Проекция берётся не из townhall/tools/geom.py, а из самой камеры thpipe:
та кладёт +Y вниз-влево (как в игре), а +X — вверх-влево (зеркально игре,
см. README). Для тени и точки опоры важен именно этот, проверенный рендером
базис: точка (1,0,0) садится в кадре влево-вверх, а не вправо-вниз.
"""
import argparse
import glob
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
ORTHO = 8.0
RES_X, RES_Y = 768, 960
PPU = RES_Y / ORTHO

# Базис камеры рендера (проверен пробным рендером: см. README).
RIGHT = (-math.cos(AZ), -math.sin(AZ), 0.0)
UP = (math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))

SHADOW_RGB = (10, 42, 62)        # тень на воде — тёмно-синяя, не чёрная
SHADOW_ALPHA = 0.13
OUTLINE_RGB = (13, 44, 60)       # контур тоже в воду, а не в зелень
OUTLINE_DILATE = 1


def project(x, y, z):
    sx = x * RIGHT[0] + y * RIGHT[1] + z * RIGHT[2]
    sy = x * UP[0] + y * UP[1] + z * UP[2]
    return RES_X / 2.0 + sx * PPU, RES_Y / 2.0 - sy * PPU


def ground_ellipse(cx, cy, rx, ry, blur=0.22):
    """Эллипс на земле (мировые полуоси) -> оси эллипса на экране.

    Точка земли (x, y, 0) садится в кадр со сдвигом
    (x·RIGHT[0] + y·RIGHT[1], x·UP[0] + y·UP[1])·ppu, поэтому эллипс с
    полуосями rx по X и ry по Y — это образ окружности под линейным
    отображением: считаем ковариацию и берём её собственные числа.
    """
    a2 = (rx ** 2 * RIGHT[0] ** 2 + ry ** 2 * RIGHT[1] ** 2) * PPU ** 2
    b2 = (rx ** 2 * UP[0] ** 2 + ry ** 2 * UP[1] ** 2) * PPU ** 2
    c2 = (rx ** 2 * RIGHT[0] * UP[0] + ry ** 2 * RIGHT[1] * UP[1]) * PPU ** 2
    tr = a2 + b2
    det = a2 * b2 - c2 ** 2
    disc = max(0.0, (tr / 2.0) ** 2 - det) ** 0.5
    l1 = tr / 2.0 + disc
    l2 = max(tr / 2.0 - disc, 1e-9)
    ang = 0.5 * math.atan2(2.0 * c2, a2 - b2)
    return dict(cx=cx, cy=cy, a=math.sqrt(l1), b=math.sqrt(l2),
                angle_deg=math.degrees(ang), blur=blur)


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


# Тень под валом: пятно по габариту вала, сдвинуто вниз (солнце сверху).
SHADOW_SPREAD = 0.62


def shadow_shape(length, width):
    cx, cy = project(0.0, 0.0, 0.0)
    # сдвиг вниз-вправо по экрану — как у остальных спрайтов игры
    e = ground_ellipse(cx + 3.0, cy + 5.0,
                       length * 0.5 * SHADOW_SPREAD, width * SHADOW_SPREAD)
    return e


def compose(raw_path, length, width, outline=True, shadow=True,
            crop=True, pad=3, save_path=None):
    img = Image.open(raw_path).convert('RGBA')
    W, H = img.size
    ax, ay = project(0.0, 0.0, 0.0)

    base = np.array(img).astype(np.float32)
    obj_a = base[:, :, 3] / 255.0

    if shadow:
        e = shadow_shape(length, width)
        m = ellipse_mask((W, H), e)
        m = np.array(Image.fromarray(m).filter(
            ImageFilter.GaussianBlur(max(0.5, e['blur'] * PPU))))
        # тень только там, где нет самого вала: под валом она не видна
        sa = (m.astype(np.float32) / 255.0) * SHADOW_ALPHA * (1.0 - obj_a)
        mixed = np.clip(obj_a + sa, 0, 1)
        sh_rgb = np.array(SHADOW_RGB, np.float32)[None, None, :]
        rgb = (base[:, :, :3] * obj_a[..., None] + sh_rgb * sa[..., None]) / \
            np.maximum(mixed[..., None], 1e-6)
        base = np.concatenate([rgb, (mixed * 255)[..., None]], axis=2)
        obj_a = mixed

    if outline:
        sil = (base[:, :, 3] > 8).astype(np.uint8) * 255
        grown = np.array(Image.fromarray(sil).filter(
            ImageFilter.MaxFilter(2 * OUTLINE_DILATE + 1)))
        ring = np.clip(grown.astype(np.float32) - base[:, :, 3], 0, 255)
        bot_a = ring / 255.0
        out_a = obj_a + bot_a * (1 - obj_a)
        col = np.array(OUTLINE_RGB, np.float32)[None, None, :]
        rgb = (base[:, :, :3] * obj_a[..., None] +
               col * (bot_a * (1 - obj_a))[..., None]) / np.maximum(out_a[..., None], 1e-6)
        base = np.concatenate([rgb, (out_a * 255)[..., None]], axis=2)
        obj_a = out_a

    out = np.clip(base, 0, 255).astype(np.uint8)
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


def shape_size(shape):
    """Габарит формы в юнитах: длина вала и его ширина по Y."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    from wave_shapes import shape as shape_params
    length, _h, _chop = shape_params(shape)
    return length, 0.62


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--outline', action='store_true')
    ap.add_argument('--shadow', action='store_true')
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    files = sorted(glob.glob(os.path.join(RENDERS, 'wave_*_raw.png')))
    frames = {}
    for path in files:
        m = re.match(r'wave_(\d+)_(\d+)_raw\.png$', os.path.basename(path))
        if not m:
            continue
        shape, rot = int(m.group(1)), int(m.group(2))
        length, width = shape_size(shape)
        name = 'wave_%d_%d' % (shape, rot)
        dst = os.path.join(OUT, name + '.png')
        img, ax, ay = compose(path, length, width,
                              outline=args.outline, shadow=args.shadow,
                              save_path=dst)
        frames[name] = dict(file=os.path.basename(dst), w=img.width, h=img.height,
                            anchorX=round(ax, 2), anchorY=round(ay, 2),
                            shape=shape, rotation=rot, units=round(length, 2))
        print('COMPOSED %s %dx%d опора=(%.1f,%.1f)' % (name, img.width, img.height, ax, ay))

    meta = dict(ppu=PPU, az_deg=math.degrees(AZ), el_deg=math.degrees(EL),
                ortho=ORTHO, res=[RES_X, RES_Y],
                note=('спрайты волн: 1 юнит модели = 1 клетка карты, '
                      'anchorX/anchorY — центр вала на уровне воды; '
                      'rotation 0 — вал вдоль течения, 90 — поперёк'),
                frames=frames)
    with open(os.path.join(OUT, 'sprites.json'), 'w') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print('sprites.json записан, кадров %d' % len(frames))


if __name__ == '__main__':
    main()
