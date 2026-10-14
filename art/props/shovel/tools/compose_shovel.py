"""Пост-обработка рендеров лопаты: контур, контактная тень, обрезка, 1x и 4x.

    python3 tools/compose_shovel.py [--variants a,b,c] [--rotations 0,90,180,270]

Читает renders/shovel_<вар>_<поворот>_raw.png, пишет
    out/shovel_<вар>_<поворот>@4x.png   384 px на юнит (кадр рендера как есть)
    out/shovel_<вар>_<поворот>.png       96 px на юнит — родной масштаб атласа
и два списка кадров: out/shovel_sprites@4x.json и out/shovel_sprites.json.

Контур — из townhall/tools/compose.py, общий для всей игры: 2 px на 96 ppu
(у топора столько же), цвет #0E130E.

Тень здесь СВОЯ, а не townhall/geom.shadow_for, и это осознанно. У ратуши и
топора пятно рисуется проекцией эллипса на землю, а проекция любого наземного
пятна в изометрии даёт bbox с h/w = 0.577 — вдвое площе канона не бывает.
В атласе пятна плоские (h/w 0.045..0.263 по references/measurements.md), поэтому
эллипс задаётся СРАЗУ В ЭКРАННЫХ ПИКСЕЛЯХ и растянут вдоль кромки штыка:
лопата стоит на земле кромкой, и её контактная тень — полоса вдоль кромки.

Параметры тени выведены на флаги (--sh-*), потому что они подбираются замером:
`python3 <скилл>/scripts/measure.py --png out/shovel_a_0.png --anchor X,Y`.
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

# Кадр рендера: тот же, что в build_shovel.py.
RES_X, RES_Y = 512, 640
PPU = 384.0
ORTHO = RES_Y / PPU
SCALE = PPU / 96.0                 # во сколько раз кадр плотнее атласа (4x)

# --- тень: параметры в пикселях ПРИ 96 ppu (в кадре умножаются на SCALE) ---
# Лопата стоит на кромке штыка: кромка идёт по Y, на экране это диагональ
# влево-вверх (азимут -30°), вдоль неё и вытянуто пятно. Числа не на глаз:
# прогон сетки 4x4x3x2x2x3 = 576 наборов на четырёх поворотах, из них 450
# попадают в канон (ширина/силуэт 0.7..2.0, h/w 0.04..0.40, пик α 0.25..0.9,
# p90 α 0.08..0.7); выбран ближайший к ядру канона — ширина/силуэт 0.95,
# h/w 0.25, пик α 0.33, p90 α 0.25 (у эталонных деревьев 0.89..0.98 / 0.12..0.20 /
# 0.30..0.78 / ~0.15). Меньшая альфа или тонкое пятно не читаются: под нижним
# углом кромки видно лишь «усы», и гейт честно пишет FAIL «пятна нет».
SHADOW = dict(
    a=9.0,          # большая полуось, px при 96 ppu (вдоль кромки)
    b=4.6,          # малая полуось, px (толщина полосы)
    angle=-30.0,    # наклон большой оси на экране, градусы (вдоль кромки по Y)
    alpha=0.55,     # пик альфы пятна ДО размытия (порог гейта 0.25..0.9)
    blur=0.026,     # размытие в юнитах: 0.026 * 96 = 2.5 px при 96 ppu
    shift=(4.0, 2.0),   # сдвиг пятна на экране, px при 96 ppu (вправо-вниз)
)

NOTE = ('1 юнит модели = 1 клетка карты; лопата 0.62 юнита в высоту, кадр 0 — '
        'штык влево-вниз, опора — режущая кромка на земле')

CHECK = PAL.check_table()


def setup_geom(sh=None):
    sh = sh or SHADOW
    geom.RES_X, geom.RES_Y = RES_X, RES_Y
    geom.ORTHO = ORTHO
    geom.PPU = PPU
    # Контур атласа толстый (у валунов ~4 px на 96 ppu), но рукоять лопаты
    # тонкая (0.04 юнита = 4 px): берём 2 px, как у топора.
    geom.OUTLINE_DILATE = max(1, int(round(2.0 * PPU / 96.0)))
    geom.SHADOW_ALPHA = sh['alpha']
    geom.SHADOW_SHIFT_PX = (sh['shift'][0] * SCALE, sh['shift'][1] * SCALE)


def shadows(sh=None):
    """Пятно в ЭКРАННЫХ пикселях: compose перезапишет только центр (по сдвигу)."""
    sh = sh or SHADOW
    cx, cy = geom.project(0.0, 0.0, 0.0)
    return [dict(cx=cx, cy=cy, a=sh['a'] * SCALE, b=sh['b'] * SCALE,
                 angle_deg=sh['angle'], blur=sh['blur'])]


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
    ap.add_argument('--sh-a', type=float, default=SHADOW['a'])
    ap.add_argument('--sh-b', type=float, default=SHADOW['b'])
    ap.add_argument('--sh-angle', type=float, default=SHADOW['angle'])
    ap.add_argument('--sh-alpha', type=float, default=SHADOW['alpha'])
    ap.add_argument('--sh-blur', type=float, default=SHADOW['blur'])
    ap.add_argument('--sh-shift', default='%g,%g' % SHADOW['shift'])
    args = ap.parse_args()

    sh = dict(a=args.sh_a, b=args.sh_b, angle=args.sh_angle, alpha=args.sh_alpha,
              blur=args.sh_blur,
              shift=tuple(float(v) for v in args.sh_shift.split(',')))
    setup_geom(sh)
    os.makedirs(OUT, exist_ok=True)

    def load(path):
        try:
            return json.load(open(path)).get('frames', {})
        except Exception:
            return {}

    big = load(os.path.join(OUT, 'shovel_sprites@4x.json'))
    small = load(os.path.join(OUT, 'shovel_sprites.json'))
    for var in args.variants.split(','):
        for rot in [int(r) for r in args.rotations.split(',')]:
            raw = os.path.join(RENDERS, 'shovel_%s_%d_raw.png' % (var, rot))
            if not os.path.exists(raw):
                print('НЕТ РЕНДЕРА: %s' % raw)
                continue
            key = 'shovel_%s_%d' % (var, rot)
            dst4 = os.path.join(OUT, key + '@4x.png')
            img4, ax4, ay4 = compose.compose(
                raw, [] if args.no_shadow else shadows(sh),
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

    with open(os.path.join(OUT, 'shovel_sprites@4x.json'), 'w') as f:
        json.dump(dict(ppu=PPU, ortho=ORTHO, res=[RES_X, RES_Y], note=NOTE,
                       shadow=sh, frames=big), f, ensure_ascii=False, indent=1)
    with open(os.path.join(OUT, 'shovel_sprites.json'), 'w') as f:
        json.dump(dict(ppu=96.0, ortho=ORTHO, res=[RES_X, RES_Y], note=NOTE,
                       shadow=sh, frames=small), f, ensure_ascii=False, indent=1)
    print('shovel_sprites.json и shovel_sprites@4x.json записаны')


if __name__ == '__main__':
    main()
