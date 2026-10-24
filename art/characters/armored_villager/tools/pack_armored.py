"""pack_armored.py — упаковка спрайтов рыцаря (armored_villager) в атлас игры.

    $PY3 tools/pack_armored.py [--src out_kn] [--tag kn]

Пишет прямо в игру — `mapgen2/assets/armored_villager/`, отдельно от атласа
жителя: у рыцаря своя модель (броня, шлем, меч), и затирать ею `villager/`
нельзя. Формат — тот же, что у `hero/` и `villager/` (ppu, mul, cell, anims,
frames с anchorX/anchorY/anim/frame/rotation/rot_index), клетка 112 x 132,
опора (56, 106).

В атлас идут ТОЛЬКО снятые анимации — `idle`, `walk` и `work` (удар мечом
для тренировки во дворе). `carry`/`walk_axe`/`carry_put` в нём нет: рыцарь
брёвен не носит и топором не рубит, а объявленная анимация без кадров
заставила бы `Hero.frameCount` врать.

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
# Корень 4tox — три уровня вверх от проекта: villager → characters → art
# (docs/STRUCTURE.md). Атлас кладётся прямо в игру, а не в out/: так делают
# все упаковщики, и не остаётся шага «скопировать руками», которого нет в коде.
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
PAD = 1
# ВОСЕМЬ поворотов через 45°. Четырёх жителю мало: он ходит по прямой в любую
# сторону (js/villager.js), и по диагонали ему нужен кадр, повёрнутый на 45°.
# Порядок — по возрастанию угла: rot_index в атласе считается по этому списку,
# а игра выбирает кадр по полю rotation (js/hero.js: nearestRot), то есть
# число поворотов в атласе может быть любым.
ROTATIONS = (0, 45, 90, 135, 180, 225, 270, 315)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(ROOT, 'out_kn'))
    ap.add_argument('--dst', default=os.path.join(REPO, 'mapgen2', 'assets', 'armored_villager'))
    ap.add_argument('--tag', default='kn')
    ap.add_argument('--name', default='armored_villager')
    ap.add_argument('--js', default='ARMORED_VILLAGER', help='имя глобальной переменной')
    args = ap.parse_args()

    src_path = os.path.join(args.src, '%s_sprites.json' % args.tag)
    if not os.path.exists(src_path):
        print('нет %s — сначала: tools/compose.py' % src_path)
        return 1
    src = json.load(open(src_path, encoding='utf-8'))
    frames = src['frames']
    anims = src.get('anims', {})
    # Порядок строк атласа. Новые анимации ДОПИСЫВАЮТСЯ В КОНЕЦ, а не
    # вставляются по алфавиту: упаковщик кладёт каждую анимацию в свою полосу
    # строк, и вставка в середину сдвинула бы уже подключённые кадры в атласе —
    # игра грузит их по координатам, но сверка «старые кадры не поехали»
    # (docs/PIPELINE.md, шаг 4) стала бы бессмысленной: сравнивать было бы нечего.
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
        mul=1.35, cell=list(src['cell']),
        anims={a: anims[a] for a in order if a in anims},
        note='спрайты рыцаря (armored_villager, variant=k): броня, шлем и меч; '
             '1 юнит модели = 1 клетка карты, клетка и опора те же, что у '
             'героя и жителя (112x132, anchor 56,106); mul 1.35, как у '
             'растительности и жителя. Объявлены только снятые анимации idle, '
             'walk и work (удар мечом); поворот — угол в градусах '
             '(0/45/.../315), игра берёт ближайший (js/hero.js: nearestRot).',
        shadow=src.get('shadow'), outline=src.get('outline'),
        # пятно рубки шире покойного (compose.SHADOW_WORK); в кадрах оно уже
        # впитано, поле нужно тому, кто будет их пересобирать
        shadow_by_anim=src.get('shadow_by_anim'),
        frames=out_frames)
    with open(os.path.join(args.dst, 'atlas.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.dst, 'atlas.js'), 'w', encoding='utf-8') as f:
        f.write('/* атлас рыцаря — то же, что atlas.json, но скриптом:\n'
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
