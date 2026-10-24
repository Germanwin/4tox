# -*- coding: utf-8 -*-
"""Доказательства для глазами-проверки: кадры в игре и лист «было/стало».

Не участвует в сборке текстуры. Берёт кадры приёмки (`mapgen2/tools/out/`)
и складывает их в `out/`, чтобы результат можно было открыть без запуска игры.

    python3 tools/make_sheets.py
"""

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
PROJ = os.path.join(ROOT, 'art', 'textures', 'plot_grass')
OUT = os.path.join(PROJ, 'out')
GROUND = os.path.join(ROOT, 'mapgen2', 'tools', 'out', 'ground')
NEW_FRAME = os.path.join(GROUND, 'трава-песок-96-village.png')
OLD_SHEET = os.path.join(GROUND, 'turf-before-after.png')

HEAD = 58
GAP = 10
BG = (23, 48, 23)
FG = (233, 245, 223)
FONT_PATH = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


def header(w, text):
    strip = Image.new('RGB', (w, HEAD), BG)
    d = ImageDraw.Draw(strip)
    f = font(26)
    box = d.textbbox((0, 0), text, font=f)
    d.text(((w - (box[2] - box[0])) // 2, (HEAD - (box[3] - box[1])) // 2 - 2),
           text, font=f, fill=FG)
    return strip


def main():
    os.makedirs(OUT, exist_ok=True)
    frame = Image.open(NEW_FRAME).convert('RGB')

    # Сам кадр деревни — как его видит игра.
    frame.save(os.path.join(OUT, 'ingame_village.png'), optimize=True)

    # Крупный план: участок под ратушей, домом и лагерем.
    close = frame.crop((520, 200, 1040, 620)).resize((1040, 840), Image.LANCZOS)
    close.save(os.path.join(OUT, 'ingame_closeup.png'), optimize=True)

    # Панель «до» — старый дерн из кустиков (правый кадр прошлой приёмки).
    old = Image.open(OLD_SHEET).convert('RGB')
    old_panel = old.crop((738, 55, 1458, 638))

    # Панель «после» — тот же ракурс, тот же сид, новая текстура.
    new_panel = frame.crop((520, 190, 1076, 642))
    w = old_panel.width
    h = old_panel.height
    new_panel = new_panel.resize((w, h), Image.LANCZOS)

    sheet = Image.new('RGB', (w * 2 + GAP, HEAD + h), BG)
    sheet.paste(header(w, 'БЫЛО — кустики атласа'), (0, 0))
    sheet.paste(header(w, 'СТАЛО — низкая трава из Blender'), (w + GAP, 0))
    sheet.paste(old_panel, (0, HEAD))
    sheet.paste(new_panel, (w + GAP, HEAD))
    sheet.save(os.path.join(OUT, 'before_after_plot.png'), optimize=True)

    print('ingame_village.png, ingame_closeup.png, before_after_plot.png')


if __name__ == '__main__':
    main()
