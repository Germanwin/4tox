"""sheet_anim.py — контактный лист анимации: 8 поворотов x N кадров одним PNG.

    $PY3 tools/sheet_anim.py --anim carry
    $PY3 tools/sheet_anim.py --anim walk_axe --scale 4

Зачем отдельный лист, если кадры и так лежат в out/: смотреть анимацию по одному
файлу нельзя — мерцание, провал силуэта и «поехавшая» опора видны только рядом.
Раскладка повторяет атлас: строка = поворот (0/45/.../315), столбец = кадр, —
поэтому лист читается тем же глазом, что и атлас, и любая строка сразу
сравнивается с соседней.

Что на листе нарисовано сверх кадров:
  * ЛИНИЯ ЗЕМЛИ и засечка опоры (56,106): у всех кадров анимации опора обязана
    стоять на одной высоте — «поехавшая» опора это первое, что видно на листе;
  * номера кадров и градусы поворотов;
  * в отчёте (<имя>_jumps.json) — средняя разница соседних кадров: ею меряется
    МЕРЦАНИЕ. Порог 45 (тот же, что у скилла animation-quality-gate) — выше
    значит в анимации рывок, а не движение.

Кадры берутся из out/ (1x) или out4/ (@4x) — те же файлы, что уходят в атлас:
лист обязан показывать то, что поедет в игру, а не отдельную сборку.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ROTS = (0, 45, 90, 135, 180, 225, 270, 315)
CELL = (112, 132)
ANCHOR = (56, 106)
BG = (243, 242, 236, 255)
GROUND = (170, 150, 120, 255)
JUMP_LIMIT = 45.0


def load(anim, frame, rot, src, tag):
    p = os.path.join(src, '%s_%s_%d_%d.png' % (tag, anim, frame, rot))
    return Image.open(p).convert('RGBA') if os.path.exists(p) else None


def jumps(imgs):
    """Средняя |ΔRGB| между соседними кадрами строки (по непрозрачным пикселям)."""
    out = []
    for a, b in zip(imgs, imgs[1:]):
        aa = np.asarray(a.convert('RGB'), float)
        bb = np.asarray(b.convert('RGB'), float)
        m = (np.asarray(a)[..., 3] > 8) | (np.asarray(b)[..., 3] > 8)
        out.append(round(float(np.abs(aa - bb)[m].mean()) if m.any() else 0.0, 2))
    return out


def main():
    ap = argparse.ArgumentParser(description='контактный лист анимации')
    ap.add_argument('--anim', default='carry')
    ap.add_argument('--frames', type=int, default=8)
    ap.add_argument('--scale', type=int, default=3)
    ap.add_argument('--src', default=None, help='out (1x) или out4 (@4x)')
    ap.add_argument('--tag', default=None)
    ap.add_argument('--out', default=os.path.join(ROOT, 'out', 'show'))
    a = ap.parse_args()

    src = a.src or os.path.join(ROOT, 'out')
    tag = a.tag or ('vg4' if 'out4' in src else 'vg')
    k = a.scale
    cw, ch = CELL[0] * k, CELL[1] * k
    lab = 74                       # ширина колонки подписей поворотов
    head = 26                      # высота строки с номерами кадров
    pad = 4
    W = lab + a.frames * (cw + pad) + pad
    H = head + len(ROTS) * (ch + pad) + pad + 22
    sheet = Image.new('RGBA', (W, H), BG)
    d = ImageDraw.Draw(sheet)
    for c in range(a.frames):
        d.text((lab + c * (cw + pad) + cw // 2 - 14, 8), 'кадр %d' % c,
               fill=(40, 40, 40, 255))
    report = {}
    for r, rot in enumerate(ROTS):
        y0 = head + r * (ch + pad)
        d.text((6, y0 + ch // 2), '%3d°' % rot, fill=(40, 40, 40, 255))
        imgs = []
        for c in range(a.frames):
            im = load(a.anim, c, rot, src, tag)
            if im is None:
                continue
            imgs.append(im)
        if not imgs:
            continue
        for c, im in enumerate(imgs):
            x = lab + c * (cw + pad)
            big = im.resize((cw, ch), Image.NEAREST)
            sheet.alpha_composite(big, (x, y0))
            # линия земли и засечка опоры — по ним видно, не поехала ли опора
            gy = y0 + ANCHOR[1] * k
            if c == 0:
                d.line([(lab, gy), (W - pad, gy)], fill=GROUND)
            d.line([(x + ANCHOR[0] * k, gy - 3), (x + ANCHOR[0] * k, gy + 3)],
                   fill=(200, 90, 60, 255))
        report['%d' % rot] = jumps(imgs)

    note = ('%s: %d поворотов x %d кадров; средняя |ΔRGB| соседних кадров; '
            'порог мерцания %.0f' % (a.anim, len(ROTS), a.frames, JUMP_LIMIT))
    d.text((6, H - 16), note, fill=(40, 40, 40, 255))
    os.makedirs(a.out, exist_ok=True)
    png = os.path.join(a.out, '%s_%dx%d.png' % (a.anim, len(ROTS), a.frames))
    sheet.convert('RGB').save(png)
    worst = max((max(v) if v else 0.0, int(r)) for r, v in report.items())
    with open(os.path.join(a.out, '%s_jumps.json' % a.anim), 'w',
              encoding='utf-8') as f:
        json.dump(dict(anim=a.anim, scale=k, src=src, jumps_by_rot=report,
                       limit=JUMP_LIMIT, worst=worst[0]),
                  f, ensure_ascii=False, indent=1)
    print('ЛИСТ %s  (%dx%d)' % (png, sheet.width, sheet.height))
    for r in sorted(report, key=lambda x: int(x)):
        v = report[r]
        flag = '  МЕРЦАНИЕ' if v and max(v) > JUMP_LIMIT else ''
        print('  %3s°: %s%s' % (r, ' '.join('%.1f' % x for x in v), flag))
    print('худший переход между кадрами: %.2f (порог %.0f)' % (worst[0], JUMP_LIMIT))
    return 0 if worst[0] <= JUMP_LIMIT else 1


if __name__ == '__main__':
    sys.exit(main())
