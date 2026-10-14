"""Пост-обработка рендеров топора: контур, контактная тень, обрезка, 1x и 4x.

    python3 tools/compose_axe.py [--variants a,b,c] [--rotations 0,90,180,270]

Читает renders/axe_<вар>_<поворот>_raw.png, пишет
    out/axe_<вар>_<поворот>@4x.png   384 px на юнит (кадр рендера как есть)
    out/axe_<вар>_<поворот>.png       96 px на юнит — родной масштаб атласа
и два списка кадров: out/axe_sprites@4x.json и out/axe_sprites.json.

Контур и тень — из townhall/tools/compose.py (общие для всей игры). Толщина
контура задана в пикселях эталона (1 px на 104.9 ppu) и пересчитана на 384 ppu.
"""
import argparse
import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
# контур и тень — общие с ратушей и хижиной, берём их модули как есть
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))
import geom
import compose
import palette as PAL

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

# Кадр рендера: тот же, что в build_axe.py.
RES_X, RES_Y = 512, 640
PPU = 384.0
ORTHO = RES_Y / PPU
SCALE = PPU / 96.0                 # во сколько раз кадр плотнее атласа (4x)

# Пятно топора: узкое под комлем, чуть вытянуто вперёд — под лезвие.
SHADOW_RX, SHADOW_RY = 0.062, 0.100
SHADOW_CY = 0.012

NOTE = ('1 юнит модели = 1 клетка карты; топор ~0.5 юнита в высоту, '
        'кадр 0 — лезвие влево-вперёд, опора — комель на земле')

# Цели палитры эталона — для сверки тонов по рендеру (tools/palette.py).
CHECK = PAL.check_table()


def setup_geom():
    geom.RES_X, geom.RES_Y = RES_X, RES_Y
    geom.ORTHO = ORTHO
    geom.PPU = PPU
    # Контур: у ратуши и хижины кольцо 1 px на 104.9 ppu (geom.OUTLINE_DILATE).
    # Кадр топора плотнее во столько же раз — кольцо той же толщины в юнитах.
    # Контур атласа — толстый: у валунов ~4 px на 96 ppu. Тонкую рукоять
    # такой контур съел бы целиком, поэтому берём половину веса эталона:
    # 2 px на 96 ppu (у ратуши и хижины — 1 px, там детали крупнее).
    geom.OUTLINE_DILATE = max(1, int(round(2.0 * PPU / 96.0)))
    # Сдвиг пятна: у эталона тень уходит вниз-вправо от силуэта.
    geom.SHADOW_SHIFT_PX = (2.0 * SCALE, 7.0 * SCALE)


def shadows():
    return [geom.shadow_for(0.0, SHADOW_CY, SHADOW_RX, SHADOW_RY, blur=0.10)]


def top_colors(path, n=8):
    im = Image.open(path).convert('RGBA')
    a = np.array(im).astype(int)
    m = a[:, :, 3] > 200
    px = a[:, :, :3][m]
    c = Counter(map(tuple, px))
    return [(col, 100.0 * k / max(1, len(px))) for col, k in c.most_common(n)]


def nearest_target(rgb):
    best, bd = None, 1e9
    for name, t in CHECK.items():
        d = sum((int(rgb[i]) - t[i]) ** 2 for i in range(3))
        if d < bd:
            best, bd = name, d
    return best, bd ** 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants', default='a,b,c')
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--no-outline', action='store_true')
    ap.add_argument('--no-shadow', action='store_true')
    ap.add_argument('--quiet-colors', action='store_true')
    args = ap.parse_args()

    setup_geom()
    os.makedirs(OUT, exist_ok=True)

    # не терять ранее собранные кадры: дополняем существующие списки
    def load(path):
        try:
            return json.load(open(path)).get('frames', {})
        except Exception:
            return {}

    big = load(os.path.join(OUT, 'axe_sprites@4x.json'))    # кадры @4x
    small = load(os.path.join(OUT, 'axe_sprites.json'))     # кадры 1x
    for var in args.variants.split(','):
        for rot in [int(r) for r in args.rotations.split(',')]:
            raw = os.path.join(RENDERS, 'axe_%s_%d_raw.png' % (var, rot))
            if not os.path.exists(raw):
                print('НЕТ РЕНДЕРА: %s' % raw)
                continue
            key = 'axe_%s_%d' % (var, rot)
            dst4 = os.path.join(OUT, key + '@4x.png')
            img4, ax4, ay4 = compose.compose(
                raw, [] if args.no_shadow else shadows(),
                outline=not args.no_outline, save_path=dst4)

            img1 = img4.resize((max(1, img4.width // 4), max(1, img4.height // 4)),
                               Image.LANCZOS)
            dst1 = os.path.join(OUT, key + '.png')
            img1.save(dst1)
            ax1, ay1 = ax4 / 4.0, ay4 / 4.0

            big[key] = dict(file=os.path.basename(dst4), w=img4.width, h=img4.height,
                            anchorX=round(ax4, 2), anchorY=round(ay4, 2),
                            variant=var, rotation=rot, ppu=PPU)
            small[key] = dict(file=os.path.basename(dst1), w=img1.width, h=img1.height,
                              anchorX=round(ax1, 2), anchorY=round(ay1, 2),
                              variant=var, rotation=rot, ppu=96.0)
            print('COMPOSED %s  4x %dx%d  1x %dx%d  опора=(%.1f,%.1f)' % (
                key, img4.width, img4.height, img1.width, img1.height, ax1, ay1))

            if not args.quiet_colors:
                print('   тона 4x (сверка с палитрой эталона):')
                for col, pct in top_colors(dst4, 6):
                    name, dist = nearest_target(col)
                    print('     #%02X%02X%02X %5.1f%%  ближе всего к %-9s (Δ%.0f)'
                          % (col[0], col[1], col[2], pct, name, dist))

    with open(os.path.join(OUT, 'axe_sprites@4x.json'), 'w') as f:
        json.dump(dict(ppu=PPU, ortho=ORTHO, res=[RES_X, RES_Y], note=NOTE,
                       frames=big), f, ensure_ascii=False, indent=1)
    with open(os.path.join(OUT, 'axe_sprites.json'), 'w') as f:
        json.dump(dict(ppu=96.0, ortho=ORTHO, res=[RES_X, RES_Y], note=NOTE,
                       frames=small), f, ensure_ascii=False, indent=1)
    print('axe_sprites.json и axe_sprites@4x.json записаны')


if __name__ == '__main__':
    main()
