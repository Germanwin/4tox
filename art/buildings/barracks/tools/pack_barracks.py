"""pack_barracks.py — упаковка спрайтов казармы в атлас игры.

    $PY3 tools/pack_barracks.py [--pad 2]

Читает `out/br_<вариант>_<поворот>.png` и `.json` (их пишет `tools/compose.py`)
и складывает ДВА варианта по ЧЕТЫРЕ поворота в
`mapgen2/assets/barracks/{atlas.png, atlas.json, atlas.js}` — в том же формате,
что `assets/townhall/`, `assets/starter_house/` и `assets/lumbercamp/`.

Пятно — 4 x 3 клетки: при повороте 0 и 180 длинная сторона идёт по X, при 90 и
270 — по Y (в игре казарма встаёт `FACE_ROT = 90`, как ратуша).

КРУПНОСТЬ.  `mul = siteMul(4) = fitMul(4) * MARGIN_K = (1 - 2*(1/3)/4) * 0.92 =
0.7667` — то же число, что у ратуши: правило зазора плюс общая поправка
заказчика −8 % (`mapgen2/js/buildings.js`). Здесь оно не выводится «на глаз»,
а считается той же формулой; сверяет его `tools/place_barracks.py`.

`ground` — НАЗЕМНЫЙ КОНТУР, посчитанный ПО МОДЕЛИ, а не по пикселям.
Причина та же, что у лагеря и у дома жителя: на плацу стоят разреженные
предметы (стойка, знамя, мишень), сплошного цоколя под ними нет, и пиксельный
замер видит только ближний к камере край.  Хуже неточности то, что ошибка
зависит от поворота: игра сдвигала бы спрайт по-разному в разных кадрах, и
казарма «дышала» бы при повороте.  Модель даёт контур точно и одинаково на
всех четырёх кадрах; приёмка `tools/place_barracks.py` меряет его ТЕМ ЖЕ
правилом.

Конвенция осей — как у соседей: `X = -(x + z)`, `Y = y - z` при z ~ 0
(разбор — в шапке `art/buildings/lumbercamp/tools/pack_lumbercamp.py`).
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
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
DST = os.path.join(GAME, 'assets', 'barracks')

ROTATIONS = (0, 90, 180, 270)
VARIANTS = ('a', 'b')
SIDE = 4                                   # длинная сторона пятна, клетки
PPU = 96.0
AZ, EL = 45.0, 35.264389682754654
GROUND_Z = 0.025                           # низ детали ниже этого — она на земле

# Крупность: правило посадки плюс общая поправка −8 % (mapgen2/js/buildings.js)
BASE_MARGIN = 1.0 / 3.0
MARGIN_K = 0.92
MUL = round((1.0 - 2.0 * BASE_MARGIN / SIDE) * MARGIN_K, 4)     # 0.7667


def load_generator():
    """Модуль геометрии по пути — в живом Blender у соседей свои `barracks`."""
    path = os.path.join(HERE, 'barracks.py')
    spec = importlib.util.spec_from_file_location('br_building', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['br_building'] = mod
    spec.loader.exec_module(mod)
    return mod


def ground_from_model(parts, rotation):
    """Наземный контур в клетках от опоры — в конвенции ПИКСЕЛЬНОГО замера.

    Габарит ТОЧЕК КОНТАКТА с землёй (z <= GROUND_Z), повёрнутых тем же
    поворотом вокруг Z, что и кадр (`blender_live.rotate_meshes`), и
    переведённых в координаты карты: `X = -x`, `Y = y`.
    """
    th = math.radians(rotation)
    c, s = math.cos(th), math.sin(th)
    xs, ys = [], []
    for p in parts:
        lo = min(v[2] for v in p['verts'])
        if lo > GROUND_Z:
            continue
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


def footprint(rotation):
    """Пятно в клетках: 4 x 3 на 0/180, 3 x 4 на 90/270."""
    return (SIDE, 3) if rotation in (0, 180) else (3, SIDE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--pad', type=int, default=2)
    args = ap.parse_args()

    gen = load_generator()
    frames = []
    for var in VARIANTS:
        parts = gen.build(var)
        for rot in ROTATIONS:
            png = os.path.join(args.src, 'br_%s_%d.png' % (var, rot))
            jsn = os.path.join(args.src, 'br_%s_%d.json' % (var, rot))
            if not (os.path.exists(png) and os.path.exists(jsn)):
                print('нет %s или %s — сначала tools/compose.py' % (png, jsn))
                return 1
            meta = json.load(open(jsn, encoding='utf-8'))
            ax, ay = meta['anchor']
            frames.append(dict(
                name='br_%s_%d' % (var, rot), variant=var, rotation=rot,
                img=Image.open(png).convert('RGBA'),
                anchorX=float(ax), anchorY=float(ay),
                ground=ground_from_model(parts, rot)))

    print('наземный контур по модели (клетки от опоры):')
    for f in frames:
        g = f['ground']
        mx, my = (g[0] + g[1]) / 2.0, (g[2] + g[3]) / 2.0
        fp = footprint(f['rotation'])
        gapx = (fp[0] - (g[1] - g[0]) * MUL) / 2.0
        gapy = (fp[1] - (g[3] - g[2]) * MUL) / 2.0
        print('  %s  x %+.3f..%+.3f  y %+.3f..%+.3f  шихта %.2f x %.2f  '
              'середина (%+.3f, %+.3f)  зазор %.3f x %.3f'
              % (f['name'], g[0], g[1], g[2], g[3], g[1] - g[0], g[3] - g[2],
                 mx, my, gapx, gapy))

    pad = max(1, args.pad)
    cols = len(ROTATIONS)
    rows = len(VARIANTS)
    cw = max(f['img'].width for f in frames) + pad * 2
    ch = max(f['img'].height for f in frames) + pad * 2
    W, H = cw * cols + 1, ch * rows + 1
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    out_frames = {}
    for f in frames:
        col = ROTATIONS.index(f['rotation'])
        row = VARIANTS.index(f['variant'])
        x = col * cw + pad
        y = row * ch + pad
        atlas.alpha_composite(f['img'], (x, y))
        out_frames[f['name']] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            'anchorX': round(f['anchorX'], 2), 'anchorY': round(f['anchorY'], 2),
            'variant': f['variant'], 'rotation': f['rotation'],
            'footprint': list(footprint(f['rotation'])),
            'ground': f['ground'],
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': PPU,
        'az_deg': AZ,
        'el_deg': EL,
        'res': [512, 640],
        'variants': {v: [SIDE, 3] for v in VARIANTS},
        'mul': MUL,
        'note': ('спрайты казармы: 1 юнит модели = 1 клетка карты; пятно 4 x 3 '
                 '(при 90/270 — 3 x 4); два варианта: a — открытый плац, b — '
                 'двор с навесом. anchorX/anchorY — точка опоры (центр пятна); '
                 'footprint — пятно в клетках по повороту; ground — наземный '
                 'контур в клетках от опоры, посчитан ПО МОДЕЛИ (основание — '
                 'валуны плюс разреженный плац, пиксельный замер видит только '
                 'ближний край; см. шапку tools/pack_barracks.py); mul — '
                 'крупность siteMul(4) = 0.7667, как у ратуши'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(DST, 'atlas.js'), 'w', encoding='utf-8') as fh:
        fh.write('window.BARRACKS_ATLAS = ')
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write(';\n')

    print('\n%s/atlas.png %dx%d, кадров %d, %.0f px на юнит, пятно %dx3, mul %s'
          % (os.path.relpath(DST, GAME), W, H, len(out_frames), PPU, SIDE, MUL))
    return 0


if __name__ == '__main__':
    sys.exit(main())
