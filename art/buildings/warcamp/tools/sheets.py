"""sheets.py — листы осмотра военного лагеря.

    $PY3 tools/sheets.py

Три листа по протоколу `3d-model-acceptance` §2 шаг 4:

  * `out/sheet_warcamp.png` — 4 поворота одним листом;
  * `renders/closeups_warcamp.png` — крупные планы знамени, костра, стойки и
    поленницы (у двора нет двери/цоколя/карниза — смотрим его узлы);
  * `out/warcamp_vs_village.png` — ратуша, дом жителя, лагерь лесоруба и
    военный лагерь в ОДНОМ масштабе «одна клетка = 64 px».  Крупность `mul` у
    построек разная, поэтому без поправки на `mul` сравнение силуэтов врёт;
    проекция изометрии даёт 1 юнит = ppu·cos45 px, отсюда делитель cos45.

Файлы только для глаза: чисел приёмки здесь нет, они в `acc/`.
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')

CELL_PX = 64.0
COS_AZ = math.cos(math.radians(45.0))
FONT_PATH = ('/System/Library/Fonts/Supplemental/Arial.ttf'
             if os.path.exists('/System/Library/Fonts/Supplemental/Arial.ttf')
             else None)


def font(size=16):
    return (ImageFont.truetype(FONT_PATH, size) if FONT_PATH
            else ImageFont.load_default())


def frame(atlas_dir, name):
    """(картинка кадра, ppu, mul) из атласа игры."""
    with open(os.path.join(GAME, 'assets', atlas_dir, 'atlas.json'),
              encoding='utf-8') as fh:
        meta = json.load(fh)
    img = Image.open(os.path.join(GAME, 'assets', atlas_dir,
                                  meta['atlas'])).convert('RGBA')
    f = meta['frames'][name]
    crop = img.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
    return crop, meta['ppu'], meta.get('mul', 1.0)


def scaled(im, k):
    return im.resize((max(1, int(round(im.width * k))),
                      max(1, int(round(im.height * k)))), Image.LANCZOS)


def on_white(im):
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    return bg.convert('RGB')


def tight(im, pad=4):
    bb = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bb:
        return im
    x0, y0, x1, y1 = bb
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(im.width, x1 + pad), min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1))


def rotations_sheet(out_path):
    ims = []
    for rot in (0, 90, 180, 270):
        crop, _, _ = frame('warcamp', 'wc_%d' % rot)
        ims.append(scaled(crop, 0.62))
    pad = 12
    W = sum(i.width for i in ims) + pad * (len(ims) + 1)
    H = max(i.height for i in ims) + 52
    sheet = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    x = pad
    for i, rot in enumerate((0, 90, 180, 270)):
        sheet.paste(on_white(ims[i]), (x, 34))
        d.text((x + 4, 7), 'военный лагерь, поворот %d' % rot,
               fill=(40, 40, 40), font=font(17))
        x += ims[i].width + pad
    sheet.save(out_path)
    return out_path


def closeups(out_path, rot=90):
    """Четыре узла из кадра @4x: знамя, костёр, стойка, поленница."""
    crop = Image.open(os.path.join(ROOT, 'out',
                                   'wc_%d@4x.png' % rot)).convert('RGBA')
    crop = tight(crop, 8)
    W, H = crop.size
    boxes = [
        ('знамя и каменное основание', (0.42, 0.00, 0.95, 0.56)),
        ('костёр, котёл и тренога', (0.30, 0.30, 0.90, 0.86)),
        ('стойка, копья и щиты', (0.00, 0.10, 0.48, 0.68)),
        ('поленница у костра', (0.12, 0.70, 0.62, 1.00)),
    ]
    tiles = []
    for name, (x0, y0, x1, y1) in boxes:
        sub = crop.crop((int(x0 * W), int(y0 * H),
                         int(x1 * W), int(y1 * H)))
        k = min(1.0, 560.0 / max(sub.width, sub.height))
        tiles.append((name, scaled(sub, k)))
    pad = 12
    cols = 2
    rows = (len(tiles) + cols - 1) // cols
    cw = max(t[1].width for t in tiles) + pad
    ch = max(t[1].height for t in tiles) + 38
    Tw = cols * cw + pad
    Th = rows * ch + 10
    sheet = Image.new('RGB', (Tw, Th), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(tiles):
        col, row = i % cols, i // cols
        x = pad + col * cw
        y = 28 + row * ch
        sheet.paste(on_white(im), (x, y))
        d.text((x + 2, y - 23), 'военный лагерь: %s' % name,
               fill=(40, 40, 40), font=font(16))
    sheet.save(out_path)
    return out_path


def neighbours_sheet(out_path):
    """Эталон рядом: ратуша, дом, лагерь лесоруба и военный лагерь."""
    items = [('townhall', 'townhall_a_0', 'ратуша — эталон'),
             ('starter_house', 'sh_a_0', 'дом жителя'),
             ('lumbercamp', 'lc_a_0', 'лагерь лесоруба'),
             ('warcamp', 'wc_90', 'ВОЕННЫЙ ЛАГЕРЬ')]
    tiles = []
    for atlas_dir, name, label in items:
        crop, ppu, mul = frame(atlas_dir, name)
        crop = tight(crop, 6)
        # 1 клетка = CELL_PX: в кадре 1 юнит по X/Y даёт ppu*cos45 px.
        k = mul * CELL_PX / (ppu * COS_AZ)
        tiles.append((label, scaled(crop, k)))
    pad = 18
    Tw = sum(t[1].width for t in tiles) + pad * (len(tiles) + 1)
    Th = max(t[1].height for t in tiles) + 62
    sheet = Image.new('RGB', (Tw, Th), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    x = pad
    for label, im in tiles:
        sheet.paste(on_white(im), (x, 44))
        d.text((x + 2, 7), label, fill=(40, 40, 40), font=font(18))
        x += im.width + pad
    d.text((pad, Th - 22),
           'масштаб: 1 клетка = %d px у всех; у военного лагеря видимое '
           'основание 2 x 2, площадка 5 x 5 остаётся пустой под воинов'
           % CELL_PX, fill=(90, 90, 90), font=font(14))
    sheet.save(out_path)
    return out_path


def main():
    out = os.path.join(ROOT, 'out')
    ren = os.path.join(ROOT, 'renders')
    os.makedirs(out, exist_ok=True)
    os.makedirs(ren, exist_ok=True)
    print(rotations_sheet(os.path.join(out, 'sheet_warcamp.png')))
    print(closeups(os.path.join(ren, 'closeups_warcamp.png')))
    print(neighbours_sheet(os.path.join(out, 'warcamp_vs_village.png')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
