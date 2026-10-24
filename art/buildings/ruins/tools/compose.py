"""compose.py — из сырого кадра сделать СПРАЙТ: обрезка, контур, контактная тень.

    $PY3 compose.py --raw renders/bs_x_0_raw.png --out out/bs_0.png \
         --shadow-x 0.9 --shadow-y 0.0

Зачем отдельный шаг.  Сырой рендер — это картинка сцены: постройка висит в
центре кадра, у неё нет контура, и под ней нет пятна тени.  В атласе игры
спрайт — это ВЫРЕЗАННЫЙ объект с контуром и тенью, прижатый к точке опоры:
именно по точке опоры движок ставит его на карту, и именно контур отделяет
постройку от фона.

ТЕНИ У ПОСТРОЕК ЭТОЙ ИГРЫ НЕТ — правило заказчика (2026-10-17): «убери тени у
зданий».  Кадры для атласа собираются с ключом `--no-shadow`: контур и точка
опоры остаются канонными, а пятно под силуэтом не рисуется.  Рамка кадра и
опора при этом НЕ меняются — спрайт стоит на карте там же, где стоял с тенью,
и снятие тени не двигает постройку ни на пиксель.  Прежние кадры с тенью
остаются в силе для тех, кому тень нужна (гейт кадра её по-прежнему умеет
мерить); умолчание инструмента не тронуто.

Порядок операций жёсткий:
    1) найти силуэт (альфа > 0) и обрезать кадр с полем `pad`;
    2) нарисовать контактную тень — эллипс в ПРОЕКЦИИ, а не круг: в изометрии
       2:1 круг превращается в эллипс с отношением осей 1:0.577;
    3) расширить силуэт на `dilate` пикселей и залить контуром;
    4) отдать PNG с прозрачным фоном и записать точку опоры в JSON.

Пороговые значения (толщина контура, размеры и прозрачность тени) — из канона
палитры скилла `4tox-lowpoly-3d` (`references/palette.json → outline, shadow`),
их проверяет гейт кадра (`scripts/audit.py`).
"""
import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageFilter

# Контур: почти чёрный с зеленоватым уходом (как у эталонов атласа).
OUTLINE_RGB = (12, 16, 12)
OUTLINE_DILATE = 1                 # px при 96 ppu
SHADOW_RGB = (0, 0, 0)
SHADOW = dict(a=1.35, b=0.36, angle_deg=8.0, alpha=0.40, blur=2.2,
              spread=0.55)         # a — ШИРИНА пятна в долях ширины силуэта
# Гейт кадра требует ширину пятна 0.7..2.0 от ширины силуэта: при 0.62 он даёт
# WARN «пятно есть, но не по канону».  b — полуось по Y в тех же долях.
ELLIPSE_K = math.sin(math.radians(35.2644))     # сжатие круга в изометрии 2:1


def ellipse_mask(size, cx, cy, a, b, angle_deg, blur):
    """Маска эллипса (a, b — полуоси в пикселях), повёрнутого на angle_deg."""
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    th = math.radians(angle_deg)
    dx, dy = xx - cx, yy - cy
    u = dx * math.cos(th) + dy * math.sin(th)
    v = -dx * math.sin(th) + dy * math.cos(th)
    d = (u / max(a, 0.5)) ** 2 + (v / max(b, 0.5)) ** 2
    # профиль пятна: 1 внутри, 0 снаружи, переход шириной около 0.35 радиуса.
    # Крутая кромка (1.0 - d) даёт пятно уже задуманного: гейт мерит ширину по
    # порогу альфы, и размытый край в замер не попадает.
    m = np.clip((1.12 - d) / 0.35, 0.0, 1.0)
    img = Image.fromarray((m * 255).astype(np.uint8))
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(img, np.float32) / 255.0


def compose(raw_path, out_path, shadow_x=0.0, shadow_y=0.0, outline=True,
            pad=3, ppu=96.0, scale_k=None, write_json=True, anchor_raw=None,
            shadow_a=None, shadow_b=None, shadow_alpha=None, shadow=True):
    """Собрать спрайт.  Возвращает (путь, точка опоры X, Y, размеры).

    `anchor_raw = (x, y)` — точка опоры В СЫРОМ КАДРЕ, если её надо задать
    явно.  По умолчанию опора берётся по низу силуэта (низ, центр по X) — так
    и делали прежние постройки.  Но игра читает `anchorX/anchorY` как «пиксель
    кадра, куда проецируется ЦЕНТР ПЯТНА застройки» (`js/buildings.js`,
    `spriteFrom`), а это не низ силуэта: у лагеря лесоруба низ силуэта —
    передний пень, он на 2.2 клетки впереди центра пятна.

    Камера пайплайна ортографическая и смотрит в начало координат, поэтому
    центр пятна (0, 0, 0) проецируется ровно в центр кадра: (res_x/2, res_y/2)
    — при кадре 512 x 640 это (256, 320).  Проверяется числом: сверка силуэта
    спрайта с проекцией габарита модели без явной опоры даёт расхождение
    87..111 px, с ней — 0.8..2.0 px (`references/case-lumbercamp.md`).

    `shadow_a` — ШИРИНА пятна тени в долях ширины силуэта (канон 1.35 для
    компактной постройки).  У дворов с разреженным широким силуэтом канонное
    число уходит из-под предметов «серым озером», и его подбирают прогоном по
    ВСЕМ четырём поворотам (лагерь: 1.40 — минимум, что проходит везде).
    Гейт требует 0.70..2.0 и мерит пятно НИЖЕ силуэта.

    `shadow = False` — пятна нет вовсе (правило заказчика: у зданий этой игры
    тени нет).  Габарит кадра считается ТОЙ ЖЕ формулой, что с тенью: место
    под пятно остаётся прозрачным, и кадр с `--no-shadow` отличается от кадра
    с тенью ровно пикселями пятна — ни опора, ни рамка, ни посадка в игре не
    меняются.  Поэтому тень можно снять с уже собранного атласа, не перемеряя
    ни одного числа.
    """
    im = Image.open(raw_path).convert('RGBA')
    a = np.asarray(im)[:, :, :3].astype(np.float32)
    al = np.asarray(im)[:, :, 3].astype(np.float32) / 255.0
    ys, xs = np.nonzero(al > 0.35)
    if not len(xs):
        raise SystemExit('%s: пустой кадр (нет силуэта)' % raw_path)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    # точка опоры: низ силуэта, центр по X, плюс сдвиг под тень — либо явная
    if anchor_raw is None:
        ax = int(round((x0 + x1) / 2.0 + shadow_x * float(ppu)))
        ay = int(y1)
    else:
        ax, ay = float(anchor_raw[0]), float(anchor_raw[1])
    k = 1.0 if scale_k is None else float(scale_k)
    dilate = max(1, int(round(OUTLINE_DILATE * k)))
    sh_a = SHADOW['a'] if shadow_a is None else float(shadow_a)
    sh_b = SHADOW['b'] if shadow_b is None else float(shadow_b)
    sh_al = SHADOW['alpha'] if shadow_alpha is None else float(shadow_alpha)

    w, h = x1 - x0 + 1, y1 - y0 + 1
    sw = int(round(w * (1.0 + 2.0 * SHADOW['spread']))) + 2 * pad
    sh = int(round(h * (1.0 + 2.0 * SHADOW['spread']))) + 2 * pad
    W = max(sw, w + 2 * pad + 2 * dilate)
    H = max(sh, h + 2 * pad + 2 * dilate)
    ox, oy = (W - w) // 2, (H - h) // 2

    rgb = np.zeros((H, W, 3), np.float32)
    alpha = np.zeros((H, W), np.float32)
    rgb[oy:oy + h, ox:ox + w] = a[y0:y1 + 1, x0:x1 + 1]
    alpha[oy:oy + h, ox:ox + w] = al[y0:y1 + 1, x0:x1 + 1]

    # 1) тень: эллипс под силуэтом, в проекции изометрии.  `shadow=False` —
    # пятна нет: маска не рисуется, а альфа остаётся силуэтной.  Рамка кадра
    # (W, H) и опора считаются выше одной формулой на оба случая, поэтому
    # спрайт без тени стоит на карте там же, где стоял с тенью.
    if shadow:
        cx = ox + w / 2.0 + shadow_x * float(ppu)
        cy = oy + h - sh_b * w * ELLIPSE_K * 0.5 + shadow_y * float(ppu)
        m = ellipse_mask((W, H), cx, cy, sh_a * w * 0.5,
                         sh_b * w * 0.5 * ELLIPSE_K, SHADOW['angle_deg'],
                         SHADOW['blur'] * k)
        out_a = np.maximum(alpha, m * sh_al)
    else:
        out_a = alpha
    sh_rgb = np.array(SHADOW_RGB, np.float32)[None, None, :]
    out_rgb = np.where((alpha > 0.02)[:, :, None], rgb,
                       sh_rgb * np.ones((H, W, 1), np.float32))

    sprite = np.concatenate([out_rgb, (out_a * 255.0)[:, :, None]], axis=2)

    # 2) контур: расширение силуэта (тень в контур не входит)
    if outline:
        layer = Image.fromarray(sprite.astype(np.uint8))
        al_img = layer.getchannel('A')
        grown = al_img.filter(ImageFilter.MaxFilter(2 * dilate + 1))
        ring = np.asarray(grown, np.float32) / 255.0 - \
            np.asarray(al_img, np.float32) / 255.0
        ring = np.clip(ring, 0.0, 1.0)
        oc = np.array(OUTLINE_RGB, np.float32)[None, None, :]
        base = sprite[:, :, :3]
        sprite[:, :, :3] = np.where(ring[:, :, None] > 0.5, oc, base)
        sprite[:, :, 3] = np.maximum(sprite[:, :, 3],
                                     (ring * 255.0).astype(np.float32))

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    Image.fromarray(sprite.astype(np.uint8)).save(out_path)
    anchor = [int(round(ox + (ax - x0))), int(round(oy + (ay - y0)))]
    if write_json:
        with open(os.path.splitext(out_path)[0] + '.json', 'w',
                  encoding='utf-8') as f:
            json.dump(dict(raw=os.path.basename(raw_path), anchor=anchor,
                           size=[W, H], ppu=ppu, outline=bool(outline),
                           dilate=dilate), f, ensure_ascii=False, indent=1)
    return out_path, anchor[0], anchor[1], (W, H)


def main():
    ap = argparse.ArgumentParser(description='сырой кадр -> спрайт')
    ap.add_argument('--raw', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ppu', type=float, default=96.0)
    ap.add_argument('--shadow-x', type=float, default=0.0,
                    help='сдвиг тени и опоры по X в юнитах')
    ap.add_argument('--shadow-y', type=float, default=0.0)
    ap.add_argument('--shadow-a', type=float, default=None,
                    help='ширина пятна тени в долях ширины силуэта '
                         '(канон 1.35; у дворов подбирается по 4 поворотам)')
    ap.add_argument('--shadow-b', type=float, default=None,
                    help='полуось пятна по Y в тех же долях (канон 0.36)')
    ap.add_argument('--shadow-alpha', type=float, default=None,
                    help='плотность пятна (канон 0.40)')
    ap.add_argument('--no-shadow', action='store_true',
                    help='не рисовать контактную тень вовсе (тени у зданий '
                         'этой игры нет — правило заказчика)')
    ap.add_argument('--anchor-raw', default=None,
                    help='точка опоры в сыром кадре, X,Y: ЦЕНТР ПЯТНА '
                         '(при 512x640 это 256,320).  Умолчание — низ силуэта')
    ap.add_argument('--no-outline', action='store_true')
    ap.add_argument('--json', dest='json_out')
    args = ap.parse_args()
    an = None
    if args.anchor_raw:
        an = [float(v) for v in args.anchor_raw.split(',')]
    path, ax, ay, size = compose(args.raw, args.out, args.shadow_x,
                                 args.shadow_y, outline=not args.no_outline,
                                 ppu=args.ppu, anchor_raw=an,
                                 shadow_a=args.shadow_a, shadow_b=args.shadow_b,
                                 shadow_alpha=args.shadow_alpha,
                                 shadow=not args.no_shadow)
    print('%s  %dx%d  опора %d,%d' % (path, size[0], size[1], ax, ay))
    if args.json_out:
        with open(os.path.splitext(args.out)[0] + '.json', 'w',
                  encoding='utf-8') as f:
            json.dump(dict(path=args.out, anchor=[ax, ay], size=list(size),
                           ppu=args.ppu), f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
