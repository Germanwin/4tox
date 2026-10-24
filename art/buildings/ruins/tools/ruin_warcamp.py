"""ruin_warcamp.py — РАЗРУШЕННЫЙ ВОЕННЫЙ ЛАГЕРЬ, площадка 5 x 5, модель 2 x 2.

Целая модель — `art/buildings/warcamp/tools/warcamp.py` (тип `warcamp`, атлас
`mapgen2/assets/warcamp/`).  У лагеря нет стен и кровли: это точка сбора
дружины — знамя, стойка с копьями и щитами, костёр с котлом, припас.  Поэтому
руина лагеря — не «дом без крыши», а РАЗБИТЫЙ БИВАК:

* площадка-«пятак» на месте (её 12-угольник задаёт ground 2.5084 x 2.5084);
* знамя УПАЛО: столб лежит через площадку, полотнище — на земле, навершие
  откатилось;
* стойка сломана: одна стойка торчит, перекладина лежит;
* щиты и копья разбросаны по площадке, частью обгорели;
* костёр залит и разметан: камни очага на месте, тренога упала, котёл лежит на
  боку, угли и пепел;
* сгоревшие брёвна — чёрные, с обугленными торцами.

Модель остаётся 2 x 2 по центру площадки: остальные клетки в игре — место для
воинов, и руина их не занимает.  Пятно 5 x 5 и `ground` — из целого атласа.

Собрано поверх `warcamp.build_ground`: площадка, её камни и трава — те же, что
у целой модели (иначе `ground` разойдётся).
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


WC = _load('ruin_wc_src', os.path.join(
    HERE, '..', '..', 'warcamp', 'tools', 'warcamp.py'))
HALF = WC.HALF                       # 1.2542 — половина модели 2 x 2
BASE_Z = WC.BASE_Z                   # 0.047 — верх площадки
BANNER = WC.BANNER                   # (-0.50, -0.55)

SPEC = dict(
    footprint=(round(2.0 * HALF, 3), round(2.0 * HALF, 3)),
    site=(5, 5),
    wall_x=2.0 * HALF,
    wall_y=2.0 * HALF,
    wall_h=1.05,
    z_plinth=WC.PATCH_Z,
    z_wall=1.05,
    pitch_deg=None,
    over_slope=0.0,
    over_end=0.0,
    ridge_z=None,
    class_='ruin',
    canon=dict(h_b=(0.55, 1.30), wall_h=(0.35, 1.10), tris=(300, 1500),
               min_detail=0.02),
)


# --------------------------------------------------------------------------
# ЗНАМЯ: УПАЛО
# --------------------------------------------------------------------------
def build_banner(parts):
    bx, by = BANNER
    # каменное основание на месте (по нему лагерь и узнаётся)
    v, f = F.box(bx, by, BASE_Z, 0.40, 0.38, 0.115, rz=math.radians(8.0))
    K.add(parts, 'banner_base', 'stone2', (v, f), jit=0.004, seed=3300)
    # столб лежит через площадку: от основания к +X/+Y
    p0 = (bx, by, BASE_Z + 0.05)
    p1 = (bx + 1.32, by + 0.58, BASE_Z + 0.045)
    K.beam(parts, 'banner_pole', 'timber', p0, p1, 0.085, 0.085, seed=3310,
           nocull=True)
    # полотнище упало и легло на землю (видно на всех четырёх поворотах)
    quad = [(bx + 0.62, by + 0.10, BASE_Z + 0.012),
            (bx + 1.30, by + 0.42, BASE_Z + 0.012),
            (bx + 1.12, by + 0.84, BASE_Z + 0.012),
            (bx + 0.46, by + 0.52, BASE_Z + 0.012)]
    K.roof_panel(parts, 'banner_cloth', quad, 0.022, fam='thatch', seed=3320)
    # эмблема на полотнище — тёмный ромб, лежит поверх
    poly = [(bx + 0.86, by + 0.28), (bx + 0.98, by + 0.42),
            (bx + 0.86, by + 0.56), (bx + 0.74, by + 0.42)]
    v, f = F.prism(poly, BASE_Z + 0.012, BASE_Z + 0.030, axis=2)
    K.add(parts, 'banner_emblem', 'timber', (v, f))
    # навершие откатилось
    K.stone(parts, 'banner_finial', 'iron', bx + 1.18, by + 0.10,
            BASE_Z, 0.05, 0.09, 3330, n=5)
    # перекладина лежит поперёк древка
    K.fallen_beam(parts, 'banner_crossbar', (bx + 0.20, by + 0.08),
                  (bx + 0.72, by + 0.92), 0.06, seed=3340, fam='beam',
                  z0=BASE_Z)


# --------------------------------------------------------------------------
# СТОЙКА, ЩИТЫ, КОПЬЯ
# --------------------------------------------------------------------------
def build_arms(parts):
    # одна стойка торчит, вторая сломана; перекладина сорвана
    K.broken_post(parts, 'rack_post_0', 0.32, -0.58, BASE_Z, 0.62, 0.09,
                  seed=3400, char=True)
    K.fallen_beam(parts, 'rack_post_fallen', (1.02, -0.58), (1.06, 0.06),
                  0.08, seed=3401, fam='timber', z0=BASE_Z)
    K.fallen_beam(parts, 'rack_bar', (0.30, -0.34), (1.04, -0.20), 0.06,
                  seed=3402, fam='beam', z0=BASE_Z)
    # щиты: два плашмя, один на ребре (прислонён к стойке)
    for k, (x, y, r, fam, z) in enumerate(((0.54, -0.22, 0.21, 'thatch', 0.02),
                                            (0.94, -0.44, 0.19, 'thatch', 0.02),
                                            (0.68, -0.70, 0.18, 'timber', 0.02))):
        v, f = F.prism(F.ngon(0.0, 0.0, r, 8, phase=math.pi / 8.0),
                       0.0, 0.035, 2)
        v = [(p[0] + x, p[1] + y, p[2] + BASE_Z + z) for p in v]
        K.add(parts, 'shield_%d' % k, fam, (v, f), jit=0.002,
              seed=3410 + k, nocull=True)
        K.stone(parts, 'shield_boss_%d' % k, 'iron', x, y, BASE_Z + z + 0.04,
                r * 0.26, r * 0.28, 3420 + k, n=6)
    # копья на земле, наконечники — плоские листья
    for k, (x0, y0, x1, y1) in enumerate(((0.10, 0.02, 1.12, 0.34),
                                           (0.26, 0.42, 1.06, 0.14))):
        K.fallen_beam(parts, 'spear_%d' % k, (x0, y0), (x1, y1), 0.032,
                      seed=3430 + k, fam='plank', z0=BASE_Z)
        ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
        K.shingle(parts, 'spear_head_%d' % k, x1, y1, 0.07, 0.18, ang,
                  3435 + k, fam='iron', z=BASE_Z + 0.02, thick=0.025)


# --------------------------------------------------------------------------
# КОСТЁР: РАЗМЕТАН
# --------------------------------------------------------------------------
def build_fire(parts):
    cx, cy = WC.FIRE
    # камни очага остались на месте (кольцо)
    rng = random.Random(3600)
    for k in range(6):
        a = math.radians(8.0 + 60.0 * k + rng.uniform(-4.0, 4.0))
        rr = rng.uniform(0.365, 0.405)
        K.stone(parts, 'fire_stone_%d' % k,
                'stone' if k % 2 == 0 else 'stone2',
                cx + rr * math.cos(a), cy + rr * math.sin(a), BASE_Z,
                rng.uniform(0.070, 0.095), rng.uniform(0.095, 0.145),
                3610 + k, n=5)
    # залитая зола и угли
    v, f = F.prism(F.ngon(cx, cy, 0.29, 10, phase=math.pi / 10.0),
                   BASE_Z, BASE_Z + 0.06, 2)
    K.add(parts, 'fire_ash', 'ash', (v, f))
    for k, (ang, fam) in enumerate(((12.0, 'char'), (68.0, 'char'),
                                     (128.0, 'timber'))):
        a = math.radians(ang)
        dx, dy = math.cos(a) * 0.24, math.sin(a) * 0.24
        K.beam(parts, 'fire_log_%d' % k, fam,
               (cx - dx, cy - dy, BASE_Z + 0.045),
               (cx + dx, cy + dy, BASE_Z + 0.045), 0.042, 0.042,
               seed=3620 + k, nocull=True)
    # тренога упала: две ноги на земле, одна торчит
    for k in range(3):
        a = math.radians(30.0 + 120.0 * k)
        fx, fy = cx + 0.52 * math.cos(a), cy + 0.52 * math.sin(a)
        if k == 2:
            K.beam(parts, 'tripod_%d' % k, 'char',
                   (fx, fy, BASE_Z), (cx, cy, BASE_Z + 1.02), 0.042, 0.042,
                   seed=3640 + k, nocull=True)
        else:
            K.fallen_beam(parts, 'tripod_%d' % k, (fx, fy),
                          (cx + 0.10, cy + 0.10), 0.042, seed=3641 + k,
                          fam='timber', z0=BASE_Z)
    # котёл лежит на боку: чаша и тёмное нутро
    v, f = F.prism(F.ngon(cx + 0.18, cy - 0.12, 0.16, 8, phase=0.2),
                   0.0, 0.30, 2)
    v = [(p[0], p[1], p[2] + BASE_Z) for p in v]
    K.add(parts, 'cauldron_side', 'iron', (v, f), jit=0.002, seed=3650)
    K.stone(parts, 'cauldron_bail', 'iron', cx + 0.30, cy + 0.02, BASE_Z,
            0.09, 0.05, 3651, n=5)


# --------------------------------------------------------------------------
# ПРИПАС: РАЗБРОСАН
# --------------------------------------------------------------------------
def build_supplies(parts):
    # ящик разбит: крышка и две клёпки
    cx, cy = WC.CRATE
    K.fallen_plank(parts, 'crate_side_0', cx - 0.04, cy + 0.02, 0.38, 0.12,
                   -18.0, 3700, fam='plank', z=BASE_Z, thick=0.035)
    K.fallen_plank(parts, 'crate_side_1', cx + 0.16, cy - 0.10, 0.32, 0.10,
                   64.0, 3701, fam='char', z=BASE_Z, thick=0.03)
    K.fallen_beam(parts, 'crate_lid', (cx - 0.12, cy + 0.18),
                  (cx + 0.24, cy + 0.28), 0.10, seed=3702, fam='beam',
                  z0=BASE_Z)
    # кадка рассыпалась: три клёпки и обруч
    bx, by = WC.BARREL
    K.fallen_plank(parts, 'barrel_stave_0', bx - 0.06, by + 0.04, 0.30,
                   0.09, 12.0, 3710, fam='char', z=BASE_Z, thick=0.03)
    K.fallen_plank(parts, 'barrel_stave_1', bx + 0.12, by - 0.06, 0.28,
                   0.08, -34.0, 3711, fam='beam', z=BASE_Z, thick=0.03)
    K.shingle(parts, 'barrel_hoop', bx + 0.02, by + 0.18, 0.24, 0.05, 72.0,
              3712, fam='iron', z=BASE_Z + 0.01, thick=0.025)
    # сгоревшие брёвна у костра
    for k, (ang, ln) in enumerate(((20.0, 0.44), (155.0, 0.36), (250.0, 0.40))):
        a = math.radians(ang)
        K.fallen_beam(parts, 'burnt_log_%d' % k,
                      (cx - math.cos(a) * ln / 2.0, cy - math.sin(a) * ln / 2.0),
                      (cx + math.cos(a) * ln / 2.0, cy + math.sin(a) * ln / 2.0),
                      0.07, seed=3720 + k, fam='char', z0=BASE_Z)
    K.char_pile(parts, 'char_pile', cx + 0.10, cy + 0.20, 0.16, 3730, n=4,
                z0=BASE_Z)
    K.ash_patch(parts, 'ash_spill', cx + 0.30, cy + 0.36, 0.26, 0.18, 3731,
                z=BASE_Z + 0.006)


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None):
    parts = []
    # площадка и её камни — из генератора целого лагеря
    WC.build_ground(parts, random.Random(22))
    build_banner(parts)
    build_arms(parts)
    build_fire(parts)
    build_supplies(parts)
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
