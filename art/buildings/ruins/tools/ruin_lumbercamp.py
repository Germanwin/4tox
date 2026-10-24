"""ruin_lumbercamp.py — РАЗРУШЕННЫЙ ЛАГЕРЬ ЛЕСОРУБА, пятно 3 x 3.

Целая модель — `art/buildings/lumbercamp/tools/building.py` (тип `lumbercamp`,
атлас `mapgen2/assets/lumbercamp/`).  У лагеря нет стен и щипца: это навес на
четырёх столбах, колода с топором и рабочий двор.  Поэтому руина — не «дом без
крыши», а УПАВШИЙ НАВЕС:

* четыре опорных камня и два задних столба стоят, передние сломаны — кровля
  провисла и легла скатом на землю внутрь двора;
* доски навеса частью на скате, частью сорваны и лежат;
* поленница раскатана и обуглена, часть брёвен ушла в угли;
* пни, кадка, колода с топором и частокол остались на своих местах (места
  взяты из генератора целого лагеря, `POST_X/POST_Y`, `BLOCK`, `BARREL`), но
  колода и часть частокола обгорели;
* пепел и угли — на земле, внутри пятна.

Наземный контур целого лагеря держат опорные камни, три колышка частокола,
колода и два пня.  Все они сохранены, поэтому `ground` совпадает с целым
атласом; проверяет `tools/check_atlas.py`.
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


LC = _load('ruin_lc_src', os.path.join(
    HERE, '..', '..', 'lumbercamp', 'tools', 'building.py'))

POST_X, POST_Y = LC.POST_X, LC.POST_Y
FOOT_T, FOOT_H, POST_T = LC.FOOT_T, LC.FOOT_H, LC.POST_T
Z_BACK, Z_FRONT = LC.Z_BACK, LC.Z_FRONT
BLOCK, BARREL = LC.BLOCK, LC.BARREL

SPEC = dict(
    footprint=(3, 3),
    wall_x=1.90,
    wall_y=1.14,
    wall_h=1.33,                    # уцелевший задний столб
    z_plinth=FOOT_H,
    z_wall=Z_BACK,
    pitch_deg=None,                 # кровля упала
    over_slope=0.0,
    over_end=0.0,
    ridge_z=None,
    class_='ruin',
    canon=dict(h_b=(1.25, 2.00), wall_h=(0.60, 1.45), tris=(300, 1500),
               min_detail=0.02),
)


# --------------------------------------------------------------------------
# ОПОРЫ И СТОЛБЫ
# --------------------------------------------------------------------------
def build_feet(parts):
    """Четыре опорных камня — те же, что у целого лагеря (место и размер).

    Они держат наземный контур: x до +-1.44, y до -1.45.  Поэтому камни не
    «похожие», а посчитанные теми же числами `POST_X/POST_Y/FOOT_T/FOOT_H`.
    """
    rng = random.Random(7001)
    for i, x in enumerate(POST_X):
        for j, y in enumerate(POST_Y):
            v, f = F.box(x, y, 0.0, FOOT_T, FOOT_T, FOOT_H,
                         rz=math.radians(rng.uniform(-4, 4)))
            K.add(parts, 'foot_%d_%d' % (i, j), 'stone', (v, f), jit=0.006,
                  seed=7000 + i * 10 + j)


def build_posts(parts):
    """Задние столбы стоят, передние сломаны: кровля провисла на +Y."""
    # задний ряд (дальний от камеры) — цел почти до прогона
    for i, x in enumerate(POST_X):
        K.beam(parts, 'post_back_%d' % i, 'timber',
               (x, POST_Y[0], FOOT_H - 0.03), (x, POST_Y[0] - 0.02, 1.36),
               POST_T, POST_T, seed=7100 + i)
        K.slab(parts, 'post_back_burn_%d' % i, 'char',
               x - 0.055, x + 0.055, POST_Y[0] - 0.075, POST_Y[0] + 0.035,
               1.33, 1.39, jit=0.002, seed=7110 + i, nocull=True)
    # передний ряд (к камере) — сломан низко, один столб упал
    for i, x in enumerate(POST_X):
        K.broken_post(parts, 'post_front_%d' % i, x, POST_Y[1], FOOT_H - 0.03,
                      0.34 if i == 0 else 0.46, POST_T, seed=7120 + i,
                      lean=(0.03, 0.02), char=True)
    K.fallen_beam(parts, 'post_fallen', (-1.24, 0.18), (0.48, 0.34), 0.11,
                  seed=7125, fam='char')

    # задний прогон на месте, передний сорван и лежит поперёк двора.
    K.beam(parts, 'plate_back', 'timber',
           (LC.ROOF_X0 + 0.06, POST_Y[0], Z_BACK + LC.PLATE_H / 2.0),
           (LC.ROOF_X1 - 0.06, POST_Y[0], Z_BACK + LC.PLATE_H / 2.0),
           0.14, LC.PLATE_H, seed=7130, nocull=True)
    K.fallen_beam(parts, 'plate_front_fallen', (-1.28, 0.62), (0.62, 0.44),
                  0.13, seed=7131, fam='timber')


# --------------------------------------------------------------------------
# УПАВШАЯ КРОВЛЯ
# --------------------------------------------------------------------------
def build_roof(parts):
    """Один большой скат лёг с заднего прогона на землю — главный фасет."""
    # Скат ложится ОТ заднего прогона к земле, но не на весь двор: низ ската
    # на y = -0.18, передние столбы и весь рабочий двор остаются на виду.
    quad = [(-1.38, -1.34, Z_BACK + LC.PLATE_H + 0.02),
            (0.66, -1.34, Z_BACK + LC.PLATE_H + 0.02),
            (0.60, -0.18, 0.035), (-1.34, -0.24, 0.035)]
    K.roof_panel(parts, 'roof_fallen', quad, 0.09, fam='thatch2', seed=7200)
    # Тёс на скате: три полосы, лежащие НА плоскости ската.
    def z_roof(y):
        return 1.60 + (y + 1.34) * (0.035 - 1.60) / (-0.18 + 1.34) + 0.05

    for k, yc in enumerate((-1.06, -0.74, -0.44)):
        y0, y1 = yc - 0.11, yc + 0.11
        quad = [(-1.35, y0, z_roof(y0)), (0.63, y0, z_roof(y0)),
                (0.63, y1, z_roof(y1)), (-1.35, y1, z_roof(y1))]
        K.roof_panel(parts, 'roof_board_%d' % k, quad, 0.035,
                     fam='plank' if k != 1 else 'beam', seed=7210 + k)
    # обгоревшая кромка ската
    K.beam(parts, 'roof_edge_char', 'char', (-1.34, -0.24, 0.06),
           (0.60, -0.18, 0.06), 0.06, 0.05, seed=7220, nocull=True)
    # сорванные доски рядом
    K.fallen_beam(parts, 'roof_board_fallen', (-1.18, 0.72), (-0.72, 1.02),
                  0.10, seed=7230, fam='plank')
    K.fallen_beam(parts, 'roof_board_fallen_2', (0.30, 0.80), (0.86, 1.08),
                  0.09, seed=7231, fam='char')


# --------------------------------------------------------------------------
# ДВОР
# --------------------------------------------------------------------------
def build_yard(parts):
    rng = random.Random(17)
    # Пни и колода с топором — на своих местах (дают наземный контур).
    LC.build_stumps(parts, rng)
    LC.build_block_axe(parts, rng)
    # Частокол уцелел частично: его колышки держат край контура x = -1.41.
    LC.build_fence(parts, rng)
    LC.build_barrel(parts, rng)
    # Поленница раскатана: брёвна лежат вразброс и обуглены.
    for k, (x, y, ang, fam) in enumerate((
            (-0.92, -0.78, 8.0, 'char'), (-0.60, -0.56, -22.0, 'plank'),
            (-0.30, -0.82, 40.0, 'char'), (0.02, -0.48, 96.0, 'beam'),
            (0.26, -0.86, 14.0, 'char'), (-0.84, -0.34, 62.0, 'plank'))):
        c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        K.fallen_beam(parts, 'scattered_log_%d' % k,
                      (x - c * 0.26, y - s * 0.26), (x + c * 0.26, y + s * 0.26),
                      0.10, seed=7300 + k, fam=fam)
    # угли, пепел, щепа
    K.ash_patch(parts, 'ash_yard', -0.55, 0.10, 0.50, 0.34, 7400)
    K.ash_patch(parts, 'ash_pile', 0.10, -0.60, 0.36, 0.30, 7401)
    K.char_pile(parts, 'char_pile_0', -0.30, -0.56, 0.22, 7410, n=4)
    K.char_pile(parts, 'char_pile_1', 0.20, 0.28, 0.16, 7411, n=3)
    K.rubble(parts, 'rubble_yard', 0.72, 1.10, 0.16, 7420, fam='stone')


# --------------------------------------------------------------------------
# СБОРКА
# --------------------------------------------------------------------------
def build(variant=None):
    # Двор собирается ПЕРВЫМ и выравнивается по земле сам: у целых деталей
    # (`build_stumps` и др.) дрожь иногда уводит низ на -0.027.  Если дать
    # `F.ground` поднять ВСЮ модель, опорные камни уедут на 0.027 вверх и
    # перестанут попадать в наземный контур — `ground` разойдётся с целым.
    yard = []
    build_yard(yard)
    lo = min(v[2] for p in yard for v in p['verts'])
    if lo < 0.0:
        for p in yard:
            p['verts'] = [(v[0], v[1], v[2] - lo) for v in p['verts']]
    # Двор целого лагеря после F.ground стоит на 0.02..0.03 выше нуля: его
    # поднял `F.ground`, а колышки частокола и так начинались на 0.02.  Для
    # приёмки это «висят»: деталь не на земле и не примкнута.  Опускаем двор
    # на 0.022 и поднимаем обратно ТОЛЬКО то, что ушло под землю: столбы и
    # поленница целы, а частокол, кадка и колода встают на землю.
    for p in yard:
        p['verts'] = [(v[0], v[1], v[2] - 0.022) for v in p['verts']]
    for p in yard:
        below = min(v[2] for v in p['verts'])
        if below < 0.001:
            p['verts'] = [(v[0], v[1], v[2] + 0.001 - below)
                          for v in p['verts']]
    parts = list(yard)
    build_feet(parts)
    build_posts(parts)
    build_roof(parts)
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
