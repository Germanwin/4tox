"""sheets.py — листы осмотра: 4 поворота, крупные планы, «эталон рядом».

    $PY3 tools/sheets.py

Глазами смотреть обязательно, но по протоколу (`3d-model-acceptance`, §2 шаг 4):
    * 4 поворота ОДНИМ листом — силуэт и симметрия;
    * крупные планы входа, цоколя и нижнего края ската — там, где врут «на
      глаз»: дверь мимо проёма, щель под карнизом, цоколь из стены;
    * ЭТАЛОН РЯДОМ — ратуша, дом жителя и лагерь в одном кадре с казармой и
      В ОДНОМ МАСШТАБЕ «одна клетка = 64 px» (крупность `mul` у построек
      разная: 0.7667 у ратуши и казармы, 0.7156 у дома и лагеря; без поправки
      на `mul` сравнение силуэтов врёт).

Файлы кладутся в `out/` (листы) и `renders/` (крупные планы).  Числа в отчёт
берутся не отсюда — здесь только повод посмотреть.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')

CELL_PX = 64.0          # «одна клетка = 64 px» — общий масштаб листов сверки
# Шрифт с кириллицей: штатный шрифт PIL рисует русские подписи квадратиками.
FONT_PATH = ('/System/Library/Fonts/Supplemental/Arial.ttf'
             if os.path.exists('/System/Library/Fonts/Supplemental/Arial.ttf')
             else None)


def font(size=16):
    return ImageFont.truetype(FONT_PATH, size) if FONT_PATH else ImageFont.load_default()


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


def rotations_sheet(var, out_path):
    ims = []
    for rot in (0, 90, 180, 270):
        crop, _, _ = frame('barracks', 'br_%s_%d' % (var, rot))
        ims.append(scaled(crop, 0.62))
    pad = 12
    W = sum(i.width for i in ims) + pad * (len(ims) + 1)
    H = max(i.height for i in ims) + 48
    sheet = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    x = pad
    for i, rot in enumerate((0, 90, 180, 270)):
        sheet.paste(on_white(ims[i]), (x, 30))
        d.text((x + 4, 6), 'казарма %s, поворот %d' % (var, rot),
               fill=(40, 40, 40), font=font(17))
        x += ims[i].width + pad
    sheet.save(out_path)
    return out_path


def closeups(var, out_path, rot=0):
    """Три крупных плана из кадра @4x: вход, цоколь, низ ската.

    Кадр @4x в атлас не входит (атлас — 1x), поэтому файл читается прямо из
    `out/`, а окна обрезки считаются от СИЛУЭТА, а не от рамки: у спрайта
    большие прозрачные поля под рамку и точку опоры.
    """
    crop = Image.open(os.path.join(ROOT, 'out',
                                   'br_%s_%d@4x.png' % (var, rot))).convert('RGBA')
    bb = crop.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    crop = crop.crop(bb)
    W, H = crop.size
    # окна обрезки — доли кадра; подобраны по кадру 0 (вход слева от середины)
    if var == 'a':
        boxes = [('вход и приступок', (0.34, 0.50, 0.66, 0.86)),
                 ('цоколь и шов', (0.10, 0.66, 0.52, 0.98)),
                 ('низ ската и лобовая доска', (0.06, 0.20, 0.50, 0.56))]
    else:
        # у b слева стоит навес: вход смотрим правее, низ ската — по корпусу
        boxes = [('вход и приступок', (0.40, 0.52, 0.72, 0.88)),
                 ('цоколь, шов и столбы навеса', (0.08, 0.62, 0.55, 0.98)),
                 ('низ ската корпуса', (0.42, 0.18, 0.90, 0.52))]
    tiles = []
    for name, (x0, y0, x1, y1) in boxes:
        sub = crop.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)))
        k = min(1.0, 620.0 / max(sub.width, sub.height))
        tiles.append((name, scaled(sub, k)))
    pad = 10
    Tw = sum(t[1].width for t in tiles) + pad * (len(tiles) + 1)
    Th = max(t[1].height for t in tiles) + 40
    sheet = Image.new('RGB', (Tw, Th), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    x = pad
    for name, im in tiles:
        sheet.paste(on_white(im), (x, 26))
        d.text((x + 2, 5), 'казарма %s: %s' % (var, name), fill=(40, 40, 40),
               font=font(17))
        x += im.width + pad
    sheet.save(out_path)
    return out_path


def neighbours_sheet(out_path):
    """Эталон рядом: ратуша, дом, лагерь и казарма в одном масштабе клетки."""
    items = [('townhall', 'townhall_a_0', 'ратуша — эталон'),
             ('starter_house', 'sh_a_0', 'дом жителя'),
             ('lumbercamp', 'lc_a_0', 'лагерь'),
             ('barracks', 'br_a_0', 'КАЗАРМА a'),
             ('barracks', 'br_b_0', 'КАЗАРМА b')]
    tiles = []
    for atlas_dir, name, label in items:
        crop, ppu, mul = frame(atlas_dir, name)
        k = mul * CELL_PX / ppu          # одна клетка = CELL_PX px у всех
        tiles.append((label, scaled(crop, k)))
    pad = 18
    Tw = sum(t[1].width for t in tiles) + pad * (len(tiles) + 1)
    Th = max(t[1].height for t in tiles) + 44
    sheet = Image.new('RGB', (Tw, Th), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    x = pad
    for label, im in tiles:
        sheet.paste(on_white(im), (x, 30))
        d.text((x + 2, 7), label, fill=(40, 40, 40), font=font(18))
        x += im.width + pad
    d.text((Tw - 260, 7), 'масштаб: 1 клетка = %d px у всех' % CELL_PX,
           fill=(90, 90, 90), font=font(15))
    sheet.save(out_path)
    return out_path


def main():
    out = os.path.join(ROOT, 'out')
    ren = os.path.join(ROOT, 'renders')
    os.makedirs(out, exist_ok=True)
    os.makedirs(ren, exist_ok=True)
    for var in ('a', 'b'):
        print(rotations_sheet(var, os.path.join(out, 'sheet_br_%s.png' % var)))
        print(closeups(var, os.path.join(ren, 'closeups_br_%s.png' % var)))
    print(neighbours_sheet(os.path.join(out, 'br_vs_village.png')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
