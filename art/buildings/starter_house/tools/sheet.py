"""sheet.py — листы осмотра: повороты, крупные планы, эталон рядом с моделью.

    $PY3 tools/sheet.py

Три листа, без которых осмотр не осмотр:
  1. `out/sh_rotations.png` — четыре поворота в одном листе: силуэт, симметрия,
     где что видно;
  2. `out/sh_closeups.png` — три крупных плана из ЖИВОГО Blender: вход, цоколь
     по периметру, низ ската кровли (недомощенный кусок и обрешётка);
  3. `out/sh_vs_townhall.png` — ЭТАЛОН РЯДОМ: спрайт ратуши из атласа игры и
     спрайт дома в ОДНОМ масштабе мира (кадр ратуши снят при 80 ppu, поэтому
     масштабируется в 96/80 = 1.2), оба посажены на свою точку опоры.

Лист — повод посмотреть, а не доказательство: доказательство — вывод гейта.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Атлас ратуши ищется от места файла, а не абсолютным путём: абсолютный
# ломается при первом же переезде репозитория и ломается молча
# (docs/STRUCTURE.md §6.2). Уровни: tools -> starter_house -> buildings -> art.
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
ATLAS = os.path.join(REPO, 'mapgen2', 'assets', 'townhall', 'atlas.png')
ATLAS_JSON = os.path.join(REPO, 'mapgen2', 'assets', 'townhall', 'atlas.json')
LABEL = (24, 24, 24)


def font(size=22):
    for p in ('/System/Library/Fonts/Supplemental/Arial.ttf',
              '/System/Library/Fonts/Helvetica.ttc'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def paste_center(canvas, img, cx, cy):
    canvas.alpha_composite(img, (int(cx - img.width / 2),
                                 int(cy - img.height / 2)))


def sheet_rotations(rots, out_path):
    ims = [Image.open(p).convert('RGBA') for p in rots]
    w = sum(i.width for i in ims) + 20 * (len(ims) + 1)
    h = max(i.height for i in ims) + 70
    canvas = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    d = ImageDraw.Draw(canvas)
    f = font(24)
    x = 20
    for im, name in zip(ims, ('0°', '90°', '180°', '270°')):
        canvas.alpha_composite(im, (x, 50))
        d.text((x + im.width // 2 - 20, 14), name, fill=LABEL, font=f)
        x += im.width + 20
    canvas.convert('RGB').save(out_path)
    return out_path


def sheet_vs_reference(model_png, model_json, out_path, variant='a', rot=0):
    """Эталон (ратуша из игры) рядом с домом: один ракурс, один масштаб мира."""
    meta = json.load(open(ATLAS_JSON, encoding='utf-8'))
    fr = meta['frames']['townhall_%s_%d' % (variant, rot)]
    atlas = Image.open(ATLAS).convert('RGBA')
    ref = atlas.crop((fr['x'], fr['y'], fr['x'] + fr['w'], fr['y'] + fr['h']))
    k = 96.0 / float(meta.get('ppu', 80.0))          # кадр ратуши снят при 80 ppu
    ref = ref.resize((int(ref.width * k), int(ref.height * k)), Image.LANCZOS)
    mine = Image.open(model_png).convert('RGBA')

    # посадка по ТОЧКЕ ОПОРЫ: у эталона это anchorX/anchorY кадра атласа, у
    # дома — то, что записал композитор.
    ref_anchor = (fr['anchorX'] * k, fr['anchorY'] * k)
    sprites = json.load(open(model_json, encoding='utf-8'))
    my_anchor = sprites['frames'][
        os.path.splitext(os.path.basename(model_png))[0]]['anchor']

    # Раскладка: эталон слева, дом справа, опоры на одной линии.
    y_common = max(ref_anchor[1], my_anchor[1]) + 40
    ref_pos = (30.0, y_common - ref_anchor[1])
    my_pos = (float(30 + ref.width + 70), y_common - my_anchor[1])
    W = int(30 + ref.width + 70 + mine.width + 30)
    H = int(y_common + max(ref.height - ref_anchor[1],
                           mine.height - my_anchor[1]) + 60)
    canvas = Image.new('RGBA', (W, H), (255, 255, 255, 255))
    canvas.alpha_composite(ref, (int(ref_pos[0]), int(ref_pos[1])))
    canvas.alpha_composite(mine, (int(my_pos[0]), int(my_pos[1])))
    d = ImageDraw.Draw(canvas)
    f = font(26)
    d.text((int(ref_pos[0]) + 10, 12), 'РАТУША (эталон)', fill=LABEL, font=f)
    d.text((int(my_pos[0]) + 10, 12), 'ДОМ (ранняя стадия)', fill=LABEL, font=f)
    d.line((20, int(y_common), W - 20, int(y_common)),
           fill=(200, 60, 60, 255), width=2)
    d.text((24, int(y_common) + 6), 'середина пятна застройки',
           fill=(200, 60, 60), font=font(18))
    canvas.convert('RGB').save(out_path)
    return out_path


def sheet_closeups(paths, out_path):
    ims = [Image.open(p).convert('RGBA') for p in paths]
    titles = ('вход: дверь в проёме', 'цоколь по периметру', 'низ ската: стропила')
    w = sum(i.width for i in ims) + 20 * (len(ims) + 1)
    h = max(i.height for i in ims) + 70
    canvas = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    d = ImageDraw.Draw(canvas)
    f = font(22)
    x = 20
    for im, t in zip(ims, titles):
        canvas.alpha_composite(im, (x, 50))
        d.text((x + 8, 16), t, fill=LABEL, font=f)
        x += im.width + 20
    canvas.convert('RGB').save(out_path)
    return out_path


if __name__ == '__main__':
    out = os.path.join(ROOT, 'out')
    rots = [os.path.join(out, 'sh_%d.png' % r) for r in (0, 90, 180, 270)]
    print(sheet_rotations(rots, os.path.join(out, 'sh_rotations.png')))
    cups = [os.path.join(ROOT, 'renders', n) for n in
            ('cu_door.png', 'cu_plinth.png', 'cu_eave.png')]
    cups = [p for p in cups if os.path.exists(p)]
    if cups:
        print(sheet_closeups(cups, os.path.join(out, 'sh_closeups.png')))
    print(sheet_vs_reference(os.path.join(out, 'sh_0.png'),
                             os.path.join(out, 'sh_sprites.json'),
                             os.path.join(out, 'sh_vs_townhall.png')))
