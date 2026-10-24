"""compose_ruins.py — сырой кадр руины -> спрайт С ТОЧКОЙ ОПОРЫ ЦЕЛОГО.

    $PY3 tools/compose_ruins.py --type house --rotation 0
    $PY3 tools/compose_ruins.py --type all

Берёт `renders/rn_<тип>_<поворот>_raw.png`, цели из `out/targets.json` (их
пишет `tools/targets.py`) и кладёт кадр так, чтобы:

    * `anchorX/anchorY` были РОВНО теми же, что у целой постройки;
    * силуэт оказался в той же системе координат кадра (тот же ppu, та же
      камера, центр пятна проецируется в тот же пиксель);
    * фон был прозрачным, контур — канонные 1 px при 96 ppu;
    * тени не было (`--no-shadow` по правилу 2026-10-17; здесь её и нет).

ПОЧЕМУ НЕ `compose.py` СКИЛЛА.  Штатный композитор режет кадр ПО СИЛУЭТУ и
центрирует его в своей рамке.  Опора тогда получается «половина ширины
силуэта», а у руины силуэт другой — опора уехала бы на десятки пикселей.
Здесь рамка строится ОТ ЦЕЛЕВОЙ ОПОРЫ: смещение = `anchor_цели − anchor_raw`,
и опора остаётся на месте при любом силуэте.  Если силуэт не влезает слева
или сверху (отрицательное смещение) — это ошибка, и она печатается числом, а
не подрезается молча.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

OUTLINE_RGB = (12, 16, 12)
PAD = 3


def compose(raw_path, out_path, target, raw_anchor, dilate=1):
    im = Image.open(raw_path).convert('RGBA')
    a = np.asarray(im).astype(np.float32)
    al = a[:, :, 3] / 255.0
    ys, xs = np.nonzero(al > 0.35)
    if not len(xs):
        raise SystemExit('%s: пустой кадр (нет силуэта)' % raw_path)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    w, h = x1 - x0 + 1, y1 - y0 + 1

    ox = int(round(target['anchorX'] - raw_anchor[0] + (x0 - PAD)))
    oy = int(round(target['anchorY'] - raw_anchor[1] + (y0 - PAD)))
    if ox < 0 or oy < 0:
        raise SystemExit(
            '%s: силуэт не влезает в кадр при опоре %.1f,%.1f (смещение %d,%d). '
            'Это не повод подрезать: камера или ppu не те, что у целой '
            'постройки.' % (raw_path, target['anchorX'], target['anchorY'],
                            ox, oy))

    W = max(int(target['w']), ox + w + 2 * PAD + 2)
    H = max(int(target['h']), oy + h + 2 * PAD + 2)
    canvas = np.zeros((H, W, 4), np.float32)
    crop = a[y0 - PAD:y1 + PAD + 1, x0 - PAD:x1 + PAD + 1]
    ch, cw = crop.shape[:2]
    canvas[oy:oy + ch, ox:ox + cw] = crop

    # Контур: расширение альфы на `dilate` px, кольцо — цвет обводки.
    if dilate:
        alpha_img = Image.fromarray((canvas[:, :, 3]).astype(np.uint8))
        grown = np.asarray(alpha_img.filter(ImageFilter.MaxFilter(
            2 * dilate + 1)), np.float32)
        ring = np.clip(grown - canvas[:, :, 3], 0.0, 255.0) / 255.0
        oc = np.array(OUTLINE_RGB, np.float32)[None, None, :]
        canvas[:, :, :3] = np.where(ring[:, :, None] > 0.5, oc,
                                    canvas[:, :, :3])
        canvas[:, :, 3] = np.maximum(canvas[:, :, 3], ring * 255.0)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).save(out_path)
    meta = dict(raw=os.path.basename(raw_path),
                anchor=[int(target['anchorX']), int(target['anchorY'])],
                size=[W, H], ppu=target['ppu'], mul=target['mul'],
                outline=True, shadow=False, target_frame=target.get('src_frame'))
    with open(os.path.splitext(out_path)[0] + '.json', 'w',
              encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    return out_path, meta['anchor'], (W, H), (ox, oy, w, h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--type', required=True,
                    help='townhall|house|lumbercamp|barracks|warcamp|all')
    ap.add_argument('--rotation', type=int, default=None)
    ap.add_argument('--scale', type=int, default=1)
    ap.add_argument('--targets', default=os.path.join(ROOT, 'out',
                                                      'targets.json'))
    ap.add_argument('--no-outline', action='store_true')
    args = ap.parse_args()
    with open(args.targets, encoding='utf-8') as fh:
        T = json.load(fh)
    types = list(T['types']) if args.type == 'all' else [args.type]
    for t in types:
        info = T['types'][t]
        rots = ([args.rotation] if args.rotation is not None
                else T['rotations'])
        for rot in rots:
            tg = dict(info['frames'][str(rot)])
            # @4x: и опора, и рамка масштабируются вместе с ppu.  Иначе
            # композитор поставил бы 4x-силуэт на 1x-опору и кадр уехал бы.
            tg['anchorX'] = float(tg['anchorX']) * args.scale
            tg['anchorY'] = float(tg['anchorY']) * args.scale
            tg['w'] = int(tg['w']) * args.scale
            tg['h'] = int(tg['h']) * args.scale
            tg['ppu'] = info['ppu'] * args.scale
            tg['mul'] = info['mul']
            suffix = '@4x' if args.scale > 1 else ''
            raw = os.path.join(ROOT, 'renders', 'rn_%s_%d%s_raw.png'
                               % (t, rot, suffix))
            out = os.path.join(ROOT, 'out', 'rn_%s_%d%s.png'
                               % (t, rot, suffix))
            if not os.path.exists(raw):
                print('нет %s — пропускаю' % raw)
                continue
            raw_anchor = [info['raw_anchor'][0] * args.scale,
                          info['raw_anchor'][1] * args.scale]
            path, anchor, size, box = compose(
                raw, out, tg, raw_anchor,
                dilate=1 * args.scale if not args.no_outline else 0)
            print('%-22s %4dx%4d  опора %d,%d  силуэт %dx%d в %d,%d'
                  % (os.path.basename(path), size[0], size[1], anchor[0],
                     anchor[1], box[2], box[3], box[0], box[1]))


if __name__ == '__main__':
    main()
