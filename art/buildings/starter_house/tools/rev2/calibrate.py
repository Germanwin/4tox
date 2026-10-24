"""calibrate.py — подбор ЗАТЕМНЕНИЯ материалов по замеру кадра.

Материал и спрайт — разные вещи: сцена поднимает тон (солнце 2.05 + небо
0.42), поэтому базовые цвета обязаны быть темнее целевых.  Стиль-гейт требует
>= 93 % пикселей объекта в палитре атласа; при DARKEN = 1.0 выходило 36 %.

Скрипт делает перебор: ставит DARKEN, собирает кадр в ЖИВОМ Blender через
MCP и мерит долю пикселей в палитре.  Печатает таблицу — по ней выбирается
множитель (он живёт в tools/palette.py, рядом с цветами).

    $PY3 tools/calibrate.py --values 0.55,0.6,0.65,0.7,0.75
"""
import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
sys.path.insert(0, HERE)

PAL = os.path.join(HERE, 'palette.py')
RAW = os.path.join(ROOT, 'renders', 'cal_0_raw.png')
BLMCP = os.path.join(HERE, 'blmcp.py')
PY = sys.executable

TONES = []


def load_tones():
    global TONES
    path = os.path.expanduser(
        '~/.dsh/skills/4tox-lowpoly-3d/references/palette.json')
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    TONES = []
    for fam, t in data['tones'].items():
        for key in ('light', 'mid', 'dark'):
            c = t[key].lstrip('#')
            TONES.append((int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)))
    TONES = np.array(TONES, float)
    return TONES


def set_darken(v):
    src = open(PAL, encoding='utf-8').read()
    out = re.sub(r'^DARKEN = [0-9.]+', 'DARKEN = %.3f' % v, src, count=1,
                 flags=re.M)
    assert out != src or ('DARKEN = %.3f' % v) in src, 'DARKEN не найден'
    open(PAL, 'w', encoding='utf-8').write(out)


def render():
    subprocess.run([PY, BLMCP, 'run', 'tools/build_live.py',
                    '--config', 'live_cal.json'], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL)


def share_in_palette():
    a = np.asarray(Image.open(RAW).convert('RGBA')).astype(float)
    m = a[:, :, 3] > 200
    px = a[:, :, :3][m]
    d = np.abs(px[:, None, :] - TONES[None, :, :]).max(axis=2).min(axis=1)
    return 100.0 * float(np.mean(d <= 26)), float(np.median(d))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--values', default='0.55,0.62,0.68,0.74,0.80')
    args = ap.parse_args()
    load_tones()
    with open(os.path.join(ROOT, 'live_cal.json'), 'w', encoding='utf-8') as f:
        json.dump(dict(rotations=[0], samples=48, ppu=80, res=[512, 640],
                       export=False, save_blend=False, viewport=False,
                       tag='cal'), f)
    print('%-8s %-14s %s' % ('DARKEN', 'в палитре %', 'медиана Δ'))
    best = (None, -1.0)
    for v in [float(x) for x in args.values.split(',')]:
        set_darken(v)
        render()
        share, med = share_in_palette()
        print('%-8.3f %-14.1f %.1f' % (v, share, med))
        if share > best[1]:
            best = (v, share)
    set_darken(best[0])
    print('лучшее DARKEN = %.3f (%.1f %% в палитре) — записано в palette.py'
          % best)
    return 0


if __name__ == '__main__':
    sys.exit(main())
