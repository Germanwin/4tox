"""compose.py — пост-обработка кадров жителя: контур, тень, посадка в клетку.

    $PY3 tools/compose.py --anims idle,walk,work --tag vg
    $PY3 tools/compose.py --ppu 384 --res 576,768 --tag vg4 --out out4

Читает renders/<тег>_<анимация>_<кадр>_<поворот>_raw.png, пишет out/<тег>_...png
и out/<тег>_sprites.json.

Два канонных элемента рисуются ЗДЕСЬ, а не в меше:

* **контур** `#0E120E` — расширение силуэта на 2 px при 96 ppu (канон 0.6..3.5);
* **контактная тень** — ПЛОСКИЙ ЭЛЛИПС В ЭКРАННЫХ ПИКСЕЛЯХ. Проекция наземного
  пятна в этой изометрии всегда даёт bbox h/w = tan 30 = 0.577, а канон требует
  0.045..0.263, поэтому пятно рисуется сразу на экране, а большая ось идёт вдоль
  линии контакта ступней (у человека это направление мировой оси Y: на экране
  −30°, как у лопаты).

КЛЕТКА ФИКСИРОВАННАЯ — 112 x 132, опора в (56, 106), как в атласе героя
(mapgen2/assets/hero/atlas.json). Кадры анимации обязаны иметь ОДНУ клетку и
один якорь: иначе персонаж на экране дёргается при смене кадра.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

RES_X, RES_Y = 144, 192
PPU = 96.0
TARGET_Z = 0.42
AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
RIGHT = (math.cos(AZ), -math.sin(AZ), 0.0)
UP = (-math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))

CELL = (112, 132)          # клетка атласа (как у героя)
ANCHOR = (56.0, 106.0)     # пиксель клетки, куда проецируется (0,0,0)
OUTLINE_RGB = (14, 18, 14)
OUTLINE_DILATE = 1         # MaxFilter(3): обводка 2.00 px — как у героя
SHADOW_RGB = (11, 14, 11)
# Пятно под человеком: подобранo замером (tools/fit_shadow.py — сетка -> замер).
SHADOW = dict(a=20.0, b=4.5, angle_deg=0.0, alpha=0.55, blur=1.6, shift=(2.0, 7.5))

# Пятно рубки ШИРЕ подобранного для покоя, и это не «на глаз»: в стойке ступни
# разнесены ВПЕРЁД-НАЗАД (poses.WORK: hip_l=16, hip_r=-13), и размах контакта
# сапог, посчитанный по геометрии (villager/tools/axe_probe.py --stance),
# выходит в 1.5..1.9 раза больше, чем в покое. Силуэт от этого тоже шире, но
# пятно покоя (40 px) перестаёт ему соответствовать: гейт мерил
# ширина/силуэт 0.61..0.69 при норме 0.70..2.00 (18 WARN из 352 кадров).
# Проверено замером: a=26, b=5.0 дают 0.79..1.27 по восьми поворотам —
# внутри нормы, и ближе к ядру канона (0.85..1.05), чем пятно покоя.


SHADOW_WORK = dict(a=26.0, b=5.0, angle_deg=0.0, alpha=0.55, blur=1.6,
                   shift=(2.5, 7.5))


def project(p, res=(RES_X, RES_Y), ppu=PPU, target=(0.0, 0.0, TARGET_Z)):
    x, y, z = (p[0] - target[0], p[1] - target[1], p[2] - target[2])
    sx = x * RIGHT[0] + y * RIGHT[1] + z * RIGHT[2]
    sy = x * UP[0] + y * UP[1] + z * UP[2]
    return res[0] / 2.0 + sx * ppu, res[1] / 2.0 - sy * ppu


def ellipse_mask(size, sh):
    W, H = size
    yy, xx = np.mgrid[0:H, 0:W]
    t = math.radians(sh['angle_deg'])
    ct, st = math.cos(t), math.sin(t)
    dx = xx - sh['cx']
    dy = yy - sh['cy']
    u = (dx * ct + dy * st) / max(sh['a'], 1e-6)
    v = (-dx * st + dy * ct) / max(sh['b'], 1e-6)
    return ((u * u + v * v) <= 1.0).astype(np.uint8) * 255


def compose(raw_path, ppu=PPU, res=(RES_X, RES_Y), cell=CELL, anchor=ANCHOR,
            shadow=SHADOW, outline=True, save_path=None):
    """Один кадр -> клетка атласа. Возвращает (PIL.Image, anchorX, anchorY)."""
    img = Image.open(raw_path).convert('RGBA')
    W, H = img.size
    k = ppu / PPU
    ax, ay = project((0.0, 0.0, 0.0), res=res, ppu=ppu)

    sh = dict(shadow)
    sh['a'] *= k
    sh['b'] *= k
    sh['blur'] *= k
    sh['cx'] = ax + sh['shift'][0] * k
    sh['cy'] = ay + sh['shift'][1] * k
    m = ellipse_mask((W, H), sh)
    m = np.array(Image.fromarray(m).filter(ImageFilter.GaussianBlur(max(0.5, sh['blur']))))
    sa = (m.astype(np.float32) / 255.0) * shadow['alpha']

    base = np.array(img).astype(np.float32)
    obj_a = base[:, :, 3] / 255.0

    if outline:
        dil = max(1, int(round(OUTLINE_DILATE * k)))
        sil = (base[:, :, 3] > 8).astype(np.uint8) * 255
        grown = np.array(Image.fromarray(sil).filter(ImageFilter.MaxFilter(2 * dil + 1)))
        ring = np.clip(grown.astype(np.float32) - base[:, :, 3], 0, 255)
        ring_a = ring / 255.0
        out_a = obj_a + ring_a * (1 - obj_a)
        col = np.array(OUTLINE_RGB, np.float32)[None, None, :]
        rgb = (base[:, :, :3] * obj_a[..., None]
               + col * (ring_a * (1 - obj_a))[..., None]) / np.maximum(out_a[..., None], 1e-6)
        base = np.concatenate([rgb, (out_a * 255)[..., None]], axis=2)
        obj_a = out_a

    mixed_a = np.clip(obj_a + sa * (1 - obj_a), 0, 1)
    sh_rgb = np.array(SHADOW_RGB, np.float32)[None, None, :]
    w_sh = (sa * (1 - obj_a))[..., None]
    rgb = (base[:, :, :3] * obj_a[..., None] + sh_rgb * w_sh) / np.maximum(mixed_a[..., None], 1e-6)
    out = np.clip(np.concatenate([rgb, (mixed_a * 255)[..., None]], axis=2), 0, 255).astype(np.uint8)

    # Посадка в клетку: опора обязана лечь в ANCHOR. Окно фиксированное — иначе
    # кадры анимации поедут друг относительно друга.
    cw, ch = cell
    x0 = int(round(ax - anchor[0]))
    y0 = int(round(ay - anchor[1]))
    canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    src = Image.fromarray(out, 'RGBA')
    canvas.alpha_composite(src, (-x0, -y0))
    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        canvas.save(save_path)
    return canvas, anchor[0], anchor[1]


# Число кадров, к/с и зацикленность анимаций берутся из poses.ANIMS — из ТОГО ЖЕ
# файла, которым собраны кадры, а не из отчёта рендера. Отчёт пишется на каждый
# прогон build_live.py, и прогон ОДНОЙ анимации (например, только рубки) оставлял
# в нём одну строку: compose тогда считал бы, что в покое 8 кадров вместо 6, и
# половина кадров покоя в атлас бы не попала. Один источник правды дешевле
# сверки двух.
FALLBACK_ANIMS = {'idle': dict(frames=6, fps=8.0, loop=True),
                  'walk': dict(frames=8, fps=12.0, loop=True),
                  'work': dict(frames=8, fps=12.0, loop=False)}


def anims_from_code():
    try:
        import poses as PO
    except Exception:
        return None
    out = {}
    for name, (fn, n, fps, loop) in PO.ANIMS.items():
        out[name] = dict(frames=n, fps=fps, loop=loop)
    return out or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--anims', default='idle,walk,work')
    ap.add_argument('--frames', default=None, help='через запятую; иначе все')
    ap.add_argument('--rotations', default='0,90,180,270')
    ap.add_argument('--tag', default='vg')
    ap.add_argument('--ppu', type=float, default=PPU)
    ap.add_argument('--res', default='%d,%d' % (RES_X, RES_Y))
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--shadow', default=None, help='JSON: a,b,angle_deg,alpha,blur,shift')
    args = ap.parse_args()

    res = tuple(int(v) for v in args.res.split(','))
    rotations = [int(r) for r in args.rotations.split(',')]
    anims = args.anims.split(',')
    shadow = dict(SHADOW)
    if args.shadow:
        shadow.update(json.loads(args.shadow))
    shadow_by_anim = {'work': SHADOW_WORK}
    k = args.ppu / PPU
    cell = (int(round(CELL[0] * k)), int(round(CELL[1] * k)))
    anchor = (ANCHOR[0] * k, ANCHOR[1] * k)

    sys.path.insert(0, HERE)
    rep_path = os.path.join(RENDERS, '%s_report.json' % args.tag)
    rep = {}
    if os.path.exists(rep_path):
        rep = json.load(open(rep_path, encoding='utf-8'))
    anims_meta = anims_from_code() or rep.get('anims') or FALLBACK_ANIMS
    frames = [int(f) for f in args.frames.split(',')] if args.frames else None

    out_frames = {}
    for anim in anims:
        n = anims_meta.get(anim, {}).get('frames', 8)
        todo = frames if frames else list(range(n))
        for fr in todo:
            for rot in rotations:
                raw = os.path.join(RENDERS, '%s_%s_%d_%d_raw.png' % (args.tag, anim, fr, rot))
                if not os.path.exists(raw):
                    print('НЕТ РЕНДЕРА: %s' % raw)
                    continue
                name = '%s_%s_%d_%d' % (args.tag, anim, fr, rot)
                dst = os.path.join(args.out, name + '.png')
                sh = dict(shadow)
                if args.shadow is None:
                    sh.update(shadow_by_anim.get(anim, {}))
                img, ax, ay = compose(raw, ppu=args.ppu, res=res, cell=cell,
                                      anchor=anchor, shadow=sh, save_path=dst)
                out_frames[name] = dict(file=os.path.basename(dst), w=img.width,
                                        h=img.height, anchorX=round(ax, 2),
                                        anchorY=round(ay, 2), anim=anim, frame=fr,
                                        rotation=rot)
                print('COMPOSED %s %dx%d опора=(%.1f,%.1f)'
                      % (name, img.width, img.height, ax, ay))

    meta = dict(tag=args.tag, ppu=args.ppu, ortho=res[1] / args.ppu, res=list(res),
                az_deg=45.0, el_deg=math.degrees(EL), cell=list(cell),
                anims=anims_meta, shadow=shadow,
                # Пятно рубки шире (см. SHADOW_WORK): в атласе оно уже ВПИТАНО в
                # кадры, а это поле — для того, кто будет их пересобирать.
                shadow_by_anim=dict(shadow_by_anim),
                outline=dict(rgb=list(OUTLINE_RGB), dilate=OUTLINE_DILATE),
                note='житель (мужчина): 1 юнит = 1 клетка карты; клетка и якорь — как у '
                     'героя (112x132, опора 56,106); anchorX/anchorY — пиксель '
                     'клетки, куда проецируется (0,0,0), то есть земля между '
                     'ступнями', frames=out_frames)
    path = os.path.join(args.out, '%s_sprites.json' % args.tag)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print('%s записан (кадров %d)' % (os.path.basename(path), len(out_frames)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
