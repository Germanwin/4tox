"""sheets.py — листы осмотра: все 20 кадров, «целое / руина», крупные планы.

    $PY3 tools/sheets.py

Пишет:
    out/sheet_ruins.png       — 4 поворота x 5 типов, с подписями;
    out/compare_<тип>.png    — целая постройка и руина в одном масштабе, по
                               4 поворотам, выровнены по точке опоры;
    out/closeup_house.png    — крупный план дома из кадра @4x (фронт и обвал
                               кровли) — то, что в 1x не разглядеть;
    out/closeup_warcamp.png  — крупный план лагеря (упавшее знамя) 2x.

Кадры берутся из атласа по метаданным (`atlas.json`), а не пересобираются:
лист обязан показывать ТО, что лежит в игре.
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
OUT = os.path.join(ROOT, 'out')

ROTATIONS = (0, 90, 180, 270)
TYPES = ('townhall', 'house', 'lumbercamp', 'barracks', 'warcamp')
PREFIX = {'townhall': 'townhall_a_', 'house': 'sh_a_',
          'lumbercamp': 'lc_a_', 'barracks': 'br_a_', 'warcamp': 'wc_'}


def font(size=20):
    for name in ('/System/Library/Fonts/Supplemental/Arial.ttf',
                 '/System/Library/Fonts/Helvetica.ttc',
                 '/Library/Fonts/Arial.ttf'):
        if os.path.exists(name):
            try:
                return ImageFont.truetype(name, size)
            except Exception:
                pass
    return ImageFont.load_default()


def crop_frame(atlas, fr):
    return atlas.crop((fr['x'], fr['y'], fr['x'] + fr['w'],
                       fr['y'] + fr['h']))


def load_intact(t):
    with open(os.path.join(GAME, 'assets', 'ruins', 'atlas.json'),
              encoding='utf-8') as f:
        ruins_meta = json.load(f)
    folder = ruins_meta['types'][t]['source'].split('/')[2]
    at = Image.open(os.path.join(GAME, 'assets', folder, 'atlas.png')
                    ).convert('RGBA')
    with open(os.path.join(GAME, 'assets', folder, 'atlas.json'),
              encoding='utf-8') as f:
        meta = json.load(f)
    out = {}
    for rot in ROTATIONS:
        fr = meta['frames'][PREFIX[t] + str(rot)]
        out[rot] = (crop_frame(at, fr), fr['anchorX'], fr['anchorY'])
    return out, ruins_meta


def make_sheet(ruins_meta):
    at = Image.open(os.path.join(GAME, 'assets', 'ruins', 'atlas.png')
                    ).convert('RGBA')
    cell = 360
    label_h = 28
    sheet = Image.new('RGBA', (cell * 4 + 20, (cell + label_h) * 5 + 20),
                      (34, 38, 34, 255))
    d = ImageDraw.Draw(sheet)
    f = font(18)
    for row, t in enumerate(TYPES):
        for col, rot in enumerate(ROTATIONS):
            fr = ruins_meta['frames']['%s_%d' % (t, rot)]
            img = crop_frame(at, fr)
            k = min((cell - 12) / float(img.width),
                    (cell - 12 - label_h) / float(img.height))
            img = img.resize((max(1, int(img.width * k)),
                              max(1, int(img.height * k))), Image.LANCZOS)
            x = 10 + col * cell + (cell - img.width) // 2
            y = 10 + row * (cell + label_h) + label_h + \
                (cell - label_h - img.height) // 2
            sheet.alpha_composite(img, (x, y))
            d.text((10 + col * cell + 8, 10 + row * (cell + label_h) + 4),
                   '%s_%d' % (t, rot), fill=(225, 225, 210), font=f)
    path = os.path.join(OUT, 'sheet_ruins.png')
    sheet.save(path)
    print('-> %s  %dx%d' % (path, sheet.width, sheet.height))


def make_compare(t, ruins_meta):
    intact, _ = load_intact(t)
    ruins_at = Image.open(os.path.join(GAME, 'assets', 'ruins',
                                       'atlas.png')).convert('RGBA')
    W, H = 1400, 1500
    ax, ay = 700, 820
    rows = []
    for kind in ('intact', 'ruin'):
        tiles = []
        for rot in ROTATIONS:
            if kind == 'intact':
                img, fx, fy = intact[rot]
            else:
                fr = ruins_meta['frames']['%s_%d' % (t, rot)]
                img = crop_frame(ruins_at, fr)
                fx, fy = fr['anchorX'], fr['anchorY']
            canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            canvas.alpha_composite(img, (int(round(ax - fx)),
                                         int(round(ay - fy))))
            tiles.append(canvas)
        rows.append(tiles)
    # общий контур по ПРОЗРАЧНЫМ кадрам (фон плитки не в счёт)
    union = None
    for row in rows:
        for tile in row:
            bb = tile.getchannel('A').point(
                lambda v: 255 if v > 8 else 0).getbbox()
            if bb:
                union = bb if union is None else (
                    min(union[0], bb[0]), min(union[1], bb[1]),
                    max(union[2], bb[2]), max(union[3], bb[3]))
    pad = 14
    union = (union[0] - pad, union[1] - pad, union[2] + pad, union[3] + pad)
    cw, chh = union[2] - union[0], union[3] - union[1]
    cell_w = 380
    k = cell_w / float(cw)
    cell_h = max(1, int(chh * k))
    bg = (34, 38, 34, 255)
    out = Image.new('RGBA', (cell_w * 4 + 20, (cell_h + 34) * 2 + 14), bg)
    d = ImageDraw.Draw(out)
    f = font(18)
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            cell = Image.new('RGBA', (cell_w, cell_h), bg)
            small = tile.crop(union).resize((cell_w, cell_h), Image.LANCZOS)
            cell.alpha_composite(small)
            out.alpha_composite(cell, (10 + c * cell_w,
                                       10 + r * (cell_h + 34)))
        d.text((10, 10 + r * (cell_h + 34) + cell_h + 6),
               'руина' if r else 'целая', fill=(230, 230, 210), font=f)
    path = os.path.join(OUT, 'compare_%s.png' % t)
    out.save(path)
    print('-> %s  %dx%d' % (path, out.width, out.height))


def make_closeups(ruins_meta):
    at4 = os.path.join(OUT, 'rn_house_0@4x.png')
    if os.path.exists(at4):
        img = Image.open(at4).convert('RGBA')
        fr = json.load(open(os.path.join(OUT, 'rn_house_0@4x.json'),
                            encoding='utf-8'))
        ax, ay = fr['anchor']
        box = (ax - 820, ay - 1000, ax + 420, ay + 360)
        box = (max(0, box[0]), max(0, box[1]),
               min(img.width, box[2]), min(img.height, box[3]))
        crop = img.crop(box)
        k = 900.0 / crop.width
        crop = crop.resize((900, int(crop.height * k)), Image.LANCZOS)
        bg = Image.new('RGBA', crop.size, (34, 38, 34, 255))
        bg.alpha_composite(crop)
        path = os.path.join(OUT, 'closeup_house.png')
        bg.save(path)
        print('-> %s  %dx%d' % (path, bg.width, bg.height))
    at = Image.open(os.path.join(GAME, 'assets', 'ruins',
                                 'atlas.png')).convert('RGBA')
    fr = ruins_meta['frames']['warcamp_90']
    img = crop_frame(at, fr)
    k = 2.0
    img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)
    bg = Image.new('RGBA', img.size, (34, 38, 34, 255))
    bg.alpha_composite(img)
    path = os.path.join(OUT, 'closeup_warcamp.png')
    bg.save(path)
    print('-> %s  %dx%d' % (path, bg.width, bg.height))


def main():
    with open(os.path.join(GAME, 'assets', 'ruins', 'atlas.json'),
              encoding='utf-8') as f:
        ruins_meta = json.load(f)
    make_sheet(ruins_meta)
    for t in TYPES:
        make_compare(t, ruins_meta)
    make_closeups(ruins_meta)


if __name__ == '__main__':
    main()
