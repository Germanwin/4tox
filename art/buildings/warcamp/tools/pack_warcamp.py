"""pack_warcamp.py — упаковка спрайтов военного лагеря в атлас игры.

    $PY3 tools/pack_warcamp.py [--pad 2]

Читает `out/wc_<поворот>.png` и `.json` (их пишет `tools/compose.py`) и
складывает четыре поворота в `mapgen2/assets/warcamp/{atlas.png, atlas.json,
atlas.js}` — в том же формате, что `assets/townhall/`, `assets/starter_house/`,
`assets/lumbercamp/` и `assets/barracks/`.

ПЯТНО — 5 x 5 клеток, хотя сама модель занимает 2 x 2 по центру.  Игра ставит
её по пятну: на остальных клетках встанут воины (по условию заказчика их в
модели нет).  Пятно квадратное, поэтому поворот его не меняет.

КРУПНОСТЬ.  `mul = siteMul(5) = fitMul(5) * MARGIN_K = (1 - 2/15) * 0.92 =
0.7973` — общее правило посадки с поправкой −8 % (`mapgen2/js/buildings.js`).
Здесь оно не подбирается: формула та же, а `tools/place_warcamp.py` сверяет
число и проверяет, что видимое основание — ровно 2.00 x 2.00 клетки.

`ground` — НАЗЕМНЫЙ КОНТУР, посчитанный ПО МОДЕЛИ.  Площадка — регулярный
12-угольник с вершинами на осях, поэтому её bbox 2.5084 x 2.5084 одинаков на
всех четырёх поворотах; спрайт не «дышит».  Конвенция осей — как у соседей:
`X = -(x)`, `Y = y` при z ~ 0 (разбор — в шапке
`art/buildings/lumbercamp/tools/pack_lumbercamp.py`).
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
DST = os.path.join(GAME, 'assets', 'warcamp')

ROTATIONS = (0, 90, 180, 270)
SIDE = 5                                   # площадка, клетки
PPU = 96.0
AZ, EL = 45.0, 35.264389682754654
GROUND_Z = 0.025                           # низ детали ниже этого — она на земле
BASE_MARGIN = 1.0 / 3.0
MARGIN_K = 0.92
MUL = round((1.0 - 2.0 * BASE_MARGIN / SIDE) * MARGIN_K, 4)     # 0.7973


def load_generator():
    """Модуль геометрии по пути — в живом Blender у соседей свои `warcamp`."""
    path = os.path.join(HERE, 'warcamp.py')
    spec = importlib.util.spec_from_file_location('wc_generator', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['wc_generator'] = mod
    spec.loader.exec_module(mod)
    return mod


def ground_from_model(parts, rotation):
    """Наземный контур в клетках от опоры — в конвенции пиксельного замера.

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
    """Площадка 5 x 5 не меняется при повороте."""
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
        png = os.path.join(args.src, 'wc_%d.png' % rot)
        jsn = os.path.join(args.src, 'wc_%d.json' % rot)
        if not (os.path.exists(png) and os.path.exists(jsn)):
            print('нет %s или %s — сначала tools/compose.py' % (png, jsn))
            return 1
        meta = json.load(open(jsn, encoding='utf-8'))
        ax, ay = meta['anchor']
        frames.append(dict(
            name='wc_%d' % rot, rotation=rot,
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
        print('  %s  x %+.3f..%+.3f  y %+.3f..%+.3f  видно %.2f x %.2f  '
              'середина (%+.3f, %+.3f)  зазор %.3f x %.3f'
              % (f['name'], g[0], g[1], g[2], g[3],
                 (g[1] - g[0]) * MUL, (g[3] - g[2]) * MUL,
                 mx, my, gapx, gapy))

    pad = max(1, args.pad)
    cw = max(f['img'].width for f in frames) + pad * 2
    ch = max(f['img'].height for f in frames) + pad * 2
    W, H = cw * len(ROTATIONS) + 1, ch + 1
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out_frames = {}
    for f in frames:
        col = ROTATIONS.index(f['rotation'])
        x = col * cw + pad
        y = pad
        atlas.alpha_composite(f['img'], (x, y))
        out_frames[f['name']] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            'anchorX': round(f['anchorX'], 2), 'anchorY': round(f['anchorY'], 2),
            'variant': 'x', 'rotation': f['rotation'],
            'footprint': list(footprint(f['rotation'])),
            'ground': f['ground'],
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': PPU,
        'az_deg': AZ,
        'el_deg': EL,
        'res': [512, 640],
        'variants': {'x': [SIDE, SIDE]},
        'mul': MUL,
        'note': ('военный лагерь: площадка 5 x 5 клеток, сама модель 2 x 2 '
                 'по центру; остальные клетки — место для воинов. Один '
                 'вариант, 4 поворота. anchorX/anchorY — центр площадки; '
                 'footprint — 5 x 5 (поворот его не меняет); ground — '
                 'наземный контур 2.5084 x 2.5084 юнита, посчитан ПО МОДЕЛИ '
                 '(площадка — регулярный 12-угольник; см. шапку '
                 'tools/pack_warcamp.py); mul — siteMul(5) = 0.7973'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(DST, 'atlas.js'), 'w', encoding='utf-8') as fh:
        fh.write('window.WARCAMP_ATLAS = ')
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write(';\n')

    print('\n%s/atlas.png %dx%d, кадров %d, %.0f px на юнит, пятно %dx%d, mul %s'
          % (os.path.relpath(DST, GAME), W, H, len(out_frames), PPU, SIDE, SIDE,
             MUL))
    return 0


if __name__ == '__main__':
    sys.exit(main())
