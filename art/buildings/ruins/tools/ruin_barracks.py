"""ruin_barracks.py — РАЗРУШЕННАЯ КАЗАРМА, пятно 4 x 3.

Целая модель — `art/buildings/barracks/tools/barracks.py` (тип `barracks`,
атлас `mapgen2/assets/barracks/`, вариант `a`).  Руина собрана на ЕГО цоколе:
`barracks.build_plinth(parts, Random(17))` вызывается с тем же зерном, что в
целой сборке, поэтому ряд валунов, мох и шов — те же до вершины.

ЧТО СЛОМАНО
-----------
* Щипец на -X (сторона к камере) уцелел высоко — 2.05 против 2.46 у целой
  казармы: он держит силуэт двускатной кровли.  Кромка рваная.
* Фасад (+Y, к камере) снесён до 0.78, в нём пролом на дверь; задняя и правая
  стены — 0.95..1.15 с проломами.
* Кровля упала внутрь: большой пласт соломы лёг с задней стены на пол, по нему
  видны стропила; часть досок сорвана.
* Знамя упало: каменная база на месте (она держит наземный контур, y = 1.395),
  а древко лежит, полотнище на земле.
* Стойка с копьями сломана, два щита и два копья разбросаны; мишень завалена.
* Пепел, угли, выпавшие камни — внутри пятна.

Пятно 4 x 3: x -2..2, y -1.5..1.5.  `ground` берётся из целого атласа и
сверяется с контактом модели (`tools/check_atlas.py`).
"""
import importlib.util
import math
import os
import random
import sys

import forge as F
import ruinkit as K

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


BR = _load('ruin_br_src', os.path.join(
    HERE, '..', '..', 'barracks', 'tools', 'barracks.py'))

HALF_X, HALF_Y, BCY = BR.HALF_X, BR.HALF_Y, BR.BCY
Z_PL, Z_WALL = BR.Z_PL, BR.Z_WALL
DOOR_X = BR.DOOR_X
YF = BCY + HALF_Y                    # 0.52 — фасад
YB = BCY - HALF_Y                    # -1.26 — задняя стена
BANNER = (1.62, 1.24)                # база знамени целой казармы

SPEC = dict(
    footprint=(4, 3),
    wall_x=2.0 * HALF_X,
    wall_y=2.0 * HALF_Y,
    wall_h=1.90,                     # щипец -X
    z_plinth=Z_PL,
    z_wall=Z_PL + 1.90,
    pitch_deg=None,
    over_slope=0.0,
    over_end=0.0,
    ridge_z=None,
    class_='ruin',
    canon=dict(h_b=(1.80, 2.45), wall_h=(0.60, 2.00), tris=(300, 1500),
               min_detail=0.02),
)


def build_base(parts):
    """Цоколь и база знамени — теми же вызовами, что у целой казармы."""
    BR.build_plinth(parts, random.Random(17))
    # Цоколь целой казармы шире пятна на 0.014..0.028 (дрожь камня): у неё
    # габарит 4.028 при пятне 4.00.  `canon.py` это пропускает (запас 0.03),
    # а `gate.py` C11 считает по клеткам без запаса.  Поджимаем ТОЛЬКО
    # камни цоколя на 2 мм — камень этого не замечает, а основание влезает.
    for p in parts:
        if p['name'].startswith('plinth_'):
            p['verts'] = [(max(-1.996, min(1.996, v[0])),
                           max(-1.496, min(1.496, v[1])), v[2])
                          for v in p['verts']]
    # База знамени (bx с jit/seed целой модели) даёт край наземного контура
    # y = 1.395.  Ставить её «на глаз» нельзя: ground разойдётся с целым.
    BR.bx(parts, 'banner_base', 'stone', BANNER[0] - 0.15, BANNER[0] + 0.15,
          BANNER[1] - 0.15, BANNER[1] + 0.15, 0.0, 0.13, jit=0.006, seed=1300)


# --------------------------------------------------------------------------
# СТЕНЫ
# --------------------------------------------------------------------------
def build_walls(parts):
    T = 0.16
    # ЩИПЕЦ -X: высокий, рваный, с провалом у переднего края.
    prof = [(-HALF_Y + BCY, Z_PL), (-HALF_Y + BCY + 0.02, 1.38),
            (BCY - 0.52, 1.72), (BCY - 0.26, 2.04), (BCY - 0.02, 1.66),
            (BCY + 0.22, 1.80), (BCY + 0.66, 1.30), (HALF_Y + BCY - 0.02, 1.06),
            (HALF_Y + BCY - 0.06, 0.72), (HALF_Y + BCY, Z_PL)]
    v, f = F.prism(prof, -HALF_X - 0.08, -HALF_X + 0.08, axis=0)
    K.add(parts, 'gable_wall', 'wall', (v, f), jit=0.004, seed=2200)
    K.beam(parts, 'gable_char', 'char', (-HALF_X, BCY - 0.26, 2.04),
           (-HALF_X, BCY + 0.22, 1.80), 0.075, 0.05, seed=2201, nocull=True)

    # ФАСАД +Y: низкий, с проломом на дверь (DOOR_X = -0.55).
    K.broken_wall(parts, 'wall_front', 'x', YF, -HALF_X + 0.02, HALF_X - 0.12,
                  Z_PL, 0.78, T, seed=2210,
                  holes=((DOOR_X, 0.86), (1.30, 0.34)),
                  frac=(0.94, 0.66, 0.82, 0.50, 0.74, 0.58))
    # ЗАДНЯЯ -Y: выше, с двумя проломами.
    K.broken_wall(parts, 'wall_back', 'x', YB, -HALF_X + 0.04, HALF_X - 0.12,
                  Z_PL, 1.12, T, seed=2220,
                  holes=((-0.90, 0.36), (1.10, 0.30)),
                  frac=(0.90, 0.78, 0.62, 0.86, 0.70, 0.56))
    # ПРАВАЯ +X: второй щипец, ниже западного (1.58 против 2.04).  На
    # повороте 180 камера смотрит именно сюда, и без второго щипца кадр терял
    # крупную плоскость (стиль-гейт: ДЕТАЛИЗАЦИЯ 29 % < 30 %).
    prof = [(YB, Z_PL), (YB + 0.03, 1.30), (BCY - 0.34, 1.48),
            (BCY - 0.10, 1.58), (BCY + 0.20, 1.32), (BCY + 0.58, 1.18),
            (YF - 0.03, 0.82), (YF, Z_PL)]
    v, f = F.prism(prof, HALF_X - 0.08, HALF_X + 0.08, axis=0)
    K.add(parts, 'gable_wall_east', 'wall', (v, f), jit=0.004, seed=2230)
    K.beam(parts, 'gable_char_east', 'char', (HALF_X, BCY - 0.10, 1.58),
           (HALF_X, BCY + 0.58, 1.18), 0.075, 0.05, seed=2231, nocull=True)

    # Остатки каркаса: угловые стойки и обвязка на фасаде.
    for k, (x, y, h, ch) in enumerate((
            (-HALF_X + 0.06, YF - 0.04, 1.22, False),
            (HALF_X - 0.06, YF - 0.04, 0.72, True),
            (-HALF_X + 0.06, YB + 0.04, 1.16, True))):
        K.broken_post(parts, 'post_%d' % k, x, y, Z_PL, h, 0.13,
                      seed=2240 + k, lean=(0.01 * (k - 1), 0.0), char=ch)
    K.slab(parts, 'plate_front', 'beam', -1.72, -1.10, YF - 0.02, YF + 0.09,
           0.74, 0.86, jit=0.003, seed=2250)
    K.slab(parts, 'plate_front_2', 'timber', 0.68, 1.32, YF - 0.02, YF + 0.09,
           0.70, 0.82, jit=0.003, seed=2251)

    # Дверной проём: стойки и сорванная перекладина.
    K.slab(parts, 'door_jamb_l', 'timber', DOOR_X - 0.46, DOOR_X - 0.38,
           YF + 0.04, YF + 0.12, Z_PL, 1.02, jit=0.003, seed=2260, nocull=True)
    K.slab(parts, 'door_jamb_r', 'timber', DOOR_X + 0.38, DOOR_X + 0.46,
           YF + 0.04, YF + 0.12, Z_PL, 0.86, jit=0.003, seed=2261, nocull=True)
    K.beam(parts, 'door_lintel', 'char', (DOOR_X - 0.50, YF + 0.07, 1.00),
           (DOOR_X + 0.50, YF + 0.07, 0.74), 0.11, 0.12, seed=2262)
    # Полотно двери сорвано и лежит.
    # Полотно лежит на ЗЕМЛЕ двора (z=0), а не на цоколе: цоколь идёт только
    # под стенами, и доска на 0.16 висела бы в воздухе.
    K.slab(parts, 'door_leaf', 'plank', DOOR_X - 0.34, DOOR_X + 0.34,
           YF + 0.30, YF + 0.96, 0.008, 0.043, jit=0.004, seed=2263)


# --------------------------------------------------------------------------
# КРОВЛЯ
# --------------------------------------------------------------------------
def build_roof(parts):
    """Кровля упала внутрь: пласт с задней стены на пол + стропила."""
    quad = [(-1.62, YB + 0.05, 1.20), (1.56, YB + 0.05, 1.20),
            (1.46, YB + 1.55, 0.16), (-1.52, YB + 1.55, 0.16)]
    K.roof_panel(parts, 'roof_fallen', quad, 0.09, fam='thatch', seed=2300)
    # тёс/обрешётка по скату
    for k, xc in enumerate((-1.10, -0.20, 0.70)):
        x0, x1 = xc - 0.16, xc + 0.16
        y0, y1 = YB + 0.05, YB + 1.55
        quad = [(x0, y0, 1.33), (x1, y0, 1.33), (x1, y1, 0.29), (x0, y1, 0.29)]
        K.roof_panel(parts, 'roof_board_%d' % k, quad, 0.035, fam='plank',
                     seed=2310 + k)
    # обгоревшая кромка
    K.beam(parts, 'roof_char', 'char', (-1.52, YB + 1.55, 0.20),
           (1.46, YB + 1.55, 0.20), 0.07, 0.06, seed=2320, nocull=True)
    # Стропила: два ещё держатся на щипце, два лежат.
    for k, (x0, x1, y1) in enumerate(((-1.80, -1.30, YB + 0.90),
                                       (-1.80, -1.42, YB + 1.30))):
        K.beam(parts, 'rafter_%d' % k, 'char', (x0, BCY, 1.70),
               (x1, y1, Z_PL + 0.02), 0.06, 0.07, seed=2330 + k, nocull=True)
    K.fallen_beam(parts, 'rafter_ground_0', (-0.80, 0.90), (0.40, 1.20),
                  0.055, seed=2332, fam='beam')
    K.fallen_beam(parts, 'rafter_ground_1', (0.20, -0.90), (1.30, -0.60),
                  0.05, seed=2333, fam='char')


# --------------------------------------------------------------------------
# ПЛАЦ: упавшее знамя, сломанная стойка, щиты, копья
# --------------------------------------------------------------------------
def build_yard(parts):
    # Знамя упало от своей базы: древко лежит, полотнище — на земле.
    K.fallen_beam(parts, 'banner_pole_fallen', (1.58, 1.18), (0.30, 0.86),
                  0.075, seed=2400, fam='timber', nocull=True)
    quad = [(1.30, 0.74, 0.03), (0.42, 0.98, 0.03),
            (0.32, 0.74, 0.03), (1.22, 0.52, 0.03)]
    K.roof_panel(parts, 'banner_cloth_fallen', quad, 0.025, fam='wall',
                 seed=2401)
    K.beam(parts, 'banner_cross_fallen', 'timber', (1.24, 0.62, 0.06),
           (1.22, 1.00, 0.06), 0.06, 0.05, seed=2402, nocull=True)
    # Сломанная стойка с копьями: одна стойка стоит, вторая упала.
    K.broken_post(parts, 'rack_post_0', 0.26, 1.04, 0.0, 0.62, 0.11,
                  seed=2410, char=True)
    K.fallen_beam(parts, 'rack_post_fallen', (0.90, 1.04), (0.90, 0.20),
                  0.10, seed=2411, fam='timber')
    K.fallen_beam(parts, 'rack_bar', (0.10, 0.86), (1.20, 0.92), 0.08,
                  seed=2412, fam='char')
    # Копья на земле и щиты — часть лицом вверх, часть на ребре.
    for k, (x0, y0, x1, y1) in enumerate(((0.20, 0.60, 1.36, 0.44),
                                           (0.10, 0.28, 1.22, 0.62))):
        K.fallen_beam(parts, 'spear_%d' % k, (x0, y0), (x1, y1), 0.045,
                      seed=2420 + k, fam='plank')
        K.shingle(parts, 'spear_head_%d' % k, x1, y1, 0.10, 0.20, 18.0,
                  2425 + k, fam='iron', z=0.03, thick=0.03, tilt=0.0)
    for k, (x, y, r, fam) in enumerate(((0.66, 0.72, 0.22, 'thatch'),
                                         (1.02, 0.28, 0.20, 'thatch'),
                                         (1.30, 0.90, 0.18, 'timber'))):
        v, f = F.prism(F.ngon(0.0, 0.0, r, 8, phase=math.pi / 8.0),
                       0.0, 0.035, 2)
        v = [(p[0] + x, p[1] + y, p[2] + 0.02) for p in v]
        K.add(parts, 'shield_%d' % k, fam, (v, f), jit=0.002,
              seed=2430 + k, nocull=True)
        K.stone(parts, 'shield_boss_%d' % k, 'iron', x, y, 0.055, r * 0.26,
                r * 0.30, 2440 + k, n=6)
    # Мишень завалилась.
    K.fallen_beam(parts, 'target_leg', (-1.86, 0.78), (-1.40, 1.12), 0.06,
                  seed=2450, fam='timber')
    K.shingle(parts, 'target_butt', -1.62, 1.06, 0.34, 0.34, 24.0, 2451,
              fam='thatch', z=0.02, thick=0.06, tilt=0.0)
    # Пепел, угли, выпавшие камни.
    K.ash_patch(parts, 'ash_plats', -0.15, 0.35, 0.80, 0.50, 2460)
    K.ash_patch(parts, 'ash_door', DOOR_X, 1.05, 0.36, 0.22, 2461)
    K.char_pile(parts, 'char_pile_0', 0.55, -0.30, 0.20, 2462, n=4)
    K.rubble(parts, 'rubble_0', -1.60, -0.60, 0.18, 2463, fam='stone')
    K.rubble(parts, 'rubble_1', 1.55, 0.10, 0.16, 2464, fam='stone2')


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None):
    parts = []
    build_base(parts)
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
