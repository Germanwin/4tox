"""Упаковка спрайтов ратуши в атлас генератора карт.

    python3 tools/pack_townhall.py [--src ../../townhall/out] [--pad 2]

Читает готовые спрайты ратуши (`townhall/out/th_<вариант>_<поворот>.png` и
`sprites.json`, который пишет `townhall/tools/compose.py`) и складывает их в
один атлас — ровно в том же формате, что и `assets/sprites/atlas.json`:
кадр, рамка в пикселях атласа и точка опоры внутри кадра.

Зачем атлас, а не 12 файлов: генератор грузит спрайты одним скриптом
(`atlas.js`), который работает и по `file://`, и одной картинкой — иначе
на каждый вариант и поворот приходилось бы по отдельному запросу и по
отдельному состоянию загрузки, а панель размещения не знала бы, когда
показывать превью.

Метаданные к кадру, которые нужны рендеру и без которых масштаб не вывести:

  ppu       пикселей кадра на юнит модели (80 = 640 px / ortho 8.0)
  az_deg    азимут камеры рендера (45°)
  el_deg    подъём камеры рендера (35.2644° — истинная изометрия)
  footprint пятно застройки в клетках по повороту: 0/180 — 4x3, 90/270 — 3x4

По ним `js/buildings.js` считает масштаб спрайта так, чтобы пятно застройки
легло ровно в клетки карты, а не «примерно».
"""
import argparse
import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # mapgen2/
REPO = os.path.dirname(ROOT)                       # корень 4tox (docs/STRUCTURE.md)
DEFAULT_SRC = os.path.join(REPO, 'art', 'buildings', 'townhall', 'out')
DST = os.path.join(ROOT, 'assets', 'townhall')

VARIANTS = ('a', 'b', 'c')
ROTATIONS = (0, 90, 180, 270)

# Крупность спрайта: 1 — основание ровно в край пятна. Правило посадки
# (js/buildings.js) само поджимает спрайт, чтобы основание отошло от края;
# заказчик попросил ещё на 8 % меньше — это число и есть mul. Живёт здесь,
# в упаковщике: атлас и его масштаб едут вместе, врозь они разъезжаются.
MUL = 0.7667


def footprint(rotation):
    """Пятно застройки в клетках: ратуша 4 x 3, при повороте на 90° — 3 x 4."""
    return (4, 3) if rotation % 180 == 0 else (3, 4)


def is_stone(r, g, b):
    """Камень цоколя: серо-голубой, зелёного больше красного, синий не уехал."""
    return abs(g - b) <= 14 and 0 < g - r <= 40 and 55 <= g <= 215


def ground_contact(img, ax, ay, ppu, az_deg, el_deg):
    """Наземный контур кадра в клетках карты, относительно точки опоры.

    Нужен рендеру, чтобы поставить здание серединой *основания*, а не серединой
    модели: у ратуши сбоку крыльцо и приступок, они выходят за пятно, и по
    модели основание стоит не по середине.

    Контур — нижний непрозрачный пиксель каждого столбца, но только там, где
    виден цоколь: выше цоколя столбец может заканчиваться свесом крыши, и без
    этого ограничения в контур попадает она (у ратуши — на 1.4 клетки вбок).
    Цоколь опознаётся по цвету камня; если камня в кадре нет, берётся нижний
    пиксель столбца, но не выше точки опоры больше чем на 1.2 клетки экрана.
    Мягкая тень не считается: у неё альфа ниже непрозрачной.
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
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--pad', type=int, default=2)
    args = ap.parse_args()

    meta_path = os.path.join(args.src, 'sprites.json')
    if not os.path.exists(meta_path):
        print('нет %s — сначала соберите ратушу (townhall/tools/compose.py)' % meta_path)
        return 1
    src_meta = json.load(open(meta_path))

    # Камера и масштаб: берём из отчёта рендера, если он есть, иначе —
    # конвенции thpipe.py. Это те же числа, что и в renders/render_report.json.
    report_path = os.path.join(REPO, 'art', 'buildings', 'townhall', 'renders',
                               'render_report.json')
    az, el, ppu, res = 45.0, 35.264389682754654, 80.0, [512, 640]
    if os.path.exists(report_path):
        rep = json.load(open(report_path))
        az = rep.get('az_deg', az)
        el = rep.get('el_deg', el)
        ppu = rep.get('ppu', ppu)
        res = rep.get('res', res)

    # Кадры: вариант x поворот. Имя в источнике — townhall_<вариант>_<поворот>.
    frames = []
    for v in VARIANTS:
        for rot in ROTATIONS:
            key = 'townhall_%s_%d' % (v, rot)
            f = src_meta['frames'].get(key)
            if not f:
                print('нет кадра %s в sprites.json' % key)
                return 1
            path = os.path.join(args.src, f['file'])
            if not os.path.exists(path):
                print('нет файла %s' % path)
                return 1
            frames.append({
                'name': key, 'variant': v, 'rotation': rot,
                'img': Image.open(path).convert('RGBA'),
                'anchorX': float(f['anchorX']), 'anchorY': float(f['anchorY']),
            })
            frames[-1]['ground'] = ground_contact(
                frames[-1]['img'], frames[-1]['anchorX'], frames[-1]['anchorY'], ppu, az, el)

    pad = max(1, args.pad)
    cell_w = max(f['img'].width for f in frames) + pad * 2
    cell_h = max(f['img'].height for f in frames) + pad * 2
    cols, rows = len(ROTATIONS), len(VARIANTS)
    W, H = cell_w * cols + 1, cell_h * rows + 1

    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out_frames = {}
    for i, f in enumerate(frames):
        col = ROTATIONS.index(f['rotation'])
        row = VARIANTS.index(f['variant'])
        x = col * cell_w + pad
        y = row * cell_h + pad
        atlas.alpha_composite(f['img'], (x, y))
        out_frames[f['name']] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            'anchorX': round(f['anchorX'], 2), 'anchorY': round(f['anchorY'], 2),
            'variant': f['variant'], 'rotation': f['rotation'],
            'footprint': list(footprint(f['rotation'])),
            # Наземный контур (цоколь вместе с крыльцом), клетки от точки опоры.
            'ground': f['ground'],
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': ppu,
        'az_deg': az,
        'el_deg': el,
        'res': res,
        'variants': {v: list(footprint(0)) for v in VARIANTS},
        'mul': MUL,
        'note': ('спрайты ратуши: 1 юнит модели = 1 клетка карты, '
                 'anchorX/anchorY — точка опоры (центр пятна застройки); '
                 'footprint — пятно в клетках по повороту; '
                 'ground — наземный контур в клетках от опоры; '
                 'mul — крупность спрайта'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    # atlas.js — тот же JSON, но скриптом: работает по file:// без запросов,
    # ровно как assets/sprites/atlas.js у основного атласа.
    with open(os.path.join(DST, 'atlas.js'), 'w') as fh:
        fh.write('window.TOWNHALL_ATLAS = ')
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write(';\n')

    print('atlas.png %dx%d, кадров %d, %.1f px на юнит, камера az %.1f el %.4f' % (
        W, H, len(out_frames), ppu, az, el))
    print('масштаб при клетке 64 px: X %.4f, Y %.4f' % (
        64.0 / (2.0 * 0.7071067811865476 * ppu),
        64.0 / (4.0 * 0.5773502691896257 * 0.7071067811865476 * ppu)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
