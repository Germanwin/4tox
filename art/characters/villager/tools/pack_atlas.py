"""pack_atlas.py — упаковка спрайтов жителя в атлас игры.

    $PY3 tools/pack_atlas.py [--src out] [--dst out/villager] [--name villager]

Читает `out/<тег>_sprites.json` (его пишет tools/compose.py) и складывает кадры
в `atlas.png` + `atlas.json` + `atlas.js` РОВНО в том формате, что
`mapgen2/assets/hero/`: те же поля (ppu, mul, cell, anims, frames с
anchorX/anchorY/anim/frame/rotation/rot_index), тот же размер клетки 112 x 132 и
та же опора (56, 106).

Зачем именно так: игра грузит атлас героя скриптом (`assets/hero/atlas.js`), а
не через fetch — страница генератора открывается по file://. Новый персонаж
рядом с героем обязан читаться тем же кодом, поэтому и метаданные те же.
"""
import argparse
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAD = 1
# ВОСЕМЬ поворотов через 45°. Четырёх жителю мало: он ходит по прямой в любую
# сторону (js/villager.js), и по диагонали ему нужен кадр, повёрнутый на 45°.
# Порядок — по возрастанию угла: rot_index в атласе считается по этому списку,
# а игра выбирает кадр по полю rotation (js/hero.js: nearestRot), то есть
# число поворотов в атласе может быть любым.
ROTATIONS = (0, 45, 90, 135, 180, 225, 270, 315)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--dst', default=os.path.join(ROOT, 'out', 'villager'))
    ap.add_argument('--tag', default='vg')
    ap.add_argument('--name', default='villager')
    ap.add_argument('--js', default='VILLAGER', help='имя глобальной переменной')
    args = ap.parse_args()

    src_path = os.path.join(args.src, '%s_sprites.json' % args.tag)
    if not os.path.exists(src_path):
        print('нет %s — сначала: tools/compose.py' % src_path)
        return 1
    src = json.load(open(src_path, encoding='utf-8'))
    frames = src['frames']
    anims = src.get('anims', {})
    order = [a for a in ('idle', 'walk', 'work') if a in anims] or \
        sorted({f['anim'] for f in frames.values()})

    # раскладка: строка = (анимация, поворот), столбец = кадр
    rows = []
    for anim in order:
        for rot in ROTATIONS:
            row = [k for k, f in sorted(frames.items(), key=lambda kv: kv[1]['frame'])
                   if f['anim'] == anim and f['rotation'] == rot]
            if row:
                rows.append((anim, rot, row))
    cw = max(frames[k]['w'] for k in frames) + 2 * PAD
    ch = max(frames[k]['h'] for k in frames) + 2 * PAD
    cols = max(len(r[2]) for r in rows)
    atlas = Image.new('RGBA', (cw * cols, ch * len(rows)), (0, 0, 0, 0))
    out_frames = {}
    for r, (anim, rot, keys) in enumerate(rows):
        for c, k in enumerate(keys):
            f = frames[k]
            img = Image.open(os.path.join(args.src, f['file'])).convert('RGBA')
            x, y = c * cw + PAD, r * ch + PAD
            atlas.alpha_composite(img, (x, y))
            name = '%s_%s_%d_%d' % (args.name, anim, f['frame'],
                                    ROTATIONS.index(rot))
            out_frames[name] = dict(x=x, y=y, w=img.width, h=img.height,
                                    anchorX=round(f['anchorX'] + PAD, 2),
                                    anchorY=round(f['anchorY'] + PAD, 2),
                                    anim=anim, frame=f['frame'], rotation=rot,
                                    rot_index=ROTATIONS.index(rot))
    os.makedirs(args.dst, exist_ok=True)
    atlas.save(os.path.join(args.dst, 'atlas.png'))
    meta = dict(
        atlas='atlas.png', ppu=src['ppu'], az_deg=src['az_deg'],
        el_deg=src['el_deg'], res=[src['cell'][0], src['cell'][1]],
        mul=1.35, cell=list(src['cell']), anims=anims,
        note='спрайты жителя (мужчина, variant=m): 1 юнит модели = 1 клетка карты; клетка и опора '
             'те же, что у героя (112x132, anchor 56,106 — земля между '
             'ступнями); mul обязан совпадать с растительностью (app.js: 1.35); '
             'поворот — угол в градусах (0/45/.../315): модель смотрит в +X, '
             'поворот на 90° даёт +Y, на 45° — диагональ между ними. Игра берёт '
             'БЛИЖАЙШИЙ объявленный поворот (js/hero.js: nearestRot), поэтому '
             'число поворотов в атласе — его дело, а не её. Камера игры — из '
             'квадранта +X+Y (js/render.js: sx=(x−y), sy=(x+y), ближе тот, у '
             'кого x+y больше)',
        shadow=src.get('shadow'), outline=src.get('outline'),
        # пятно рубки шире покойного (compose.SHADOW_WORK); в кадрах оно уже
        # впитано, поле нужно тому, кто будет их пересобирать
        shadow_by_anim=src.get('shadow_by_anim'),
        frames=out_frames)
    with open(os.path.join(args.dst, 'atlas.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.dst, 'atlas.js'), 'w', encoding='utf-8') as f:
        f.write('/* атлас жителя — то же, что atlas.json, но скриптом:\n'
                '   страница генератора открывается по file://, где fetch\n'
                '   JSON запрещён. */\nwindow.%s_ATLAS = ' % args.js)
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write(';\n')
    print('АТЛАС %s: %dx%d, кадров %d (анимаций %d x поворотов %d) -> %s'
          % (args.name, atlas.width, atlas.height, len(out_frames), len(order),
             len(ROTATIONS), args.dst))
    for anim in order:
        ks = [k for k in out_frames if out_frames[k]['anim'] == anim]
        print('  %-6s кадров %d x поворотов %d'
              % (anim, len(ks) // len(ROTATIONS), len(ROTATIONS)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
