"""targets.py — заморозить ЦЕЛЕВЫЕ числа кадров руин из целых атласов.

    $PY3 tools/targets.py

Пишет `out/targets.json`: для каждого типа и поворота — `anchorX/anchorY`,
`footprint`, `ground`, `mul`, `ppu` и размер кадра ЦЕЛОЙ постройки.  Отсюда их
берут и `compose_ruins.py` (чтобы поставить точку опоры ровно туда же), и
`pack_ruins.py` (чтобы записать в атлас), и `check_atlas.py` (чтобы сверить).

ПОЧЕМУ ЦЕЛЕЙ НЕЛЬЗЯ ВЫЧИСЛИТЬ ЗАНОВО.  `anchorX/anchorY` — не «центр кадра», а
пиксель, куда проецируется центр пятна; он зависит от того, как кадр целой
постройки был обрезан.  У дома кадр 733 x 781 при опоре 366,486, у лагеря —
747 x 636 при 355,389.  Если руина соберёт свой кадр «по силуэту», опора
уедет на десятки пикселей, и спрайт встанет не туда.  Поэтому цель читается
из атласа, а не пересчитывается.

`ppu` ратуши — 80, у остальных 96.  Это не опечатка: её целый атлас снят при
80 ppu (кадр 512x640, ortho 8.0).  При 96 ppu диагональ её пятна 4 x 3 —
475 px и в кадр 431 px не влезает; см. README, раздел про ppu.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')

# тип -> (папка атласа, вариант, префикс имён кадров, ppu целого атласа)
SOURCES = {
    'townhall':   ('townhall', 'a', 'townhall_a_', 80.0),
    'house':      ('starter_house', 'a', 'sh_a_', 96.0),
    'lumbercamp': ('lumbercamp', 'a', 'lc_a_', 96.0),
    'barracks':   ('barracks', 'a', 'br_a_', 96.0),
    'warcamp':    ('warcamp', 'x', 'wc_', 96.0),
}
ROTATIONS = (0, 90, 180, 270)


def main():
    out = {'rotations': list(ROTATIONS), 'types': {}}
    for t, (folder, variant, prefix, ppu) in SOURCES.items():
        path = os.path.join(GAME, 'assets', folder, 'atlas.json')
        with open(path, encoding='utf-8') as fh:
            meta = json.load(fh)
        res = meta.get('res') or [512, 640]
        frames = {}
        for rot in ROTATIONS:
            key = '%s%d' % (prefix, rot)
            f = meta['frames'].get(key)
            if f is None:
                raise SystemExit('%s: в atlas.json нет кадра %s' % (t, key))
            frames[str(rot)] = dict(
                anchorX=float(f['anchorX']), anchorY=float(f['anchorY']),
                w=int(f['w']), h=int(f['h']),
                footprint=list(f['footprint']), ground=list(f['ground']),
                mul=float(meta['mul']), ppu=float(meta.get('ppu', ppu)),
                src_frame=key)
        out['types'][t] = dict(
            folder=folder, variant=variant, ppu=float(meta.get('ppu', ppu)),
            mul=float(meta['mul']), res=list(res),
            raw_anchor=[res[0] / 2.0, res[1] / 2.0],
            frames=frames)
        print('%-11s %-13s ppu %4.0f  mul %.4f  кадр 0: %dx%d опора %.0f,%.0f'
              % (t, folder, out['types'][t]['ppu'], out['types'][t]['mul'],
                 frames['0']['w'], frames['0']['h'],
                 frames['0']['anchorX'], frames['0']['anchorY']))
    dst = os.path.join(ROOT, 'out', 'targets.json')
    with open(dst, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print('записан %s' % dst)


if __name__ == '__main__':
    import sys
    sys.exit(main())
