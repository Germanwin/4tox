"""ruin_townhall.py — РАЗРУШЕННАЯ РАТУША, пятно 4 x 3.

Целая ратуша — `art/buildings/townhall/tools/townhall.py` (тип `townhall`,
атлас `mapgen2/assets/townhall/`, вариант `a`).  Её геометрия собрана на
`bmesh` и объектах Blender, а не списком деталей, поэтому переиспользовать
функции нельзя; переиспользуются ЧИСЛА и КРАСКИ оттуда: оси стен 3.70 x 2.70,
высота стены 1.55, конёк 2.82, цоколь из валунов с мхом, звонница на коньке и
палитра `thpal.py` -> `ruin_palette.py` (дословно).

Целая ратуша: скаты падают по ±Y, конёк идёт по X, щипцы — на торцах ±X.
Камера видит -X и +Y, поэтому главный уцелевший щипец — на -X (2.10 против
2.82 у целой), а фасад +Y снесён до 0.85 с проломом на дверь.

Колокол звонницы сорван и лежит на полу — по нему ратуша и узнаётся, когда
кровли уже нет.

Пятно 4 x 3: x -2..2, y -1.5..1.5.  `ground` берётся из целого атласа (он
посчитан по пикселям кадра и асимметричен: -1.805..2.245 по X карты).  Наш
цоколь симметричен, поэтому ВИДИМОЕ основание стоит на 0.2..0.3 клетки не там,
где у целой ратуши; это записано в README как известное расхождение, а
`anchorX/anchorY`, `ground` и `mul` совпадают с целым атласом точно.
"""
import math
import os
import random
import sys

import forge as F
import ruinkit as K

HERE = os.path.dirname(os.path.abspath(__file__))

# Числа целой ратуши (townhall/tools/townhall.py), дословно.
HALF_X, HALF_Y = 1.85, 1.35
WALL_H = 1.55
RIDGE_Z = 2.82

SPEC = dict(
    footprint=(4, 3),
    wall_x=2.0 * HALF_X,
    wall_y=2.0 * HALF_Y,
    wall_h=1.90,
    z_plinth=0.03,
    z_wall=1.93,
    pitch_deg=None,
    over_slope=0.0,
    over_end=0.0,
    ridge_z=None,
    class_='ruin',
    canon=dict(h_b=(1.85, 2.45), wall_h=(0.60, 2.00), tris=(300, 1500),
               min_detail=0.02),
)

FLOOR = 0.032          # верх плиты цоколя: всё внутри лежит на нём
STONE_TOP = 0.05


# --------------------------------------------------------------------------
# ЦОКОЛЬ
# --------------------------------------------------------------------------
def build_plinth(parts):
    """Ряд валунов по периметру 4 x 3 + плита + мох: приём и числа целой
    ратуши (`build_plinth` в townhall.py), но списком деталей.

    Плита утоплена: стены стоят на ней, а снаружи виден ряд камня.  Мох —
    пятнами, как у целой, и только на верхней полке.
    """
    rng = random.Random(31)
    # плита-полка: по ней стоят стены, её видно в проломах как пол
    # Плита приподнята на 4 мм: её низ не ложится в одну плоскость с низом
    # валунов (xray видел пару «совпадающих плоскостей» на z=0).  Снизу щель
    # 4 мм не видна, а контакт с землёй дают валуны.
    K.slab(parts, 'plinth_top', 'stone2', -1.92, 1.92, -1.42, 1.42, 0.004,
           FLOOR, jit=0.004, seed=3)
    for p in parts:
        if p['name'] == 'plinth_top':
            p['nocull'] = True
    # внешний ряд валунов: 4 вдоль длинных сторон, 3 вдоль торцов
    xs = (-1.80, -0.90, 0.02, 0.94, 1.82)
    for i in range(len(xs) - 1):
        cx = (xs[i] + xs[i + 1]) / 2.0 + rng.uniform(-0.05, 0.05)
        for cy in (-1.40, 1.40):
            # ВАЛУН ВЫТЯНУТ ВДОЛЬ СТЕНЫ (0.9 x 0.28), как у целой ратуши:
            # круглый камень радиусом 0.28 вылезал за пятно на y = 1.65.
            K.slab(parts, 'plinth_x_%d_%d' % (i, int(cy)),
                   'stone' if (i + int(cy)) % 2 else 'stone2',
                   cx - 0.44, cx + 0.44, cy - 0.09, cy + 0.09, 0.0, 0.20,
                   jit=0.006, seed=300 + i * 3 + int(cy))
    for j, cy in enumerate((-0.95, 0.0, 0.95)):
        for cx in (-1.80, 1.80):
            K.stone(parts, 'plinth_y_%d_%d' % (j, int(cx)),
                    'stone2' if j % 2 else 'stone',
                    cx, cy, 0.0, 0.18, 0.19, 400 + j * 5 + int(cx), n=5)
    # мох на полке — пятнами
    for k, (cx, cy) in enumerate(((-1.60, 1.30), (-0.55, 1.30),
                                   (1.55, 1.30), (-1.60, -1.30))):
        K.slab(parts, 'moss_%d' % k, 'moss', cx - 0.14, cx + 0.14,
               cy - 0.06, cy + 0.06, FLOOR - 0.01, FLOOR + 0.035,
               jit=0.004, seed=500 + k)
    # горелый пол ратуши — один крупный фасет, как у дома
    poly = [(-1.66, -1.30), (1.60, -1.30), (1.62, -0.30), (1.58, 0.50),
            (1.62, 1.30), (-1.62, 1.30), (-1.64, 0.30), (-1.58, -0.50)]
    v, f = F.prism(poly, FLOOR + 0.004, FLOOR + 0.012, axis=2)
    K.add(parts, 'burnt_floor', 'ash', (v, f))
    K.ash_patch(parts, 'ash_hall', 0.30, 0.10, 0.70, 0.55, 510,
                z=FLOOR + 0.010)


# --------------------------------------------------------------------------
# СТЕНЫ
# --------------------------------------------------------------------------
def build_walls(parts):
    T = 0.18
    Z0 = FLOOR + 0.005
    # ЩИПЕЦ -X: главный, 2.10 против 2.82 у целой ратуши.
    prof = [(-HALF_Y, Z0), (-HALF_Y + 0.03, 1.44), (-0.30, 1.74),
            (-0.05, 2.10), (0.20, 1.66), (0.55, 1.80), (HALF_Y - 0.05, 1.30),
            (HALF_Y, Z0)]
    v, f = F.prism(prof, -HALF_X - 0.09, -HALF_X + 0.09, axis=0)
    K.add(parts, 'gable_wall', 'wall', (v, f), jit=0.004, seed=600)
    K.beam(parts, 'gable_char', 'char', (-HALF_X, -0.05, 2.10),
           (-HALF_X, 0.55, 1.80), 0.08, 0.05, seed=601, nocull=True)

    # ФАСАД +Y: низкий, с проломом на дверь.
    K.broken_wall(parts, 'wall_front', 'x', HALF_Y, -HALF_X + 0.03,
                  HALF_X - 0.04, Z0, 0.85, T, seed=610,
                  holes=((-0.45, 0.90), (1.15, 0.40)),
                  frac=(0.94, 0.64, 0.84, 0.52, 0.76, 0.58))
    # ЗАДНЯЯ -Y и ПРАВАЯ +X: ниже, с проломами.
    K.broken_wall(parts, 'wall_back', 'x', -HALF_Y, -HALF_X + 0.04,
                  HALF_X - 0.02, Z0, 1.14, T, seed=620,
                  holes=((0.95, 0.36), (-1.10, 0.30)),
                  frac=(0.90, 0.74, 0.60, 0.86, 0.66, 0.54))
    K.broken_wall(parts, 'wall_right', 'y', HALF_X, -HALF_Y + 0.02,
                  HALF_Y - 0.04, Z0, 0.95, T, seed=630,
                  holes=((-0.40, 0.36),), frac=(0.86, 0.60, 0.76, 0.48, 0.68))

    # Каркас по фасаду: стойки, подкос, обвязка.
    for k, (x, h, ch) in enumerate(((-1.78, 1.24, False),
                                     (1.78, 0.76, True))):
        K.broken_post(parts, 'post_%d' % k, x, HALF_Y - 0.05, Z0, h, 0.14,
                      seed=640 + k, lean=(0.01, 0.0), char=ch)
    K.slab(parts, 'plate_left', 'beam', -1.82, -1.10, HALF_Y - 0.04,
           HALF_Y + 0.08, 0.80, 0.92, jit=0.003, seed=642)
    K.beam(parts, 'brace', 'timber', (-1.76, HALF_Y - 0.07, 0.10),
           (-0.55, HALF_Y - 0.07, 0.86), 0.10, 0.09, seed=643)

    # Дверной проём: арка сорвана, стойки стоят; полотно упало.
    K.slab(parts, 'door_jamb_l', 'timber', -0.48, -0.38, HALF_Y + 0.085,
           HALF_Y + 0.135, Z0, 1.02, jit=0.003, seed=650, nocull=True)
    K.slab(parts, 'door_jamb_r', 'timber', 0.38, 0.48, HALF_Y + 0.085,
           HALF_Y + 0.135, Z0, 0.88, jit=0.003, seed=651, nocull=True)
    K.beam(parts, 'door_lintel', 'char', (-0.54, HALF_Y + 0.11, 1.00),
           (0.54, HALF_Y + 0.11, 0.76), 0.12, 0.13, seed=652)
    K.slab(parts, 'door_leaf', 'plank', -0.36, 0.36, 1.00, 1.44,
           0.010, 0.048, jit=0.004, seed=653)


# --------------------------------------------------------------------------
# КРОВЛЯ И КОЛОКОЛ
# --------------------------------------------------------------------------
def build_roof(parts):
    Z0 = FLOOR + 0.005
    # Кровля упала внутрь: пласт с задней стены на пол.
    quad = [(-1.70, -1.30, 1.15), (1.64, -1.30, 1.15),
            (1.56, -0.10, 0.12), (-1.62, -0.10, 0.12)]
    K.roof_panel(parts, 'roof_fallen', quad, 0.10, fam='thatch', seed=700)
    for k, xc in enumerate((-1.05, -0.20, 0.65)):
        x0, x1 = xc - 0.18, xc + 0.18
        quad = [(x0, -1.30, 1.22), (x1, -1.30, 1.22),
                (x1, -0.10, 0.19), (x0, -0.10, 0.19)]
        K.roof_panel(parts, 'roof_board_%d' % k, quad, 0.04, fam='plank',
                     seed=710 + k)
    K.beam(parts, 'roof_char', 'char', (-1.62, -0.10, 0.16),
           (1.56, -0.10, 0.16), 0.08, 0.06, seed=720, nocull=True)
    # стропила: два на щипце, два на полу
    for k, (x0, x1, y1) in enumerate(((-1.86, -1.20, -0.30),
                                       (-1.86, -1.40, 0.30))):
        K.beam(parts, 'rafter_%d' % k, 'char', (x0, -0.30, 1.74),
               (x1, y1, Z0 + 0.02), 0.065, 0.075, seed=730 + k, nocull=True)
    K.fallen_beam(parts, 'rafter_ground_0', (-0.70, 0.55), (0.50, 0.92),
                  0.06, seed=732, fam='beam')
    K.fallen_beam(parts, 'rafter_ground_1', (0.20, -0.85), (1.40, -0.55),
                  0.055, seed=733, fam='char')

    # КОЛОКОЛ звонницы сорван и лежит на полу у входа: конус + язык.
    bx, by = 0.55, 0.75
    v, f = F.prism(F.ngon(0.0, 0.0, 0.20, 8, phase=math.pi / 8.0),
                   0.0, 0.24, 2)
    v = [(p[0] + bx, p[1] + by, p[2] + 0.06) for p in v]
    K.add(parts, 'bell_fallen', 'iron', (v, f), jit=0.003, seed=740)
    K.stone(parts, 'bell_clapper', 'iron', bx + 0.02, by - 0.02, 0.06, 0.05,
            0.05, 741, n=5)
    # обломок звонницы: два бруса крест-накрест
    K.fallen_beam(parts, 'cote_beam_0', (0.20, 0.45), (0.90, 0.95), 0.09,
                  seed=742, fam='char')
    K.fallen_beam(parts, 'cote_beam_1', (0.30, 0.95), (0.85, 0.50), 0.08,
                  seed=743, fam='timber')


# --------------------------------------------------------------------------
# ДВОР
# --------------------------------------------------------------------------
def build_yard(parts):
    # булыжники у входа — на своих местах (целая ратуша держит их у +Y)
    for k, (x, y, r, fam) in enumerate(((-1.55, 1.36, 0.17, 'stone'),
                                         (1.40, 1.30, 0.13, 'stone2'))):
        K.stone(parts, 'yard_stone_%d' % k, fam, x, y, 0.0, r, r * 0.7,
                750 + k, n=5)
    # кадка и поленница были у целой ратуши; после пожара — угли и клёпки
    for k, (x, y, ang) in enumerate(((-1.05, 1.05, 20.0), (-0.85, 1.25, -30.0))):
        K.fallen_plank(parts, 'barrel_stave_%d' % k, x, y, 0.34, 0.09, ang,
                       760 + k, fam='char', z=0.01, thick=0.03)
    K.char_pile(parts, 'char_pile_0', 0.90, 0.60, 0.20, 770, n=4)
    K.char_pile(parts, 'char_pile_1', -1.20, 0.30, 0.16, 771, n=3)
    K.rubble(parts, 'rubble_0', 1.60, 0.10, 0.18, 780, fam='stone')
    K.rubble(parts, 'rubble_1', -1.55, -0.40, 0.15, 781, fam='stone2')


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None):
    parts = []
    build_plinth(parts)
    build_walls(parts)
    build_roof(parts)
    build_yard(parts)
    K.finish(parts)
    return parts


if __name__ == '__main__':
    p = build()
    print(F.stats(p))
    for k, v in F.census(p).most_common(14):
        print('  %-18s %4d трис' % (k, v))
    b = K.footprint_parts(p)
    print('габарит x %.2f..%.2f  y %.2f..%.2f  z %.2f..%.2f'
          % (b[0], b[1], b[2], b[3], b[4], b[5]))
    print('контакт', K.contact(p))
