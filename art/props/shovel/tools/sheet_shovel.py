"""Листы сверки: лопата рядом с эталонными спрайтами атласа при одном ppu.

    python3 tools/sheet_shovel.py [--variants a,b,c] [--scale 4]

Собирает три листа в out/:
  sheet_style.png    эталон атласа (валуны, камешек, куст — кадры ×4) и лопата
                     (ppu 384, 1:1) в два ряда: один масштаб, одна линия земли;
  sheet_ref.png      весь ряд эталона плюс лопата и топор проекта — видно, что
                     инструмент живёт в том же мире и той же палитре;
  sheet_var.png      варианты лопаты по поворотам, кадр 4x.

Числа ловит стиль-гейт, а этот лист — то, чего числа не ловят: читается ли
объект силуэтом и не выбивается ли из соседей по атласу.
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Корень 4tox — три уровня вверх от проекта (docs/STRUCTURE.md).
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
ATLAS = os.path.join(REPO, 'mapgen2', 'assets', 'sprites')
OUT = os.path.join(ROOT, 'out')
AXE_OUT = os.path.join(REPO, 'art', 'props', 'axe', 'out')

# Кадры эталона: имя, подпись
REF = [
    ('tree_pine_0', 'ель'),
    ('tree_oak_0', 'дуб'),
    ('tree_birch_0', 'берёза'),
    ('rock_cluster_0', 'валуны'),
    ('rock_boulder_0', 'валун'),
    ('rock_pebble_0', 'камешек'),
    ('ore_iron_0', 'руда'),
    ('bush_0', 'куст'),
]
BG = (247, 245, 240, 255)
GROUND = (196, 190, 178, 255)
INK = (40, 40, 44, 255)
NAMES = {'a': 'a — железный штык, 0.62 юнита',
         'b': 'b — деревянный штык',
         'c': 'c — железный, длинная рукоять 0.71'}


def font(size):
    for path in ('/System/Library/Fonts/Supplemental/Arial.ttf',
                 '/System/Library/Fonts/Helvetica.ttc',
                 '/Library/Fonts/Arial.ttf'):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def atlas_frame(name, scale):
    atlas = Image.open(os.path.join(ATLAS, 'atlas.png')).convert('RGBA')
    meta = json.load(open(os.path.join(ATLAS, 'atlas.json')))
    f = meta['frames'][name]
    im = atlas.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
    im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    return im, f['anchorX'] * scale, f['anchorY'] * scale


def mine_frames():
    return json.load(open(os.path.join(OUT, 'shovel_sprites@4x.json')))['frames']


def mine_item(key, label, frames):
    f = frames.get(key)
    if not f:
        return None
    im = Image.open(os.path.join(OUT, f['file'])).convert('RGBA')
    return (label, im, f['anchorX'], f['anchorY'], True)


def axe_item():
    """Топор проекта — сосед по классу: та же палитра, тот же свет, тот же ppu.

    Берём кадр @4x (ppu 384), а не 1x: иначе топор на листе стоит вчетверо
    мельче лопаты и сравнение масштабов врёт.
    """
    meta = os.path.join(AXE_OUT, 'axe_sprites@4x.json')
    path = os.path.join(AXE_OUT, 'axe_b_0@4x.png')
    if not (os.path.exists(meta) and os.path.exists(path)):
        return None
    f = json.load(open(meta))['frames']['axe_b_0']
    im = Image.open(path).convert('RGBA')
    return ('топор b (проект, ppu 384)', im, f['anchorX'], f['anchorY'], False)


def sheet_style(variants):
    """Эталон атласа и лопата в два ряда, ОДИН масштаб, одна линия земли."""
    top, bot = [], []
    for name, label in (('rock_boulder_0', 'валун (эталон)'),
                        ('rock_pebble_0', 'камешек (эталон)'),
                        ('ore_iron_0', 'руда (эталон)')):
        im, ax, ay = atlas_frame(name, 4)
        top.append((label, im, ax, ay, False))
    frames = mine_frames()
    for var in variants:
        it = mine_item('shovel_%s_0' % var, 'лопата %s (ppu 384)' % var, frames)
        if it:
            bot.append(it)
    it = axe_item()
    if it:
        bot.append(it)

    pad, lead, bottom = 56, 300, 60
    w = lead + max(sum(i[1].width + pad for i in row) for row in (top, bot))
    up1 = max(ay for _, _, _, ay, _ in top)
    dn1 = max(im.height - ay for _, im, _, ay, _ in top)
    up2 = max(ay for _, _, _, ay, _ in bot)
    dn2 = max(im.height - ay for _, im, _, ay, _ in bot)
    h = int(54 + up1 + dn1 + 86 + up2 + dn2 + bottom)
    w = int(w)
    canvas = Image.new('RGBA', (w, h), BG)
    d = ImageDraw.Draw(canvas)
    f_head, f_lab = font(26), font(19)
    d.text((pad, 14), 'ЭТАЛОН АТЛАСА (кадры ×4) И ЛОПАТА (ppu 384) — ОДИН МАСШТАБ',
           font=f_head, fill=INK)

    g1 = 54 + up1
    d.line([(0, g1), (w, g1)], fill=GROUND, width=2)
    d.text((pad, g1 + dn1 + 10), 'эталон', font=f_lab, fill=INK)
    x = lead
    for label, im, ax, ay, _ in top:
        canvas.alpha_composite(im, (int(x - ax), int(g1 - ay)))
        d.text((x + (im.width - f_lab.getlength(label)) / 2, g1 + 12), label,
               font=f_lab, fill=INK)
        x += im.width + pad

    g2 = g1 + dn1 + 76 + up2
    d.line([(0, g2), (w, g2)], fill=GROUND, width=2)
    d.text((pad, g2 + dn2 + 14), 'проект', font=f_lab, fill=INK)
    x = lead
    for label, im, ax, ay, _ in bot:
        canvas.alpha_composite(im, (int(x - ax), int(g2 - ay)))
        d.text((x + (im.width - f_lab.getlength(label)) / 2, g2 + 12), label,
               font=f_lab, fill=INK)
        x += im.width + pad
    path = os.path.join(OUT, 'sheet_style.png')
    canvas.convert('RGB').save(path)
    print('SHEET %s %dx%d' % (path, w, h))


def sheet_ref(scale, variants):
    """Весь ряд эталона плюс лопата и топор: одна линия земли, один масштаб."""
    items = []
    for name, label in REF:
        im, ax, ay = atlas_frame(name, scale)
        items.append((label, im, ax, ay, False))
    it = axe_item()
    if it:
        items.append(it)
    frames = mine_frames()
    for var in variants:
        for rot in (0, 90, 180, 270):
            got = mine_item('shovel_%s_%d' % (var, rot),
                            'лопата %s %d°' % (var, rot), frames)
            if got:
                items.append(got)

    pad_x, top, bottom = 26, 96, 74
    up = max(ay for _, _, _, ay, _ in items)
    down = max(im.height - ay for _, im, _, ay, _ in items)
    ground_y = int(top + up)
    w = pad_x
    for _, im, _, _, _ in items:
        w += im.width + pad_x
    h = int(ground_y + down + bottom)
    canvas = Image.new('RGBA', (w, h), BG)
    d = ImageDraw.Draw(canvas)
    d.line([(0, ground_y), (w, ground_y)], fill=GROUND, width=2)
    f_lab, f_head = font(20), font(26)
    d.text((pad_x, 16), 'ЭТАЛОН АТЛАСА (ppu 96, кадры ×%d) → ИНСТРУМЕНТЫ (ppu 384, 1:1)'
           % scale, font=f_head, fill=INK)
    x = pad_x
    for label, im, ax, ay, is_mine in items:
        if is_mine:
            d.rectangle([x - 8, top - 34, x + im.width + 8, ground_y + 8],
                        outline=(206, 120, 96, 255), width=3)
        canvas.alpha_composite(im, (int(round(x - ax)), int(round(ground_y - ay))))
        d.text((x, ground_y + 12), label, font=f_lab, fill=INK)
        x += im.width + pad_x
    path = os.path.join(OUT, 'sheet_ref.png')
    canvas.convert('RGB').save(path)
    print('SHEET %s %dx%d' % (path, w, h))


def sheet_variants(variants):
    frames = mine_frames()
    rows = []
    for var in variants:
        row = []
        for rot in (0, 90, 180, 270):
            got = mine_item('shovel_%s_%d' % (var, rot), '', frames)
            if got:
                row.append(got[1])
        if row:
            rows.append((var, row))
    if not rows:
        return
    pad, label_w, top, bottom = 26, 300, 58, 20
    title = 'ЛОПАТА: варианты и повороты (кадр 4x, ppu 384, вид пайплайна)'
    f_head, f_lab = font(24), font(20)
    row_h = [max(im.height for im in row) for _, row in rows]
    w = max(label_w + sum(im.width + pad for im in rows[0][1]) + pad,
            int(f_head.getlength(title)) + 2 * pad)
    h = top + sum(hh + pad for hh in row_h) + bottom
    canvas = Image.new('RGBA', (w, h), BG)
    d = ImageDraw.Draw(canvas)
    d.text((pad, 16), title, font=f_head, fill=INK)
    y = top
    for (var, row), hh in zip(rows, row_h):
        d.text((pad, y + hh // 2 - 12), NAMES.get(var, var), font=f_lab, fill=INK)
        x = label_w
        for im in row:
            canvas.alpha_composite(im, (x, y + hh - im.height))
            x += im.width + pad
        y += hh + pad
    path = os.path.join(OUT, 'sheet_var.png')
    canvas.convert('RGB').save(path)
    print('SHEET %s %dx%d' % (path, w, h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants', default='a,b,c')
    ap.add_argument('--scale', type=int, default=4)
    ap.add_argument('--only', default='all')
    args = ap.parse_args()
    variants = args.variants.split(',')
    if args.only in ('all', 'style'):
        sheet_style(variants)
    if args.only in ('all', 'ref'):
        sheet_ref(args.scale, variants)
    if args.only in ('all', 'var'):
        sheet_variants(variants)


if __name__ == '__main__':
    main()
