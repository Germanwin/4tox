"""Листы сверки: топор рядом с эталонными спрайтами атласа при одном ppu.

    python3 tools/sheet_axe.py [--variants a,b,c] [--scale 4]

Собирает два листа в out/:
  sheet_ref.png      эталон (деревья, кусты, валуны — кадры атласа игры,
                     увеличенные в `scale` раз) и топор рядом: один масштаб,
                     одна линия земли, видно и вес контура, и размер фасетов;
  sheet_var.png      все варианты топора по поворотам, кадр 4x.
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

# Кадры эталона: имя, подпись
REF = [
    ('tree_pine_0', 'ель 1.5 юнита'),
    ('tree_oak_0', 'дуб 1.5 юнита'),
    ('tree_birch_0', 'берёза'),
    ('rock_cluster_0', 'валуны'),
    ('rock_boulder_0', 'валун'),
    ('rock_pebble_0', 'камешек'),
    ('bush_0', 'куст'),
]
BG = (247, 245, 240, 255)
GROUND = (196, 190, 178, 255)
INK = (40, 40, 44, 255)


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


def paste_anchor(canvas, im, x, y, ax, ay):
    """Поставить спрайт так, чтобы его точка опоры легла в (x, y)."""
    canvas.alpha_composite(im, (int(round(x - ax)), int(round(y - ay))))


def sheet_ref(scale, variants):
    atlas = Image.open(os.path.join(ATLAS, 'atlas.png')).convert('RGBA')
    meta = json.load(open(os.path.join(ATLAS, 'atlas.json')))
    mine = json.load(open(os.path.join(OUT, 'axe_sprites@4x.json')))

    items = []
    for name, label in REF:
        f = meta['frames'][name]
        im = atlas.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
        items.append((label, im, f['anchorX'] * scale, f['anchorY'] * scale, False))
    for var in variants:
        for rot in (0, 90, 180, 270):
            key = 'axe_%s_%d' % (var, rot)
            f = mine['frames'].get(key)
            if not f:
                continue
            im = Image.open(os.path.join(OUT, f['file'])).convert('RGBA')
            items.append(('топор %s %d°' % (var, rot), im,
                          f['anchorX'], f['anchorY'], True))

    pad_x, top, bottom = 26, 96, 74
    # высота листа: над линией земли — самый высокий «верх» спрайта (ay),
    # под ней — самый глубокий «низ» (h - ay)
    up = max(ay for _, _, _, ay, _ in items)
    down = max(im.height - ay for _, im, _, ay, _ in items)
    ground_y = int(top + up)
    W = pad_x
    for _, im, ax, _, _ in items:
        W += im.width + pad_x
    H = int(ground_y + down + bottom)
    canvas = Image.new('RGBA', (W, H), BG)
    d = ImageDraw.Draw(canvas)
    d.line([(0, ground_y), (W, ground_y)], fill=GROUND, width=2)

    f_lab, f_head = font(20), font(26)
    d.text((pad_x, 16), 'ЭТАЛОН АТЛАСА (ppu 96, кадры ×%d) → ТОПОР (ppu 384, 1:1)'
           % scale, font=f_head, fill=INK)
    x = pad_x
    for label, im, ax, ay, is_mine in items:
        if is_mine:
            d.rectangle([x - 8, top - 34, x + im.width + 8, ground_y + 8],
                        outline=(206, 120, 96, 255), width=3)
        paste_anchor(canvas, im, x, ground_y, ax, ay)
        d.text((x, ground_y + 12), label, font=f_lab, fill=INK)
        x += im.width + pad_x
    path = os.path.join(OUT, 'sheet_ref.png')
    canvas.convert('RGB').save(path)
    print('SHEET %s %dx%d' % (path, W, H))


def sheet_variants(variants):
    mine = json.load(open(os.path.join(OUT, 'axe_sprites@4x.json')))
    rows = []
    for var in variants:
        row = []
        for rot in (0, 90, 180, 270):
            f = mine['frames'].get('axe_%s_%d' % (var, rot))
            if f:
                row.append(Image.open(os.path.join(OUT, f['file'])).convert('RGBA'))
        if row:
            rows.append((var, row))
    if not rows:
        return
    pad, label_w, top, bottom = 26, 260, 58, 20
    names = {'a': 'a — железный, 0.46 юнита', 'b': 'b — каменный, обвязка',
             'c': 'c — длинная рукоять, 0.55'}
    title = 'ТОПОР: варианты и повороты (кадр 4x, ppu 384, вид пайплайна)'
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
        d.text((pad, y + hh // 2 - 12), names.get(var, var), font=f_lab, fill=INK)
        x = label_w
        for im in row:
            canvas.alpha_composite(im, (x, y + hh - im.height))
            x += im.width + pad
        y += hh + pad
    path = os.path.join(OUT, 'sheet_var.png')
    canvas.convert('RGB').save(path)
    print('SHEET %s %dx%d' % (path, w, h))


def sheet_style(variants):
    """Компактный лист: эталон атласа и топор в два ряда, один ppu."""
    atlas = Image.open(os.path.join(ATLAS, 'atlas.png')).convert('RGBA')
    meta = json.load(open(os.path.join(ATLAS, 'atlas.json')))
    mine = json.load(open(os.path.join(OUT, 'axe_sprites@4x.json')))
    scale = 4
    top_items = []
    for name, label in (('rock_boulder_0', 'валун (эталон)'),
                        ('rock_pebble_0', 'камешек (эталон)'),
                        ('bush_0', 'куст (эталон)')):
        f = meta['frames'][name]
        im = atlas.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
        top_items.append((label, im, f['anchorX'] * scale, f['anchorY'] * scale))
    bot_items = []
    for var in variants:
        f = mine['frames'].get('axe_%s_0' % var)
        if not f:
            continue
        im = Image.open(os.path.join(OUT, f['file'])).convert('RGBA')
        bot_items.append(('топор %s (ppu 384)' % var, im, f['anchorX'], f['anchorY']))

    pad, lead, bottom = 56, 300, 60
    w = lead + max(sum(i[1].width + pad for i in row) for row in (top_items, bot_items))
    up1 = max(ay for _, _, _, ay in top_items)
    dn1 = max(im.height - ay for _, im, _, ay in top_items)
    up2 = max(ay for _, _, _, ay in bot_items)
    dn2 = max(im.height - ay for _, im, _, ay in bot_items)
    h = 54 + up1 + dn1 + 86 + up2 + dn2 + bottom
    w, h = int(w), int(h)
    canvas = Image.new('RGBA', (w, h), BG)
    d = ImageDraw.Draw(canvas)
    f_head, f_lab = font(26), font(19)
    d.text((pad, 14), 'ЭТАЛОН АТЛАСА (кадры x4) И ТОПОР (ppu 384) — ОДИН МАСШТАБ',
           font=f_head, fill=INK)

    g1 = 54 + up1
    d.line([(0, g1), (w, g1)], fill=GROUND, width=2)
    d.text((pad, g1 + dn1 + 10), 'эталон', font=f_lab, fill=INK)
    x = lead
    for label, im, ax, ay in top_items:
        canvas.alpha_composite(im, (int(x - ax), int(g1 - ay)))
        d.text((x + (im.width - f_lab.getlength(label)) / 2, g1 + 12), label,
               font=f_lab, fill=INK)
        x += im.width + pad

    g2 = g1 + dn1 + 76 + up2
    d.line([(0, g2), (w, g2)], fill=GROUND, width=2)
    d.text((pad, g2 + dn2 + 14), 'топор', font=f_lab, fill=INK)
    x = lead
    for label, im, ax, ay in bot_items:
        canvas.alpha_composite(im, (int(x - ax), int(g2 - ay)))
        d.text((x + (im.width - f_lab.getlength(label)) / 2, g2 + 12), label,
               font=f_lab, fill=INK)
        x += im.width + pad

    path = os.path.join(OUT, 'sheet_style.png')
    canvas.convert('RGB').save(path)
    print('SHEET %s %dx%d' % (path, w, h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variants', default='a,b,c')
    ap.add_argument('--scale', type=int, default=4)
    ap.add_argument('--only', default='all')
    args = ap.parse_args()
    variants = args.variants.split(',')
    if args.only in ('all', 'both', 'ref'):
        sheet_ref(args.scale, variants)
    if args.only in ('all', 'both', 'var'):
        sheet_variants(variants)
    if args.only in ('all', 'style'):
        sheet_style(variants)


if __name__ == '__main__':
    main()
