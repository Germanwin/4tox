"""Общие конвенции кадра: проекция мира в пиксели и пост-обработка спрайта.

Мир -> кадр:
    right = normalize((cos AZ, -sin AZ, 0))     # вправо по экрану
    up    = (-sin EL*cos AZ, -sin EL*sin AZ, cos EL)
    px =  W/2 + (p·right) * ppu
    py =  H/2 - (p·up)    * ppu
Камера смотрит в центр кадра, поэтому точка (0,0,0) всегда в центре.
"""
import math
import os
import sys

import numpy as np

# Blender несёт свой Python без PIL — подключаем site-packages рабочего окружения.
try:
    from PIL import Image, ImageFilter
except ImportError:                                    # pragma: no cover
    _extra = ('/Users/hermmoment/.dsh/dsh-runtimes/dsh-primary-runtime/'
              'dependencies/python/lib/python3.12/site-packages')
    if _extra not in sys.path:
        sys.path.append(_extra)
    from PIL import Image, ImageFilter

# те же числа, что в thpipe (держим в одном месте, чтобы не разъехались)
AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
RES_X, RES_Y = 512, 640
ORTHO = 6.10
PPU = RES_Y / ORTHO

RIGHT = (math.cos(AZ), -math.sin(AZ), 0.0)
UP = (-math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))

# --- параметры пост-обработки (замерены по atlas.png) ---
SHADOW_RGB = (11, 14, 11)
SHADOW_ALPHA = 0.62          # гаусс умножается на это
OUTLINE_RGB = (14, 18, 14)
OUTLINE_DILATE = 1           # пикселей (на 105 ppu это ≈ 2 px эталона)


def project(px, py, pz):
    """Мир (u,v) -> пиксели кадра (x, y), начало — левый верх."""
    sx = px * RIGHT[0] + py * RIGHT[1] + pz * RIGHT[2]
    sy = px * UP[0] + py * UP[1] + pz * UP[2]
    return RES_X / 2.0 + sx * PPU, RES_Y / 2.0 - sy * PPU


def center_axis():
    return project(0.0, 0.0, 0.0)


def ground_ellipse(cx, cy, rx, ry, blur=0.16):
    """Эллипс на земле (мировые полуоси) -> параметры для пост-обработки."""
    ux, uy = rx * RIGHT[0], rx * RIGHT[1]
    vx, vy = ry * UP[0], ry * UP[1]
    a2 = ux ** 2 + vx ** 2          # по экранному X
    b2 = uy ** 2 + vy ** 2          # по экранному Y
    c2 = ux * uy + vx * vy
    # собственные оси ковариационной матрицы [[a2, c2], [c2, b2]]
    tr = a2 + b2
    det = a2 * b2 - c2 ** 2
    disc = max(0.0, (tr / 2) ** 2 - det) ** 0.5
    l1 = tr / 2 + disc
    l2 = max(tr / 2 - disc, 1e-9)
    ang = 0.5 * math.atan2(2 * c2, a2 - b2)
    return dict(cx=cx, cy=cy, a=math.sqrt(l1) * PPU, b=math.sqrt(l2) * PPU,
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
    inside = (u * u + v * v) <= 1.0
    return (inside * 255).astype(np.uint8)


def compose(render_path, out_path, shadows=(), outline=False,
            crop=True, pad=3, save=True):
    """Рендер RGBA -> спрайт: мягкая тень под объектом + (опц.) контур силуэта.

    shadows — список форм из ground_ellipse(); рисуются в порядке перечисления.
    Возвращает (image, anchor_x, anchor_y) в системе обрезанного кадра.
    """
    img = Image.open(render_path).convert('RGBA')
    W, H = img.size
    ax, ay = center_axis()

    shadow = np.zeros((H, W), np.uint8)
    for sh in shadows:
        m = ellipse_mask((W, H), sh)
        blur_px = max(0.5, sh['blur'] * PPU)
        m = np.array(Image.fromarray(m).filter(ImageFilter.GaussianBlur(blur_px)))
        shadow = np.maximum(shadow, m)

    base = np.array(img).astype(np.int32)
    alpha_obj = base[:, :, 3]

    # контур: расширяем силуэт и подкладываем снизу тёмный слой
    if outline:
        sil = (alpha_obj > 8).astype(np.uint8) * 255
        grown = np.array(Image.fromarray(sil).filter(
            ImageFilter.MaxFilter(2 * OUTLINE_DILATE + 1)))
        ring = np.clip(grown.astype(np.int32) - alpha_obj.astype(np.int32), 0, 255)
        layer = np.zeros_like(base)
        layer[:, :, 0], layer[:, :, 1], layer[:, :, 2] = OUTLINE_RGB
        layer[:, :, 3] = ring
        a_top = alpha_obj[..., None] / 255.0
        a_bot = layer[:, :, 3:4] / 255.0
        out_a = a_top + a_bot * (1 - a_top)
        rgb = np.where(out_a > 1e-6,
                       (base[:, :, :3] * a_top + layer[:, :, :3] * a_bot * (1 - a_top)) /
                       np.maximum(out_a, 1e-6), 0)
        base = np.concatenate([rgb, out_a * 255], axis=2).astype(np.int32)

    # контактная тень под объектом (объект поверх, но тень видна сквозь щели)
    sa = (shadow.astype(np.float32) / 255.0) * SHADOW_ALPHA
    obj_a = base[:, :, 3].astype(np.float32) / 255.0
    mixed_a = np.clip(obj_a + sa * (1 - obj_a), 0, 1)
    body = base[:, :, :3].astype(np.float32)
    sh_rgb = np.array(SHADOW_RGB, dtype=np.float32)[None, None, :]
    mix_w = sa[..., None] * (1 - obj_a[..., None])
    rgb = (body * obj_a[..., None] + sh_rgb * mix_w) / np.maximum(mixed_a[..., None], 1e-6)
    out = np.concatenate([rgb, (mixed_a * 255)[..., None]], axis=2)
    out = np.clip(out, 0, 255).astype(np.uint8)

    res = Image.fromarray(out, 'RGBA')
    ax_i, ay_i = ax, ay
    if crop:
        a = out[:, :, 3]
        ys, xs = np.nonzero(a > 4)
        if len(ys):
            x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + 1 + pad)
            y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + 1 + pad)
            res = res.crop((x0, y0, x1, y1))
            ax_i, ay_i = ax - x0, ay - y0
    if save and out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        res.save(out_path)
    return res, ax_i, ay_i
