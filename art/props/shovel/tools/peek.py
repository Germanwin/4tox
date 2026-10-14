"""Быстрый осмотр рендеров: обрезка по силуэту и монтаж кадров в один лист.

    python3 tools/peek.py renders/_peek_montage.png renders/shovel_a_*.png

Зачем: рабочий кадр 512x640, лопата в нём занимает ~60x200 px — в таком виде
её не рассмотреть. Скрипт режет по bbox и складывает кадры в ряд, с подписями
по имени файла. Это инструмент ГЛАЗ, а не гейта: он ничего не проверяет.
"""
import argparse
import os

from PIL import Image, ImageDraw

ZOOM = 3


def label(draw, xy, text):
    x, y = xy
    draw.rectangle([x + 2, y + 2, x + 8 + 7 * len(text), y + 18], fill=(20, 24, 20))
    draw.text((x + 5, y + 5), text, fill=(235, 235, 235))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('files', nargs='+')
    ap.add_argument('--zoom', type=int, default=ZOOM)
    ap.add_argument('--bg', default='checker', choices=['checker', 'white', 'dark'])
    args = ap.parse_args()

    tiles = []
    for path in sorted(args.files):
        im = Image.open(path).convert('RGBA')
        bb = im.getbbox()
        if bb:
            im = im.crop(bb)
        im = im.resize((im.width * args.zoom, im.height * args.zoom), Image.NEAREST)
        tiles.append((os.path.basename(path), im))
    if not tiles:
        raise SystemExit('нечего показывать')

    pad, head = 12, 22
    W = sum(t.width for _, t in tiles) + pad * (len(tiles) + 1)
    H = max(t.height for _, t in tiles) + head + pad * 2
    sheet = Image.new('RGB', (W, H), (150, 150, 150))
    if args.bg == 'checker':
        px = sheet.load()
        for y in range(H):
            for x in range(W):
                px[x, y] = (110, 110, 110) if ((x // 8 + y // 8) % 2) else (170, 170, 170)
    elif args.bg == 'white':
        sheet = Image.new('RGB', (W, H), (250, 250, 250))
    else:
        sheet = Image.new('RGB', (W, H), (35, 38, 35))

    draw = ImageDraw.Draw(sheet)
    x = pad
    for name, t in tiles:
        sheet.paste(t, (x, head + pad), t)
        label(draw, (x, 0), name.replace('shovel_', '').replace('_raw.png', ''))
        x += t.width + pad
    sheet.save(args.out)
    print('лист осмотра: %s  %dx%d  кадров %d' % (args.out, sheet.width, sheet.height,
                                                 len(tiles)))


if __name__ == '__main__':
    main()
