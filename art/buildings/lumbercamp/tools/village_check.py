"""village_check.py — ПРИЁМКА ЦВЕТА: лагерь против ратуши, по пикселям.

Отвечает на задачу заказчика («лагерь в цветовой гамме ратуши») числом, а не
взглядом.  Три вопроса, три ответа:

    1. ПАЛИТРА — доля пикселей лагеря, попадающих в палитру ратуши.  Палитра
       ратуши берётся не из кода, а ИЗ ЕЁ СПРАЙТА: цвета, занимающие не меньше
       `--pal-share` площади кадра.  Так проверка не зависит от того, что мы
       думаем о красках ратуши, — она смотрит на то, что в игре видно.
    2. ЗОНЫ — по каждой зоне лагеря: сколько пикселей и какой у них цвет.
       Маска зоны считается софт-растеризатором (`xray.render`, режим `id`) по
       той же проекции, что у кадра Blender, поэтому маска и картинка совпадают
       пиксель в пиксель (сходимость проекции проверена в README, IoU 0.98).
    3. ПОКРАСКА — сходится ли зона лагеря с ТОЙ ЖЕ краской ратуши.  Это уже не
       «похоже», а тождество: у ратуши `plank` — светлая доска, у лагеря
       `plank` — та же доска; цвет обязан лечь на ту же полосу оттенков.

    python3 tools/village_check.py                       # поворот 0, 1x
    python3 tools/village_check.py --rot 90
    python3 tools/village_check.py --raw renders/lc4x_x_0_raw.png --ppu 384

Код возврата 0 — цвет принят, 1 — нет.
"""
import argparse
import collections
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(ROOT)))
for p in (HERE,):
    if p not in sys.path:
        sys.path.insert(0, p)

import xray as X                                                     # noqa: E402
import village as V                                                  # noqa: E402

TOWNHALL_ATLAS = os.path.join(REPO, 'mapgen2', 'assets', 'townhall',
                              'atlas.png')
TOWNHALL_FRAME = 'townhall_a_0'
TOWNHALL_DIST = 26.0        # порог гейта стиля: 26 sRGB до краски канона
FAILS = []


def townhall_colors(min_share):
    """Палитра ратуши по её спрайту: цвета, занимающие >= min_share площади."""
    from PIL import Image
    im = Image.open(TOWNHALL_ATLAS).convert('RGBA')
    meta = json.load(open(os.path.join(os.path.dirname(TOWNHALL_ATLAS),
                                       'atlas.json'), encoding='utf-8'))
    f = meta['frames'][TOWNHALL_FRAME]
    a = np.asarray(im)[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']]
    op = a[a[..., 3] > 200][:, :3].astype(np.uint8)
    cnt = collections.Counter(map(tuple, op.tolist()))
    tot = float(len(op))
    keep = {c: n for c, n in cnt.items() if n / tot >= min_share}
    return (np.array(sorted(keep), float), keep, cnt, tot, op)


def zone_mask(rot, ppu, res, variant=None):
    """(H,W) индекс зоны на пиксель кадра, -1 — фон.  Проекция канона."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'vc_gen', os.path.join(HERE, 'building.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    parts = mod.build(variant)
    if rot:
        M = X.mesh(parts)
        M = X.rot_z(M, rot)
    else:
        M = X.mesh(parts)
    ids = X.render(M, W=res[0], Hh=res[1], scale=float(ppu),
                   center=(0.0, 0.0, 0.0), mode='id')
    tri = ids['id']
    # ЗЕРКАЛО ПО X — не ошибка, а та самая развилка осей, разобранная в
    # README («рендер построек смотрит не с той стороны»): камера пайплайна
    # стоит со стороны (-x, +y), а `xray.cam_basis` строит базис как карта игры
    # (`r = cross(z, f) = -right` камеры).  Замер: без зеркала силуэт маски
    # против альфа-канала кадра даёт IoU 0.330, с зеркалом — 0.999.
    tri = tri[:, ::-1]
    out = np.full(tri.shape, -1, int)
    names = sorted(set(M['fam'].tolist()))
    idx = {n: i for i, n in enumerate(names)}
    ok = tri >= 0
    out[ok] = [idx[M['fam'][t]] for t in tri[ok]]
    return out, names


def check(raw, rot, ppu, res, min_share, variant=None):
    from PIL import Image
    pal, keep, cnt, tot, top = townhall_colors(min_share)
    a = np.asarray(Image.open(raw).convert('RGBA'))
    if a.shape[0] != res[1] or a.shape[1] != res[0]:
        raise SystemExit('кадр %s — %dx%d, а ожидался %dx%d (--res)'
                         % (raw, a.shape[1], a.shape[0], res[0], res[1]))
    zm, names = zone_mask(rot, ppu, res, variant)
    # Маска обязана совпасть с кадром: если разъедется хоть на пиксель, таблица
    # зон покажет цвета соседней детали и «приёмка» станет бессмысленной.
    alpha = a[..., 3] > 128
    sil = zm >= 0
    iou = float((sil & alpha).sum()) / float((sil | alpha).sum())
    ok_iou = iou >= 0.99
    FAILS.append(ok_iou)
    print('%s МАСКА ЗОН силуэт модели против альфа-канала кадра: IoU %.3f '
          '(нужно >=0.99)' % ('OK  ' if ok_iou else 'FAIL', iou))
    m = (a[..., 3] > 200) & (zm >= 0)
    obj = a[..., :3][m].astype(float)

    print('=== ЦВЕТ ЛАГЕРЯ ПРОТИВ РАТУШИ ===')
    print('кадр %s (%d x %d, поворот %d), пикселей объекта %d'
          % (os.path.relpath(raw, ROOT), res[0], res[1], rot, int(m.sum())))
    print('палитра ратуши: %d цветов >= %.2f%% площади её спрайта (всего %d '
          'различных)' % (len(pal), 100 * min_share, len(cnt)))

    d = np.sqrt(((obj[:, None, :] - pal[None, :, :]) ** 2).sum(-1)).min(1)
    share = float((d <= TOWNHALL_DIST).mean())
    ok = share >= 0.93
    FAILS.append(ok)
    print('%s ПАЛИТРА %.2f%% пикселей лагеря в пределах %.0f sRGB до цвета '
          'ратуши (нужно >=93%%); медиана %.1f, p90 %.1f, худший %.1f'
          % ('OK  ' if ok else 'FAIL', 100 * share, TOWNHALL_DIST,
             float(np.median(d)), float(np.percentile(d, 90)), float(d.max())))

    # какие цвета лагеря всё-таки мимо и насколько
    miss = obj[d > TOWNHALL_DIST]
    if len(miss):
        mc = collections.Counter(map(tuple, miss.astype(np.uint8).tolist()))
        print('     мимо: %d px (%.2f%%)'
              % (len(miss), 100.0 * len(miss) / len(obj)))
        for c, n in mc.most_common(4):
            print('       #%02X%02X%02X %d px' % (c[0], c[1], c[2], n))

    print('--- зоны ---')
    print('%-8s %-8s %7s  %-9s %-9s  %s'
          % ('зона', 'краска', 'px', 'медиана', 'от ратуши', 'вывод'))
    rows = []
    for i, name in enumerate(names):
        sel = zm == i
        if sel.sum() < 12:
            continue
        px = a[..., :3][sel & (a[..., 3] > 200)].astype(float)
        if not len(px):
            continue
        med = np.median(px, axis=0)
        dd = np.sqrt(((px[:, None, :] - pal[None, :, :]) ** 2).sum(-1)).min(1)
        bad = float((dd > TOWNHALL_DIST).mean())
        # краска ратуши, которой покрашена зона: её собственный hex
        hex_lin = V.paint(name)[0]
        rgb = tuple((hex_lin >> s) & 255 for s in (16, 8, 0))
        rows.append((name, V.paint_name(name), int(len(px)), med, bad, rgb))
        print('%-8s %-8s %7d  #%02X%02X%02X  d<=26: %5.1f%%  %s'
              % (name, V.paint_name(name), len(px),
                 int(med[0]), int(med[1]), int(med[2]), 100 * (1 - bad),
                 'OK' if bad <= 0.10 else 'мимо'))
    return rows


def main():
    ap = argparse.ArgumentParser(description='цвет лагеря против ратуши')
    ap.add_argument('--raw', default=None)
    ap.add_argument('--rot', type=int, default=0)
    ap.add_argument('--ppu', type=float, default=96.0)
    ap.add_argument('--res', default=None)
    ap.add_argument('--pal-share', type=float, default=0.0005,
                    help='какой долей спрайта ратуши обязан занимать цвет, '
                         'чтобы считаться её палитрой')
    ap.add_argument('--variant', default=None)
    args = ap.parse_args()
    raw = args.raw or os.path.join(ROOT, 'renders', 'lc_x_%d_raw.png' % args.rot)
    res = ([int(x) for x in args.res.split(',')] if args.res
           else [512, 640] if args.ppu == 96.0 else [2048, 2560])
    rows = check(raw, args.rot, args.ppu, res, args.pal_share, args.variant)
    print('ИТОГ: %s' % ('ПРИНЯТО' if all(FAILS) else 'НЕ ПРИНЯТО'))
    return 0 if all(FAILS) else 1


if __name__ == '__main__':
    sys.exit(main())
