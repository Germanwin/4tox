"""pack_lumbercamp.py — упаковка спрайтов лагеря лесоруба в атлас игры.

    $PY3 tools/pack_lumbercamp.py [--pad 2]

Читает `out/lc_<rot>.png` и `out/lc_<rot>.json` (их пишет `tools/compose.py`) и
складывает 4 поворота в `mapgen2/assets/lumbercamp/atlas.png` + `atlas.json` +
`atlas.js` — в том же формате, что `assets/townhall/` и `assets/hut/`.

Пятно застройки — 3 x 3 клетки (квадрат, поворот его не меняет).

ЧЕМ ЭТОТ УПАКОВЩИК ОТЛИЧАЕТСЯ ОТ `pack_townhall.py`: `ground` СЧИТАЕТСЯ ПО
МОДЕЛИ, А НЕ ПО ПИКСЕЛЯМ
--------------------------------------------------------------------
`pack_townhall.py` меряет наземный контур по пикселям кадра — нижний
непрозрачный пиксель столбца, и только там, где виден камень цоколя.  Для
ратуши это верно: цоколь идёт сплошной полосой по всему основанию.

У лагеря основание РАЗРЕЖЕННОЕ: камень есть только под четырьмя столбами
навеса, а дровяной двор, пни, брёвна, кадка и частокол стоят на земле без
камня.  Замер четырёх правил по кадрам 0 и 90 (середина контура, клетки):

    правило                              кадр 0        кадр 90
    только столбцы с камнем              (+0.07,-0.11) (+0.13,+0.57)
    низ столбца, отсев выше 1.2 клетки   (-0.02,-0.11) (+0.12,-0.16)
    низ столбца без отсева               (-0.02,-0.56) (+0.12,-0.22)
    ПО МОДЕЛИ (пятно контакта с землёй)  (+0.02,-0.09) (-0.09,-0.02)

Пиксельные правила годятся на одном повороте и врут на другом: отсев «не выше
1.2 клетки» рассчитан на компактное здание, а у пятна 3 x 3 дальний угол лежит
на 2.9 клетки, и на повороте 90 он срезает половину контура.  Хуже неточности
здесь то, что ошибка зависит от поворота: игра сдвинула бы спрайт по-разному в
разных кадрах одного атласа, и лагерь «дышал» бы при повороте.

Поэтому контур считается там, где он и определён, — по геометрии: габарит
деталей, чей низ лежит на земле (z <= 0.025), повёрнутый тем же поворотом
вокруг Z, что и кадр (`blender_live.rotate_meshes`).  Это ещё и точнее: пиксель
даёт дискретность 1/ppu, а модель — число.

Проверка посадки обязана мерить контур ТЕМ ЖЕ правилом:
`$PY3 tools/place_lumbercamp.py`.
"""
import argparse
import importlib.util
import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Проект стоит на art/<группа>/<ассет>, поэтому корень 4tox — три уровня вверх.
# Раскладка и правило глубины: docs/STRUCTURE.md.
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
DST = os.path.join(GAME, 'assets', 'lumbercamp')

ROTATIONS = (0, 90, 180, 270)
VARIANT = 'a'
SIDE = 3                                   # пятно 3 x 3 клетки
PPU = 96.0
AZ, EL = 45.0, 35.264389682754654
GROUND_Z = 0.025                           # низ детали ниже этого — она на земле
# Крупность: правило посадки — основание отходит от края пятна на BASE_MARGIN
# (1/3 клетки) по длинной стороне.  Число живёт здесь, в упаковщике: атлас и
# его масштаб едут вместе.  Поправки к правилу (как у ратуши) у лагеря нет.
MUL = round(1.0 - 2.0 * (1.0 / 3.0) / SIDE, 4)


def load_generator():
    """Модуль геометрии по пути — в живом Blender у соседей свои `building`."""
    path = os.path.join(HERE, 'building.py')
    spec = importlib.util.spec_from_file_location('lc_building', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['lc_building'] = mod
    spec.loader.exec_module(mod)
    return mod


def ground_from_model(parts, rotation):
    """Наземный контур в клетках от опоры — в конвенции ПИКСЕЛЬНОГО замера.

    Габарит деталей, чей низ лежит на земле (z <= 0.025), повёрнутых тем же
    поворотом вокруг Z, что и кадр (`blender_live.rotate_meshes`), и переведённых
    в те же координаты, что даёт `ground_contact` из `pack_townhall.py`:

        X = -(x + z),  Y = y - z      (при z ~ 0 это X = -x, Y = y)

    Именно так — с минусом по X — потому что упаковщик ратуши считает X из
    ПИКСЕЛЕЙ кадра: X = (dx + dy)/2, где dx = -(x + y), dy = -(x - y) - 2z (эта
    проекция подтверждена растеризацией модели против рендера, IoU 0.98).
    Атлас лагеря обязан лежать в ТОЙ ЖЕ конвенции, что атласы ратуши и хижины:
    игра применяет `ground` как сдвиг по осям карты, и разъехавшиеся конвенции
    сдвинули бы постройку не в ту сторону.

    О расхождении осей у рендера построек и у карты игры — раздел «Оси» в
    README проекта.
    """
    th = math.radians(rotation)
    c, s = math.cos(th), math.sin(th)
    xs, ys = [], []
    for p in parts:
        lo = min(v[2] for v in p['verts'])
        if lo > GROUND_Z:
            continue
        # Только точки КОНТАКТА с землёй, а не вся деталь: пиксельный замер
        # берёт нижний пиксель столбца, и у высокого колышка это его пятно, а
        # не верх.  Возьми всю деталь — и высота раздует контур (у лагеря до
        # 3.5 клетки вместо 2.9, и зазор уходит в минус).
        for v in p['verts']:
            if v[2] > lo + 0.05:
                continue
            x = v[0] * c - v[1] * s
            y = v[0] * s + v[1] * c
            xs.append(-x)
            ys.append(y)
    if not xs:
        return [0.0, 0.0, 0.0, 0.0]
    return [round(min(xs), 3), round(max(xs), 3),
            round(min(ys), 3), round(max(ys), 3)]


def mid(g):
    return (round((g[0] + g[1]) / 2.0, 3), round((g[2] + g[3]) / 2.0, 3))


def footprint(rotation):
    return (SIDE, SIDE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--pad', type=int, default=2)
    args = ap.parse_args()

    gen = load_generator()
    parts = gen.build()

    frames = []
    for rot in ROTATIONS:
        png = os.path.join(args.src, 'lc_%d.png' % rot)
        jsn = os.path.join(args.src, 'lc_%d.json' % rot)
        if not (os.path.exists(png) and os.path.exists(jsn)):
            print('нет %s или %s — сначала tools/compose.py' % (png, jsn))
            return 1
        meta = json.load(open(jsn))
        ax, ay = meta['anchor']
        img = Image.open(png).convert('RGBA')
        frames.append(dict(name='lc_%s_%d' % (VARIANT, rot), rotation=rot,
                           img=img, anchorX=float(ax), anchorY=float(ay),
                           ground=ground_from_model(parts, rot)))

    print('наземный контур по модели (клетки от опоры):')
    for f in frames:
        g = f['ground']
        print('  поворот %3d: x %+.3f..%+.3f  y %+.3f..%+.3f  шихта %.2f x %.2f  '
              'середина (%+.3f, %+.3f)'
              % (f['rotation'], g[0], g[1], g[2], g[3], g[1] - g[0], g[3] - g[2],
                 *mid(g)))

    pad = max(1, args.pad)
    cell_w = max(f['img'].width for f in frames) + pad * 2
    cell_h = max(f['img'].height for f in frames) + pad * 2
    W, H = cell_w * len(ROTATIONS) + 1, cell_h + 1
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    out_frames = {}
    for f in frames:
        x = ROTATIONS.index(f['rotation']) * cell_w + pad
        y = pad
        atlas.alpha_composite(f['img'], (x, y))
        out_frames[f['name']] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            'anchorX': round(f['anchorX'], 2), 'anchorY': round(f['anchorY'], 2),
            'variant': VARIANT, 'rotation': f['rotation'],
            'footprint': list(footprint(f['rotation'])),
            'ground': f['ground'],
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': PPU,
        'az_deg': AZ,
        'el_deg': EL,
        'res': [512, 640],
        'variants': {VARIANT: list(footprint(0))},
        'mul': MUL,
        'note': ('спрайты лагеря лесоруба: 1 юнит модели = 1 клетка карты, '
                 'пятно 3 x 3; anchorX/anchorY — точка опоры (центр пятна); '
                 'footprint — пятно в клетках; ground — наземный контур в '
                 'клетках от опоры, посчитан ПО МОДЕЛИ (основание разреженное, '
                 'сплошного цоколя нет — пиксельный замер врёт, см. шапку '
                 'tools/pack_lumbercamp.py); mul — крупность'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(DST, 'atlas.js'), 'w', encoding='utf-8') as fh:
        fh.write('window.LUMBERCAMP_ATLAS = ')
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write(';\n')

    print('\n%s/atlas.png %dx%d, кадров %d, %.1f px на юнит, пятно %dx%d, mul %s'
          % (os.path.relpath(DST, GAME), W, H, len(out_frames), PPU, SIDE, SIDE, MUL))
    return 0


if __name__ == '__main__':
    sys.exit(main())
