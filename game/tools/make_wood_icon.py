"""make_wood_icon.py — иконка дров для строки ресурсов, из НАСТОЯЩЕЙ охапки.

Почему не готовая иконка из набора и не рисунок «на глаз»: охапку, которую
житель несёт из леса, собирает `art/characters/villager/tools/person.py`
(`build_logs`) — четыре бревна, кора `trunk`, торцы `leaf_autumn`. Здесь берётся
РОВНО эта геометрия, без фигуры, и рендерится тем же софт-рендером и той же
камерой, что у спрайтов (`xray.py`: азимут 45°, подъём 35.264°). Поэтому иконка
в интерфейсе — те же брёвна, что на карте, а не похожие.

Blender для этого не нужен: форма уже заморожена в person.py, а тут только
пакетный рендер 2D-иконки. Ничего в `art/` не пишется.

Запуск (нужен numpy и Pillow):
    $PY3 game/tools/make_wood_icon.py
    $PY3 game/tools/make_wood_icon.py --out game/assets/wood.png

Результат — `game/assets/wood.png`: прозрачный фон, контур цветом обводки игры
(`--outline`), высота 72 px (показывается вдвое мельче, поэтому на экране с
плотностью 2 он резкий).
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.dirname(HERE)
REPO = os.path.dirname(GAME)
VILLAGER_TOOLS = os.path.join(REPO, 'art', 'characters', 'villager', 'tools')
if VILLAGER_TOOLS not in sys.path:
    sys.path.insert(0, VILLAGER_TOOLS)

import person as H          # noqa: E402
import poses as PO         # noqa: E402
import xray as X           # noqa: E402

# Тот же кадр, в котором охапка у жителя в руках: поза carry, кадр 0.
POSE = ('carry', 0)

# Высота готовой иконки. 72 px — это 2x от 36 px на экране: при плотности 2
# браузер не растягивает картинку, а при плотности 1 аккуратно ужимает.
OUT_H = 72

# Цвет обводки — тот же, что у спрайтов и интерфейса (base.css: --outline).
OUTLINE = (59, 42, 25, 255)

# Сколько пикселей обводки. 2 px при высоте 72 — это ~1 px на экране: силуэт
# читается, но не превращается в жирную кляксу.
OUTLINE_PX = 2


def build_icon(scale=1000.0, w=640, h=420, margin=7):
    """Охапка без человека → RGBA-картинка с прозрачным фоном и контуром."""
    anim, frame = POSE
    pose = H.pose_of(variant='m', **PO.pose(anim, frame))
    mats = H.skeleton(pose)
    parts = H.build_logs(pose, mats)
    if not parts:
        raise SystemExit('person.build_logs вернул пусто: охапки нет')

    verts = np.asarray([v for part in parts for v in part['verts']], float)
    center = tuple((verts.min(0) + verts.max(0)) / 2.0)
    mesh = X.mesh(parts)
    shot = X.render(mesh, W=w, Hh=h, az=45.0, el=35.264389682754654,
                    scale=scale, center=center)

    # Фон софт-рендера — тёмная заливка, а не альфа. Маска — id-буфер: там, где
    # не нарисован ни один треугольник, id = -1.
    mask = shot['id'] >= 0
    if not mask.any():
        raise SystemExit('на кадре нет охапки: проверьте камеру и scale')
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())

    rgb = np.clip(shot['img'] * 255.0, 0, 255).astype(np.uint8)
    alpha = np.where(mask, 255, 0).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])
    cut = Image.fromarray(rgba, 'RGBA').crop((x0, y0, x1 + 1, y1 + 1))

    # Крупный рендер ужимается до высоты иконки: так края получаются ровными, а
    # не ступенчатыми, как при рендере сразу в 72 px.
    k = OUT_H / float(cut.height)
    cut = cut.resize((max(1, round(cut.width * k)), OUT_H), Image.LANCZOS)

    canvas = Image.new('RGBA', (cut.width + 2 * margin, cut.height + 2 * margin),
                       (0, 0, 0, 0))
    alpha_layer = Image.new('L', canvas.size, 0)
    alpha_layer.paste(cut.getchannel('A'), (margin, margin))
    grown = alpha_layer.filter(ImageFilter.MaxFilter(2 * OUTLINE_PX + 1))
    outline = Image.new('RGBA', canvas.size, OUTLINE)
    outline.putalpha(grown)
    canvas.alpha_composite(outline)
    canvas.alpha_composite(cut, (margin, margin))
    return canvas


def main():
    ap = argparse.ArgumentParser(description='иконка дров из охапки жителя')
    ap.add_argument('--out', default=os.path.join(GAME, 'assets', 'wood.png'))
    ap.add_argument('--scale', type=float, default=1000.0,
                    help='пикселей на юнит в сыром рендере')
    args = ap.parse_args()

    icon = build_icon(scale=args.scale)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    icon.save(args.out)
    print('-> %s (%d x %d)' % (args.out, icon.width, icon.height))


if __name__ == '__main__':
    main()
