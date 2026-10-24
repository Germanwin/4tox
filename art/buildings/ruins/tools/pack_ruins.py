"""pack_ruins.py — 20 кадров руин -> ОДИН атлас `mapgen2/assets/ruins/`.

    $PY3 tools/pack_ruins.py [--pad 2] [--scale 1]

Читает `out/rn_<тип>_<поворот>.png` (их пишет `tools/compose_ruins.py`) и
цели из `out/targets.json` (их пишет `tools/targets.py`), складывает в
`atlas.png` + `atlas.json` + `atlas.js` (`window.RUINS_ATLAS = {...}`).

РАСКЛАДКА: 4 столбца — повороты 0/90/180/270, 5 строк — типы в порядке
townhall, house, lumbercamp, barracks, warcamp.  Ячейка `cell` — самая крупная
рамка плюс поле.

ЧТО КОПИРУЕТСЯ ИЗ ЦЕЛЫХ АТЛАСОВ И НЕ ВЫЧИСЛЯЕТСЯ ЗАНОВО:
    * `anchorX/anchorY` — пиксель кадра, куда проецируется центр пятна;
    * `ground` — наземный контур в клетках от опоры;
    * `mul` — крупность спрайта;
    * `footprint` — пятно в клетках по повороту;
    * `ppu` — пикселей на юнит.
Именно по этим числам игра ставит спрайт; руина обязана встать туда же, где
стояла целая постройка.  `tools/check_atlas.py` сверяет их с целыми атласами
и падает при любом расхождении.

У РАЗНЫХ ТИПОВ РАЗНЫЙ ppu (ратуша 80, остальные 96) и разный `mul`.  Поэтому
наряду с общим `ppu`/`mul` (значения по умолчанию) каждый кадр несёт СВОИ
`ppu` и `mul`, а блок `types` держит их по типу.  Интегратору нужен покадровый
ppu: без него ратуша при 96 ppu не влезла бы в свой кадр (её 431 px рассчитан
на 80 ppu).
"""
import argparse
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
DST = os.path.join(GAME, 'assets', 'ruins')

ROTATIONS = (0, 90, 180, 270)
TYPES = ('townhall', 'house', 'lumbercamp', 'barracks', 'warcamp')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--pad', type=int, default=2)
    ap.add_argument('--scale', type=int, default=1)
    args = ap.parse_args()

    with open(os.path.join(args.src, 'targets.json'), encoding='utf-8') as f:
        T = json.load(f)

    suffix = '@4x' if args.scale > 1 else ''
    frames, loaded = [], []
    for t in TYPES:
        info = T['types'][t]
        for rot in ROTATIONS:
            tg = info['frames'][str(rot)]
            png = os.path.join(args.src, 'rn_%s_%d%s.png' % (t, rot, suffix))
            if not os.path.exists(png):
                print('нет %s — сначала tools/compose_ruins.py' % png)
                return 1
            img = Image.open(png).convert('RGBA')
            loaded.append(dict(type=t, rot=rot, img=img, info=info, tg=tg))
            print('%-24s %4dx%4d  опора %.0f,%.0f  ground %s'
                  % (os.path.basename(png), img.width, img.height,
                     tg['anchorX'], tg['anchorY'], tg['ground']))

    pad = max(1, args.pad)
    cw = max(f['img'].width for f in loaded) + pad * 2
    ch = max(f['img'].height for f in loaded) + pad * 2
    cols, rows = len(ROTATIONS), len(TYPES)
    W, H = cw * cols + 1, ch * rows + 1
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    out_frames = {}
    for f in loaded:
        col = ROTATIONS.index(f['rot'])
        row = TYPES.index(f['type'])
        x = col * cw + pad
        y = row * ch + pad
        atlas.alpha_composite(f['img'], (x, y))
        tg = f['tg']
        out_frames['%s_%d' % (f['type'], f['rot'])] = {
            'x': x, 'y': y, 'w': f['img'].width, 'h': f['img'].height,
            # ТОЧНЫЕ числа целого атласа: на них ставится спрайт в игре.
            'anchorX': round(float(tg['anchorX']), 2),
            'anchorY': round(float(tg['anchorY']), 2),
            'variant': f['type'], 'rotation': f['rot'],
            'footprint': list(tg['footprint']),
            'ground': [round(float(g), 3) for g in tg['ground']],
            # покадровые ppu/mul: у типов они РАЗНЫЕ, одним полем не отделаться
            'ppu': float(f['info']['ppu']) if args.scale == 1
                   else float(f['info']['ppu']) * args.scale,
            'mul': float(f['info']['mul']),
            'ppu_native': float(f['info']['ppu']),
            'scale': args.scale,
        }

    types_meta = {}
    for t in TYPES:
        info = T['types'][t]
        fr0 = info['frames']['0']
        types_meta[t] = {
            'ppu': float(info['ppu']), 'mul': float(info['mul']),
            'footprint': list(fr0['footprint']),
            'anchor': [round(float(fr0['anchorX']), 2),
                       round(float(fr0['anchorY']), 2)],
            'ground': [round(float(g), 3) for g in fr0['ground']],
            'source': 'mapgen2/assets/%s/atlas.json' % info['folder'],
        }

    meta = {
        'atlas': 'atlas.png',
        'ppu': 96.0,
        'az_deg': 45.0,
        'el_deg': 35.264389682754654,
        'res': [512, 640],
        'cell': [cw, ch],
        'variants': {t: list(types_meta[t]['footprint']) for t in TYPES},
        'mul': 0.7667,
        'types': types_meta,
        'note': (
            'РУИНЫ пяти типов построек: 5 типов x 4 поворота = 20 кадров. '
            'variant — имя типа (townhall, house, lumbercamp, barracks, '
            'warcamp), кадры townhall_<поворот>..warcamp_<поворот>. '
            'anchorX/anchorY, ground, mul и footprint ПЕРЕНЕСЕНЫ из целых '
            'атласов (mapgen2/assets/<тип>/) и совпадают с ними — иначе '
            'подмена спрайта сдвинула бы руину. ВНИМАНИЕ: ppu и mul у типов '
            'разные (ратуша 80, остальные 96; mul 0.7156/0.7667/0.7973), '
            'поэтому у каждого кадра есть СВОИ ppu и mul, а блок types '
            'держит их по типу. Общие ppu=96 и mul=0.7667 — значения по '
            'умолчанию для совместимости, не для всех кадров. Кадр 512x640, '
            'истинная изометрия (az 45, el 35.2644), фон прозрачный, тени '
            'нет (правило 2026-10-17). Ни один кадр не выходит за своё пятно; '
            'ground нашего основания сверен с целым по модели (README, раздел '
            '«Что осталось неидеальным»).'),
        'frames': out_frames,
    }

    os.makedirs(DST, exist_ok=True)
    atlas.save(os.path.join(DST, 'atlas.png'))
    with open(os.path.join(DST, 'atlas.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    with open(os.path.join(DST, 'atlas.js'), 'w', encoding='utf-8') as f:
        f.write('window.RUINS_ATLAS = ')
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')

    print('\n%s/atlas.png %dx%d, кадров %d, ячейка %dx%d'
          % (os.path.relpath(DST, GAME), W, H, len(out_frames), cw, ch))
    return 0


if __name__ == '__main__':
    sys.exit(main())
