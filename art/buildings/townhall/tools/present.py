"""Финальный лист показа: варианты ратуши, эталон и вид в масштабе карты.

    python3 tools/present.py

Пишет out/final_variants.png (главный лист) и out/final_map.png (проба на карте).
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from sheet import checker, font

# Проект стоит на art/<группа>/<ассет>, поэтому корень 4tox — три уровня вверх.
# Раскладка и правило глубины: docs/STRUCTURE.md.
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
ATLAS = os.path.join(REPO, 'mapgen2', 'assets', 'sprites', 'atlas.png')
META = os.path.join(REPO, 'mapgen2', 'assets', 'sprites', 'atlas.json')
OUT = os.path.join(ROOT, 'out')


def atlas_frame(meta, atlas, name):
    f = meta['frames'][name]
    return atlas.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h'])), f


def scaled(im, s):
    return im.resize((max(1, int(round(im.width * s))), max(1, int(round(im.height * s)))),
                     Image.LANCZOS)


def variants_sheet():
    atlas = Image.open(ATLAS).convert('RGBA')
    meta = json.load(open(META))
    f_h, f_s = font(24), font(34)
    label = {'a': 'A — главный дом с фонарём на коньке',
             'b': 'B — дом с навесом, плетнём и кадкой',
             'c': 'C — дом со звонницей в щипце'}

    tiles = []
    for v in ('a', 'b', 'c'):
        im = Image.open(os.path.join(OUT, 'th_%s_0.png' % v)).convert('RGBA')
        tiles.append((v, im))

    # эталон для сравнения стиля
    ref_names = ['tree_oak_0', 'tree_pine_0', 'bush_0', 'rock_boulder_0']
    refs = [atlas_frame(meta, atlas, n)[0] for n in ref_names]

    pad, gap = 26, 30
    tile_w = max(im.width for _, im in tiles)
    tile_h = max(im.height for _, im in tiles)
    ref_h = max(r.height for r in refs)
    W = pad * 2 + 4 * (tile_w // 2 + gap) + 300
    H = pad + 60 + ref_h + 70 + 60 + tile_h + 60
    canvas = checker(W, H)
    d = ImageDraw.Draw(canvas)

    y = pad
    d.text((pad, y), 'ЭТАЛОН СТИЛЯ — объекты из атласа mapgen2', font=f_h, fill=(25, 25, 25))
    y += 46
    x = pad
    for r, nm in zip(refs, ['дуб', 'сосна', 'куст', 'валун']):
        canvas.paste(r, (x, y), r)
        d.text((x, y + r.height + 4), nm, font=font(18), fill=(60, 60, 60))
        x += r.width + gap

    y += ref_h + 74
    d.text((pad, y), 'РАТУША — три варианта одного здания (4 x 3 клетки)', font=f_h,
           fill=(25, 25, 25))
    y += 46
    x = pad
    for v, im in tiles:
        canvas.paste(im, (x, y), im)
        d.text((x, y + im.height + 6), label[v], font=font(21), fill=(30, 30, 30))
        x += im.width + gap

    canvas.convert('RGB').save(os.path.join(OUT, 'final_variants.png'))
    print('final_variants.png %dx%d' % (canvas.width, canvas.height))


def map_mock():
    """Проба на карте в честном масштабе: 1 клетка = 64 px.

    Масштаб ратуши берётся строго из проекции: пятно застройки 4 x 3 клетки
    обязано лечь ровно в 4 клетки карты по ширине ромба.
    """
    sys.path.insert(0, HERE)
    import geom
    atlas = Image.open(ATLAS).convert('RGBA')
    meta = json.load(open(META))
    TILE = 64
    CELL = TILE / 2.0
    W, H = 1240, 800
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    rnd = random.Random(11)
    OX, OY = 620, 330                       # экранная точка центра пятна

    def tile_xy(gx, gy):
        return OX + (gx - gy) * CELL, OY + (gx + gy) * CELL / 2

    def diamond(cx, cy, fill, outline=None):
        pts = [(cx, cy - CELL / 2), (cx + CELL, cy), (cx, cy + CELL / 2), (cx - CELL, cy)]
        d.polygon(pts, fill=fill, outline=outline)

    for iy in range(18):
        for ix in range(28):
            sx, sy = tile_xy(ix - 6, iy - 8)
            if 0 < sx < W and 0 < sy < H:
                t = rnd.uniform(-9, 9)
                diamond(sx, sy, (int(124 + t), int(170 + t), int(98 + t), 255))
    # пятно застройки 4 x 3 — утоптанная земля, видно, что дом встаёт ровно в него
    for iy in range(3):
        for ix in range(4):
            sx, sy = tile_xy(ix, iy)
            d.polygon([(sx, sy - CELL / 2), (sx + CELL, sy),
                       (sx, sy + CELL / 2), (sx - CELL, sy)],
                      fill=(158, 138, 102, 255), outline=(120, 104, 76, 160))

    def paste_frame(name, wx, wy, scale):
        fr, f = atlas_frame(meta, atlas, name)
        fr = scaled(fr, scale)
        canvas.alpha_composite(fr, (int(wx - f['anchorX'] * scale),
                                    int(wy - f['anchorY'] * scale)))

    # ратуша: масштаб из проекции пятна, а не «на глаз». По осям он разный:
    # у карты клетка проецируется как ромб 2:1 (sin = 0.5), а камера рендера
    # поднята на 35.2644° (sin = 0.5774). Пятно 4 x 3 клетки занимает по экрану
    # 4 * CELL пикселей, значит масштаб по X — 4*CELL / base_px, а по Y он
    # меньше ровно на отношение синусов. Тянуть спрайт одинаково по обеим
    # осям — значит уронить основание мимо пятна на 15 %.
    th = Image.open(os.path.join(OUT, 'th_a_0.png')).convert('RGBA')
    spr = json.load(open(os.path.join(OUT, 'sprites.json')))['frames']['townhall_a_0']
    xl, _ = geom.project(-2.0, 0.0, 0.0)
    xr, _ = geom.project(2.0, 0.0, 0.0)
    _, yt = geom.project(0.0, -1.5, 0.0)
    _, yb = geom.project(0.0, 1.5, 0.0)
    depth_px = yb - yt
    base_px = xr - xl
    # контроль сетки: соседние клетки через CELL px по X и CELL/2 по Y (ромб 2:1),
    # а клетка идёт по X = TILE, то есть CELL = TILE/2
    dx = tile_xy(4, 0)[0] - tile_xy(0, 0)[0]
    dy = tile_xy(0, 4)[1] - tile_xy(0, 0)[1]
    assert abs(dx - 4 * CELL) < 1e-6 and abs(dy - 2 * CELL) < 1e-6, (dx, dy)
    assert abs(CELL - TILE / 2) < 1e-6, CELL
    sx = (4 * CELL) / base_px
    sy = sx * math.sin(math.radians(30.0)) / math.sin(geom.EL)
    th_s = th.resize((max(1, int(round(th.width * sx))), max(1, int(round(th.height * sy)))),
                     Image.LANCZOS)
    # центр пятна на карте: между центрами клеток (0,0)..(3,2)
    cx, cy = tile_xy(1.5, 1.0)
    canvas.alpha_composite(th_s, (int(cx - spr['anchorX'] * sx),
                                  int(cy - spr['anchorY'] * sy)))

    tree_s = (1.5 * TILE) / 107.0
    for (gx, gy, nm, kind) in [(7, 6, 'tree_oak_0', 'tree'), (8.6, 4.2, 'tree_pine_0', 'tree'),
                               (5.4, 9.4, 'tree_birch_0', 'tree'), (10.4, 7.6, 'tree_autumn_0', 'tree'),
                               (5.8, 6.4, 'bush_berry_0', 'bush'), (9.6, 9.8, 'bush_0', 'bush'),
                               (11.6, 5.0, 'rock_cluster_0', 'rock'), (4.2, 8.0, 'rock_boulder_0', 'rock')]:
        x, y = tile_xy(gx, gy)
        sc = tree_s if kind == 'tree' else (0.7 * TILE) / 74.0
        paste_frame(nm, x, y, sc)

    canvas.convert('RGB').save(os.path.join(OUT, 'final_map.png'))
    assert abs(base_px * sx - 4 * CELL) < 1.0, 'ширина пятна разошлась'
    # контроль ромба 2:1 на самих клетках: шаг по X = 2 шага по Y
    assert abs(dx / 2 - dy) < 1e-6, (dx, dy)
    print('final_map.png %dx%d  масштаб ратуши X %.4f Y %.4f  ширина пятна %.0f px = 4 клетки (%d px)  спрайт %dx%d' % (
        canvas.width, canvas.height, sx, sy, base_px * sx, 4 * CELL, th_s.width, th_s.height))
    print('  (те же числа, что в генераторе: js/buildings.js, scaleAt)')


if __name__ == '__main__':
    variants_sheet()
    map_mock()
