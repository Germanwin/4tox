"""compose_all.py — сырые кадры -> спрайты: обрезка, контур, тень, точка опоры.

    $PY3 tools/compose_all.py                 # 4 поворота 1x и кадр @4x
    $PY3 tools/compose_all.py --shadow-y 70   # подвинуть пятно тени (в пикселях)
    $PY3 tools/compose_all.py --no-shadow     # без тени — так собран атлас игры
                                              # (правило заказчика: тени у
                                              # зданий нет)

Композитор скилла работает с ОДНИМ кадром (`compose.py`), здесь — обёртка на
набор: четыре поворота плюс крупный кадр.  Толщина контура, полуоси и размытие
тени заданы в пикселях кадра 96 ppu, поэтому для @4x они умножаются на ppu/96
(грабли дома жителя: на @4x контур становился вчетверо тоньше, а тень уезжала
под дом).

Точка опоры — ЦЕНТР ПЯТНА в сыром кадре: камера канона смотрит в начало
координат, а модель построена серединой основания в начале координат, поэтому
при 512x640 это (256, 320), а при 2048x2560 — (1024, 1280).

`--no-shadow` рамку кадра и опору НЕ меняет: место под пятно остаётся
прозрачным, спрайт в игре стоит там же, где стоял с тенью, и числа атласа
(`anchorX/anchorY`, `ground`, размеры кадров) остаются теми же.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import compose as C                                                # noqa: E402

RES = {1: (512, 640), 4: (2048, 2560)}


def main():
    ap = argparse.ArgumentParser(description='сырые кадры -> спрайты')
    ap.add_argument('--tag', default='sh')
    ap.add_argument('--tag-4x', default='sh4x')
    ap.add_argument('--out', default='out')
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--shadow-x', type=float, default=0.0)
    ap.add_argument('--shadow-y', type=float, default=0.0)
    ap.add_argument('--shadow-a', type=float, default=None)
    ap.add_argument('--shadow-b', type=float, default=None)
    ap.add_argument('--shadow-alpha', type=float, default=None)
    ap.add_argument('--no-shadow', action='store_true',
                    help='не рисовать контактную тень вовсе')
    args = ap.parse_args()

    out_dir = os.path.join(ROOT, args.out)
    os.makedirs(out_dir, exist_ok=True)
    frames, sprites = {}, {}
    plan = [(int(r), 1, args.tag) for r in args.rotations.split(',')]
    plan.append((0, 4, args.tag_4x))
    for rot, scale, tag in plan:
        raw = os.path.join(ROOT, 'renders', '%s_x_%d_raw.png' % (tag, rot))
        if not os.path.exists(raw):
            print('нет сырого кадра %s — пропускаю' % raw)
            continue
        ppu = 96.0 * scale
        name = '%s_%d%s' % (args.tag, rot, '@4x' if scale == 4 else '')
        out = os.path.join(out_dir, name + '.png')
        an = (RES[scale][0] / 2.0, RES[scale][1] / 2.0)
        # параметры тени и контура — в пикселях кадра 96 ppu
        k = float(scale)
        path, ax, ay, size = C.compose(
            raw, out, args.shadow_x * k, args.shadow_y * k,
            ppu=ppu, anchor_raw=[an[0], an[1]],
            shadow_a=args.shadow_a,
            shadow_b=None if args.shadow_b is None else args.shadow_b,
            shadow_alpha=args.shadow_alpha,
            shadow=not args.no_shadow)
        print('%-16s %dx%d  опора %d,%d' % (name, size[0], size[1], ax, ay))
        frames[name] = dict(path=out, anchor=[ax, ay], size=list(size),
                            ppu=ppu, rotation=rot, scale=scale)
        if scale == 1:
            sprites[str(rot)] = frames[name]
    meta = dict(ppu=96.0, scale_4x=384.0, footprint=[2, 3], prefix=args.tag,
                shadow=dict(x=args.shadow_x, y=args.shadow_y,
                            a=args.shadow_a, b=args.shadow_b,
                            alpha=args.shadow_alpha,
                            drawn=not args.no_shadow),
                frames=frames)
    with open(os.path.join(out_dir, '%s_sprites.json' % args.tag), 'w',
              encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    print('записан %s/%s_sprites.json' % (args.out, args.tag))


if __name__ == '__main__':
    main()
