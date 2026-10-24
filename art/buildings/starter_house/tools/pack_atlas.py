"""pack_atlas.py — упаковка спрайтов СТАРТОВОГО ДОМА в атлас игры mapgen2.

    $PY3 tools/pack_atlas.py [--src out] [--dst <репо>/mapgen2/assets/starter_house]

Читает `out/sh_sprites.json` (его пишет `tools/compose_all.py`) и складывает
четыре кадра — четыре поворота одного варианта — в `mapgen2/assets/<имя>/`
`atlas.png` + `atlas.json` + `atlas.js`, ровно в том формате, что
`assets/townhall/`, `assets/house/` и `assets/lumbercamp/`: игра читает `ppu`,
`frames[].anchorX/anchorY`, `footprint`, `ground` и `mul` и сама считает
масштаб по осям (`js/buildings.js`).

Пятно застройки — **2 x 3** клетки: X — короткая сторона (2), Y — длинная (3),
как в модели (`tools/house.py`: конёк идёт вдоль Y, дверь смотрит в +Y). При
повороте 90/270 пятно 3 x 2.

`atlas.js` нужен потому, что страница генератора открывается по `file://`, а
`fetch` JSON в этом режиме запрещён.

ЧЕМ ЭТОТ УПАКОВЩИК ОТЛИЧАЕТСЯ ОТ `villager_house/tools/pack_atlas.py`:
`ground` СЧИТАЕТСЯ ПО МОДЕЛИ, А НЕ ПО ПИКСЕЛЯМ
-----------------------------------------------------------
Правило упаковщика ратуши (`mapgen2/tools/pack_townhall.py::ground_contact`)
меряет наземный контур по пикселям кадра: нижний непрозрачный пиксель каждого
столбца, и только там, где виден КАМЕНЬ цоколя. Для ратуши и старого дома
жителя это верно: цоколь идёт сплошной полосой по всему основанию.

У стартового дома основание не такое:

  * цоколь НЕДОСЛОЖЕН — два валуна вынуты из ряда и лежат рядом с лункой;
  * на земле стоит ДВОР: штабель брёвен и вязанка соломы — они каменные
    столбцы не образуют и в пиксельный замер не попадают вовсе;
  * пиксельное правило видит только БЛИЖНЮЮ к камере часть основания: нижний
    пиксель столбца — это нижняя огибающая силуэта, а дальний ряд цоколя и
    дальняя часть двора закрыты самой постройкой.

Замер четырёх правил по четырём кадрам (контур в клетках от опоры, X0 X1 Y0 Y1):

    кадр   по модели (канон: всё, что на земле)   по пикселям            max|Δ|
    0      -0.918  0.993  -1.484  1.492           -1.001  0.953  -1.362  1.469   0.122
    90     -1.484  1.492  -0.993  0.918           -1.603  1.462  -0.834  0.892   0.159
    180    -0.993  0.918  -1.492  1.484           -0.923  0.886  -1.471  1.453   0.070
    270    -1.492  1.484  -0.918  0.993           -1.466  1.449  -0.899  0.958   0.035

Пиксельный замер при этом гуляет по поворотам ещё и в СЕРЕДИНЕ контура
(-0.024/-0.071/-0.019/-0.009 по X): от поворота к повороту видно то один край
основания, то другой, и постройка «дышала» бы при повороте — ровно та беда,
из-за которой по модели считается контур лагеря лесоруба
(`art/buildings/lumbercamp/tools/pack_lumbercamp.py`, раздел о замерах).

Поэтому контур берётся там, где он и определён, — по геометрии: габарит точек
контакта с землёй (низ детали `z <= 0.02`, точки ниже `lo + 0.05`), повёрнутых
тем же поворотом вокруг Z, что и кадр, и переведённых в конвенцию атласа
`X = -x, Y = y` (та же, что у ратуши, дома жителя и лагеря: игра применяет
`ground` как сдвиг по осям карты, `js/buildings.js::anchorShift`).

Числа при этом сходятся с проектной приёмкой посадки
(`tools/place_check.py` → `acc/place.json`): основание 1.915 x 2.976 юнита,
зазор 0.315 клетки по короткой стороне и 0.435 по длинной.

Упаковщик печатает ОБА замера и расхождение — чтобы расхождение было видно
числом, а не помнилось. Приёмка `mapgen2/tools/place.js` знает об этом: у неё
сверка по пикселям — для тех построек, у кого замер пиксельный, а у дома и
лагеря проверяется, что видимый контур стоит серединой в середине пятна и
лежит внутри него.
"""
import argparse
import importlib.util
import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Проект стоит на art/<группа>/<ассет>, поэтому корень 4tox — три уровня вверх
# (docs/STRUCTURE.md).
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
DEFAULT_DST = os.path.join(GAME, 'assets', 'starter_house')

ROTATIONS = (0, 90, 180, 270)
VARIANT = 'a'
PAD = 2

# Камера канона — та же, что в отчёте сборки (renders/sh_report.json).
PPU = 96.0
AZ_DEG = 45.0
EL_DEG = 35.264389682754654

# Пятно: X — короткая сторона (2 клетки), Y — длинная (3).
SPOT = (2, 3)
GROUND_TOL = 0.02                          # низ детали ниже этого — она на земле
CONTACT_TOL = 0.05                         # из детали берём точки у самой земли

# Крупность: правило посадки (зазор BASE_MARGIN = 1/3 клетки по длинной стороне)
# плюс ОБЩАЯ поправка заказчика 8 % (2026-10-14: «отступы у всех построек такие
# же, как у ратуши»). Для длинной стороны 3 это fitMul(3) * 0.92 = 0.7156 —
# то же число, что даёт `siteMul(3)` из js/buildings.js; приёмка сверяет их.
SIDE = max(SPOT)
MUL = round((1.0 - 2.0 * (1.0 / 3.0) / SIDE) * 0.92, 4)


def load_generator():
    """Модуль геометрии дома — чистый Python (`tools/house.py`)."""
    path = os.path.join(HERE, 'house.py')
    spec = importlib.util.spec_from_file_location('sh_house', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['sh_house'] = mod
    spec.loader.exec_module(mod)
    return mod


def footprint(rotation):
    """Пятно по повороту, клетки: 2 x 3, при 90/270 — 3 x 2."""
    return [SPOT[0], SPOT[1]] if rotation % 180 == 0 else [SPOT[1], SPOT[0]]


def ground_from_model(parts, rotation):
    """Наземный контур в клетках от опоры — по модели, в конвенции атласа.

    Габарит ТОЧЕК КОНТАКТА с землёй (низ детали `z <= GROUND_TOL`, точки ниже
    `lo + CONTACT_TOL`), повёрнутых на `rotation` вокруг Z — тем же поворотом,
    что кадр (`build_live.rotate_own`), — и переведённых в конвенцию атласа
    `X = -x, Y = y`. Ось Y — та же, что у пиксельного замера, X отличается
    знаком; конвенция подтверждена растеризацией модели против кадра: дверь
    модели (+Y) на кадре поворота 0 стоит на левой стене, а на 90 — на правой.
    """
    th = math.radians(rotation)
    c, s = math.cos(th), math.sin(th)
    xs, ys = [], []
    for p in parts:
        lo = min(v[2] for v in p['verts'])
        if lo > GROUND_TOL:
            continue
        for v in p['verts']:
            if v[2] > lo + CONTACT_TOL:
                continue
            x = v[0] * c - v[1] * s
            y = v[0] * s + v[1] * c
            xs.append(-x)
            ys.append(y)
    return [round(min(xs), 3), round(max(xs), 3), round(min(ys), 3), round(max(ys), 3)]


def is_stone(r, g, b):
    """Камень цоколя — то же правило, что у ратуши и в приёмке place.js."""
    return abs(g - b) <= 14 and 0 < g - r <= 40 and 55 <= g <= 215


def ground_from_pixels(img, ax, ay, ppu=PPU, az_deg=AZ_DEG, el_deg=EL_DEG):
    """Наземный контур по пикселям кадра — правило `pack_townhall.py`.

    Нужен только для сверки с моделью: игра ставит постройку по MODEL-замеру.
    Мягкая тень не считается (у неё альфа ниже непрозрачной).
    """
    px = img.load()
    w, h = img.size
    pxc = math.cos(math.radians(az_deg)) * ppu
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
                continue
            if not has_stone and y < ay - 1.2 * pyc:
                break
            dx = (x - ax) / pxc
            dy = (y - ay) / pyc
            xs.append((dx + dy) / 2)
            ys.append((dy - dx) / 2)
            break
    if not xs:
        return [0.0, 0.0, 0.0, 0.0]
    return [round(min(xs), 3), round(max(xs), 3), round(min(ys), 3), round(max(ys), 3)]


def visible_gaps(ground, spot):
    """Зазор основания до кромок пятна на карте, клетки: (короткая, длинная).

    Считается так же, как в игре и в `tools/place_check.py`: точка опоры
    сдвигается на середину наземного контура (`anchorShift`), основание
    ужимается крупностью `MUL`. Пятно — по повороту кадра.
    """
    gx = ((ground[0] + ground[1]) / 2.0, (ground[2] + ground[3]) / 2.0)
    half = (spot[0] / 2.0, spot[1] / 2.0)
    out = []
    for axis in (0, 1):
        lo = (ground[2 * axis] - gx[axis]) * MUL
        hi = (ground[2 * axis + 1] - gx[axis]) * MUL
        out.append(min(half[axis] + lo, half[axis] - hi))
    return out


def main():
    ap = argparse.ArgumentParser(description='спрайты стартового дома -> атлас игры')
    ap.add_argument('--src', default=os.path.join(ROOT, 'out'))
    ap.add_argument('--dst', default=DEFAULT_DST)
    args = ap.parse_args()

    meta_path = os.path.join(args.src, 'sh_sprites.json')
    if not os.path.exists(meta_path):
        print('нет %s — сначала: $PY3 tools/compose_all.py' % meta_path)
        return 1
    src = json.load(open(meta_path, encoding='utf-8'))

    # Камера и разрешение: манифест `compose_all.py` их не пишет, они лежат в
    # отчёте сборки (`renders/sh_report.json` — его пишет build_live.py).
    # Нет отчёта — берём канон пайплайна: он же в константах выше.
    az_deg, el_deg, res = AZ_DEG, EL_DEG, [512, 640]
    report_path = os.path.join(ROOT, 'renders', 'sh_report.json')
    if os.path.exists(report_path):
        rep = json.load(open(report_path, encoding='utf-8'))
        az_deg = rep.get('az_deg', az_deg)
        el_deg = rep.get('el_deg', el_deg)
        res = rep.get('res', res)
    if abs(az_deg - AZ_DEG) > 1e-6 or abs(el_deg - EL_DEG) > 1e-6:
        print('камера в отчёте сборки (%s, %s) не та, что ждёт атлас (%s, %s)'
              % (az_deg, el_deg, AZ_DEG, EL_DEG))
        return 1

    gen = load_generator()
    parts = gen.build(None)

    frames, tiles = [], []
    print('%-10s %-30s %-30s %s' % ('кадр', 'контур по модели', 'контур по пикселям', 'max|Δ|'))
    for rot in ROTATIONS:
        key = 'sh_%d' % rot
        f = src['frames'].get(key)
        if not f:
            print('нет кадра %s' % key)
            return 1
        img = Image.open(f['path']).convert('RGBA')
        ax, ay = float(f['anchor'][0]), float(f['anchor'][1])
        gm = ground_from_model(parts, rot)
        gp = ground_from_pixels(img, ax, ay)
        d = max(abs(a - b) for a, b in zip(gm, gp))
        print('%-10s %-30s %-30s %.3f' % (key, gm, gp, d))
        tiles.append((key, img, rot, ax, ay, gm))

    # Раскладка: четыре поворота в ряд (у дома один вариант).
    cw = max(t[1].width for t in tiles) + 2 * PAD
    ch = max(t[1].height for t in tiles) + 2 * PAD
    atlas = Image.new('RGBA', (cw * len(ROTATIONS), ch), (0, 0, 0, 0))
    out_frames = {}
    for i, (key, img, rot, ax, ay, gm) in enumerate(tiles):
        x, y = i * cw + PAD, PAD
        atlas.alpha_composite(img, (x, y))
        name = 'sh_%s_%d' % (VARIANT, rot)
        out_frames[name] = dict(
            x=x, y=y, w=img.width, h=img.height,
            # Опора — пиксель САМОГО СПРАЙТА, а не плитки атласа: игра рисует
            # прямоугольник (x, y, w, h), то есть ровно спрайт, и `anchorX`
            # читает как долю от `w` (js/buildings.js::spriteFrom). Поэтому
            # поле PAD к опоре НЕ прибавляется — так же считает упаковщик
            # ратуши (`mapgen2/tools/pack_townhall.py`); у дома жителя старой
            # модели здесь была прибавка PAD, и опора уезжала на 2 px.
            anchorX=round(ax, 2), anchorY=round(ay, 2),
            variant=VARIANT, rotation=rot,
            footprint=footprint(rot),
            # Наземный контур (цоколь вместе с двором), клетки от точки опоры.
            ground=gm)

    os.makedirs(args.dst, exist_ok=True)
    atlas.save(os.path.join(args.dst, 'atlas.png'))
    meta = dict(
        atlas='atlas.png', ppu=src['ppu'], az_deg=az_deg, el_deg=el_deg,
        res=res,
        variants={VARIANT: list(SPOT)},
        mul=MUL,
        note='стартовый дом жителя: 1 юнит модели = 1 клетка карты, пятно 2 x 3 '
             '(при повороте 3 x 2); anchorX/anchorY — точка опоры (центр пятна '
             'застройки); footprint — пятно в клетках по повороту; ground — '
             'наземный контур (цоколь вместе с двором) в клетках от опоры, '
             'посчитан ПО МОДЕЛИ — цоколь недосложен, двор каменных столбцов не '
             'даёт, пиксельный замер видит только ближний край основания '
             '(см. шапку tools/pack_atlas.py); mul — крупность',
        frames=out_frames)
    with open(os.path.join(args.dst, 'atlas.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.dst, 'atlas.js'), 'w', encoding='utf-8') as f:
        f.write('/* атлас стартового дома жителя — то же, что atlas.json, но\n'
                '   скриптом: страница открывается по file://, где fetch JSON\n'
                '   запрещён. Тип постройки `house` в js/buildings.js читает\n'
                '   именно этот атлас. */\nwindow.STARTER_HOUSE_ATLAS = ')
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write(';\n')

    print('АТЛАС starter_house: %dx%d, кадров %d -> %s'
          % (atlas.width, atlas.height, len(out_frames), args.dst))
    print('  пятно %d x %d, крупность mul %.4f' % (SPOT[0], SPOT[1], MUL))
    for k, v in out_frames.items():
        g = visible_gaps(v['ground'], v['footprint'])
        print('  %-10s %4dx%-4d опора=(%6.1f,%6.1f) пятно=%s контур=%s зазор=%.3f/%.3f'
              % (k, v['w'], v['h'], v['anchorX'], v['anchorY'], v['footprint'],
                 v['ground'], g[0], g[1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
