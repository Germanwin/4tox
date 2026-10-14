# -*- coding: utf-8 -*-
"""softrender.py — СВОЙ софт-рендер: плоские фасеты, ортография, z-буфер.

Ни Blender, ни GPU: чистый numpy. Нужен для двух вещей:

  1. **Быстрый осмотр формы** без живой сессии — секунды на кадр вместо
     запуска рендера в чужом Blender;
  2. **Проверка изнанок.** Кадр рисуется с выключенным отсечением задних
     граней, и для каждого пикселя запоминается, какая грань до него дошла —
     лицевая или тыльная. Пиксель, который закрыт ТЫЛЬНОЙ гранью, означает
     дыру в меше или вывернутую нормаль: снаружи мы видим «нутро» детали.
     Число таких пикселей — метрика (у дома-соседа это называлось xray).

Цвет — тон атласа (tone.py), без солнца и неба: это albedo-вид, по нему и
сверяется палитра кадра.

    python3 tools/softrender.py --variant a --view iso --out renders/soft_a_iso.png
"""
import argparse
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import building as B                                              # noqa: E402
import tone as T                                                  # noqa: E402

AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))

# канонная камера: куда смотрит (fwd), вправо (right), вверх (up)
FWD = np.array([math.cos(EL) * math.cos(AZ), -math.cos(EL) * math.sin(AZ), -math.sin(EL)])
RIGHT = np.cross(FWD, np.array([0.0, 0.0, 1.0]))
RIGHT /= np.linalg.norm(RIGHT)
UP = np.cross(RIGHT, FWD)
UP /= np.linalg.norm(UP)

AXIS_VIEWS = {
    'iso': (FWD, RIGHT, UP),
    'front': (np.array([0.0, -1.0, 0.0]), np.array([-1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])),
    'back': (np.array([0.0, 1.0, 0.0]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])),
    'left': (np.array([1.0, 0.0, 0.0]), np.array([0.0, -1.0, 0.0]), np.array([0.0, 0.0, 1.0])),
    'right': (np.array([-1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0])),
}


def hex_rgb(s):
    s = s.lstrip('#')
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def triangles(parts):
    """(family, 3 вершины) по треугольникам — грани веером."""
    for p in parts:
        vs = np.asarray(p['verts'], dtype=np.float64)
        for f in p['faces']:
            for i in range(1, len(f) - 1):
                yield p['family'], vs[[f[0], f[i], f[i + 1]]]


def render(parts, view='iso', ppu=96.0, res=(512, 640), center=(0.0, 0.0, 0.0)):
    """Кадр: RGB (float), zbuf, карта «лицо/тыл» и статистика изнанок."""
    fwd, right, up = AXIS_VIEWS[view]
    w, h = res
    cx, cy, cz = center
    img = np.zeros((h, w, 3), dtype=np.float32)
    zbuf = np.full((h, w), 1e9, dtype=np.float64)
    front = np.zeros((h, w), dtype=bool)
    back_px = 0
    ys, xs = np.mgrid[0:h, 0:w]
    for family, tri in triangles(parts):
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            continue
        n = n / ln
        tone = T.tone_of(family, tuple(n))
        col = hex_rgb(T.TONES[family]['light' if tone == 0 else
                                   ('mid' if tone == 1 else 'dark')])
        p = tri - np.array([cx, cy, cz])
        d = p @ fwd                                   # глубина (больше = дальше)
        sx = (p @ right) * ppu + w / 2.0
        sy = h / 2.0 - (p @ up) * ppu
        x0, x1 = int(math.floor(sx.min())), int(math.ceil(sx.max()))
        y0, y1 = int(math.floor(sy.min())), int(math.ceil(sy.max()))
        x0, x1 = max(0, x0), min(w - 1, x1)
        y0, y1 = max(0, y0), min(h - 1, y1)
        if x1 < x0 or y1 < y0:
            continue
        ax, ay = sx[0], sy[0]
        bx, by = sx[1], sy[1]
        ccx, ccy = sx[2], sy[2]
        den = (by - ccy) * (ax - ccx) + (ccx - bx) * (ay - ccy)
        if abs(den) < 1e-12:
            continue
        sub_x = xs[y0:y1 + 1, x0:x1 + 1].astype(np.float64) + 0.5
        sub_y = ys[y0:y1 + 1, x0:x1 + 1].astype(np.float64) + 0.5
        l0 = ((by - ccy) * (sub_x - ccx) + (ccx - bx) * (sub_y - ccy)) / den
        l1 = ((ccy - ay) * (sub_x - ccx) + (ax - ccx) * (sub_y - ccy)) / den
        l2 = 1.0 - l0 - l1
        inside = (l0 >= -1e-9) & (l1 >= -1e-9) & (l2 >= -1e-9)
        if not inside.any():
            continue
        depth = l0 * d[0] + l1 * d[1] + l2 * d[2]
        sub_z = zbuf[y0:y1 + 1, x0:x1 + 1]
        hit = inside & (depth < sub_z)
        if not hit.any():
            continue
        # лицевая грань — та, чья нормаль смотрит НАВСТРЕЧУ камере
        # (fwd — это «от камеры в сцену»)
        facing = float(np.dot(n, fwd)) < 0.0
        sub_img = img[y0:y1 + 1, x0:x1 + 1]
        sub_fr = front[y0:y1 + 1, x0:x1 + 1]
        sub_img[hit] = col
        sub_z[hit] = depth[hit]
        sub_fr[hit] = facing
    covered = int((zbuf < 1e8).sum())
    back_px = int(((~front) & (zbuf < 1e8)).sum())
    return dict(img=img, zbuf=zbuf, front=front, res=res, view=view, ppu=ppu,
                back_px=back_px, covered=covered,
                back_share=(back_px / covered if covered else 0.0))


def save(frame, path, bg=(0.96, 0.96, 0.96), alpha=True):
    h, w = frame['res'][1], frame['res'][0]
    img = frame['img']
    cov = frame['zbuf'] < 1e8
    rgb = np.where(cov[..., None], img, np.array(bg, dtype=np.float32))
    a = np.where(cov, 255.0, 0.0) if alpha else np.full((h, w), 255.0)
    out = np.concatenate([rgb * 255.0, a[..., None]], axis=2).astype(np.uint8)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    Image.fromarray(out, 'RGBA').save(path)
    return path


def main():
    ap = argparse.ArgumentParser(description='свой софт-рендер кузницы')
    ap.add_argument('--variant', default='a')
    ap.add_argument('--view', default='iso', choices=sorted(AXIS_VIEWS))
    ap.add_argument('--ppu', type=float, default=96.0)
    ap.add_argument('--out', required=True)
    ap.add_argument('--center', default='0,0,0')
    args = ap.parse_args()
    parts = B.build(args.variant)
    c = tuple(float(v) for v in args.center.split(','))
    f = render(parts, args.view, args.ppu, center=c)
    save(f, args.out)
    print('%s: %s ppu=%.0f  закрыто %d px, изнанка %d px (%.3f%%)'
          % (args.out, args.view, args.ppu, f['covered'], f['back_px'],
             100.0 * f['back_share']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
