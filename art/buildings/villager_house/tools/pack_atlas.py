"""pack_atlas.py — упаковка спрайтов дома в атлас генератора карт mapgen2.

    python3 tools/pack_atlas.py [--src out] [--dst ../mapgen2/assets/house]

Читает `out/vh_sprites.json` (его пишет tools/compose.py) и складывает 12 кадров
— 3 варианта x 4 поворота — в `assets/house/atlas.png` + `atlas.json` + `atlas.js`
ровно в том формате, что `assets/townhall/` и `assets/hut/`: игра читает `ppu`,
`frames[].anchorX/anchorY`, `footprint`, `ground` и `mul` и сама считает
масштаб по осям.

Пятно застройки — 3 x 2 клетки (X — длинная сторона), при повороте 90/270 — 2 x 3.
`atlas.js` нужен потому, что страница генератора открывается по file://, а fetch
JSON в этом режиме запрещён.

НАЗЕМНЫЙ КОНТУР И КРУПНОСТЬ — КАК У РАТУШИ
-------------------------------------------
Два поля, которых у дома раньше не было, а у ратуши есть:

* `ground` — наземный контур (цоколь вместе с крыльцом и приступком) в клетках
  от точки опоры. Меряется по пикселям кадра тем же правилом, что в
  `mapgen2/tools/pack_townhall.py::ground_contact`: нижний непрозрачный пиксель
  столбца, и только там, где виден камень цоколя (иначе в контур попадает свес
  кровли). По нему игра ставит дом СЕРЕДИНОЙ ОСНОВАНИЯ в середину пятна: по
  модели основание стоит не по середине — крыльцо у варианта B выходит вперёд.
  Проверяет `mapgen2/tools/place.js`.

* `mul` — крупность спрайта. Правило посадки (`mapgen2/js/buildings.js`) —
  зазор 1/3 клетки по длинной стороне пятна; заказчик 2026-10-14 попросил,
  чтобы отступы у всех построек были такие же, как у ратуши, а ратуша с
  2026-10-13 стоит на 8 % мельче правила. Значит, общая крупность —
  `fitMul(сторона) * 0.92`, для пятна 3 клетки это 0.7156. Меряет `place.js`.
"""
import argparse
import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Проект стоит на art/<группа>/<ассет>, поэтому корень 4tox — три уровня вверх
# (docs/STRUCTURE.md).
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
DEFAULT_DST = os.path.join(REPO, 'mapgen2', 'assets', 'house')
VARIANTS = ('a', 'b', 'c')
ROTATIONS = (0, 90, 180, 270)
PAD = 2

# Крупность: правило посадки минус общая поправка 8 % (см. шапку).
SIDE = 3                                   # длинная сторона пятна, клетки
MARGIN_K = 0.92
MUL = round((1.0 - 2.0 * (1.0 / 3.0) / SIDE) * MARGIN_K, 4)


def footprint(rotation):
    return [3, 2] if rotation % 180 == 0 else [2, 3]


def is_stone(r, g, b):
    """Камень цоколя: серо-голубой, зелёного больше красного, синий не уехал."""
    return abs(g - b) <= 14 and 0 < g - r <= 40 and 55 <= g <= 215


def ground_contact(img, ax, ay, ppu, az_deg, el_deg):
    """Наземный контур кадра в клетках карты, относительно точки опоры.

    Правило то же, что у ратуши (`mapgen2/tools/pack_townhall.py`): нижний
    непрозрачный пиксель каждого столбца, но только там, где виден цоколь —
    выше цоколя столбец может кончаться свесом кровли, и без этого ограничения
    в контур попадает она. Мягкая тень не считается: у неё альфа ниже
    непрозрачной.
    """
    px = img.load()
    w, h = img.size
    ca = math.cos(math.radians(az_deg))
    pxc = ca * ppu                       # пикселей кадра на клетку по экранному X
    pyc = math.sin(math.radians(el_deg)) * pxc
    stone_col = [any(px[x, y][3] >= 250 and is_stone(*px[x, y][:3]) for y in range(h))
                 for x in range(w)]
    has_stone = any(stone_col)
    xs, ys = [], []
    for x in range(w):
        if has_stone and not stone_col[x]:
            continue                     # выше цоколя столбец кончается свесом
        for y in range(h - 1, -1, -1):
            if px[x, y][3] < 250:
                continue                 # мягкая тень: не земля
            if not has_stone and y < ay - 1.2 * pyc:
                break                    # камень не нашли — отсекаем свес по высоте
            dx = (x - ax) / pxc
            dy = (y - ay) / pyc
            xs.append((dx + dy) / 2)     # вдоль длинной оси карты
            ys.append((dy - dx) / 2)     # вдоль короткой
            break
    if not xs:
        return [0.0, 0.0, 0.0, 0.0]
    return [round(min(xs), 3), round(max(xs), 3), round(min(ys), 3), round(max(ys), 3)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--dst', default=DEFAULT_DST)
    ap.add_argument('--only', default='a,b,c')
    args = ap.parse_args()

    meta_path = os.path.join(args.src, 'vh_sprites.json')
    if not os.path.exists(meta_path):
        print('нет %s — сначала: python3 tools/compose.py' % meta_path)
        return 1
    src = json.load(open(meta_path, encoding='utf-8'))
    variants = [v for v in args.only.split(',') if v]

    frames, tiles = [], []
    for v in variants:
        for rot in ROTATIONS:
            key = 'vh_%s_%d' % (v, rot)
            f = src['frames'].get(key)
            if not f:
                print('нет кадра %s' % key)
                continue
            img = Image.open(os.path.join(args.src, f['file'])).convert('RGBA')
            tiles.append((key, img))
            frames.append(dict(name=key, img=img, variant=v, rotation=rot,
                               anchorX=f['anchorX'], anchorY=f['anchorY'],
                               footprint=f['footprint'],
                               ground=ground_contact(
                                   img, float(f['anchorX']), float(f['anchorY']),
                                   src['ppu'], src['az_deg'], src['el_deg'])))

    # раскладка: 4 поворота в ряд на вариант (как у ратуши и хижины)
    cols, rows = len(ROTATIONS), len(variants)
    cw = max(t[1].width for t in tiles) + 2 * PAD
    ch = max(t[1].height for t in tiles) + 2 * PAD
    atlas = Image.new('RGBA', (cw * cols, ch * rows), (0, 0, 0, 0))
    out_frames = {}
    for i, fr in enumerate(frames):
        r, c = divmod(i, cols)
        x, y = c * cw + PAD, r * ch + PAD
        atlas.alpha_composite(fr['img'], (x, y))
        out_frames[fr['name']] = dict(
            x=x, y=y, w=fr['img'].width, h=fr['img'].height,
            anchorX=round(fr['anchorX'] + PAD, 2),
            anchorY=round(fr['anchorY'] + PAD, 2),
            variant=fr['variant'], rotation=fr['rotation'],
            footprint=footprint(fr['rotation']),
            # Наземный контур (цоколь вместе с крыльцом), клетки от точки опоры.
            ground=fr['ground'])

    os.makedirs(args.dst, exist_ok=True)
    atlas.save(os.path.join(args.dst, 'atlas.png'))
    meta = dict(
        atlas='atlas.png', ppu=src['ppu'], az_deg=src['az_deg'],
        el_deg=src['el_deg'], res=src['res'],
        variants={v: [3, 2] for v in variants},
        mul=MUL,
        note='дом жителя: 1 юнит модели = 1 клетка карты, пятно 3 x 2 '
             '(при повороте 2 x 3); anchorX/anchorY — точка опоры (центр пятна '
             'застройки); footprint — пятно в клетках по повороту; ground — '
             'наземный контур в клетках от опоры; mul — крупность спрайта',
        shadow=src.get('shadow'), outline=src.get('outline'),
        frames=out_frames)
    with open(os.path.join(args.dst, 'atlas.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.dst, 'atlas.js'), 'w', encoding='utf-8') as f:
        f.write('/* атлас дома жителя — то же, что atlas.json, но скриптом:\n'
                '   страница генератора открывается по file://, где fetch\n'
                '   JSON запрещён. */\nwindow.HOUSE_ATLAS = ')
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write(';\n')
    print('АТЛАС %s: %dx%d, кадров %d -> %s'
          % ('house', atlas.width, atlas.height, len(out_frames), args.dst))
    for k, v in out_frames.items():
        print('  %-12s %4dx%-4d опора=(%6.1f,%6.1f) пятно=%s'
              % (k, v['w'], v['h'], v['anchorX'], v['anchorY'], v['footprint']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
