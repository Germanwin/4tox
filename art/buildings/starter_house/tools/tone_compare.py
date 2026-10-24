"""tone_compare.py — чем спрайт дома отличается от спрайта ратуши, ЧИСЛАМИ.

    $PY3 tools/tone_compare.py

Берёт кадр ратуши из атласа игры и спрайт дома, приводит их к одному масштабу
мира и считает, какая доля пикселей объекта приходится на каждую из двенадцати
красок канона (ближайший тон из `village_palette.json`).  Это ответ на вопрос
«тот же цвет, та же детализация?» числами, а не словами.
"""
import json
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Путь до атласа ратуши считается от места файла, а не пишется абсолютным:
# абсолютный ломается при первом же переезде репозитория и ломается молча
# (docs/STRUCTURE.md §6.2). Уровни: tools -> starter_house -> buildings -> art.
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
ATLAS = os.path.join(REPO, 'mapgen2', 'assets', 'townhall', 'atlas.png')
ATLAS_JSON = os.path.join(REPO, 'mapgen2', 'assets', 'townhall', 'atlas.json')
PALETTE = os.path.join(HERE, 'village_palette.json')
OUTLINE = np.array([12, 16, 12], float)


def tones():
    pal = json.load(open(PALETTE, encoding='utf-8'))
    fam, cols = [], []
    for k, v in pal['tones'].items():
        fam.append(k)
        cols.append([int(v[t].lstrip('#'), 16) for t in ('light', 'mid', 'dark')])
    return fam, np.array([[((c >> s) & 255) for s in (16, 8, 0)]
                          for trio in cols for c in trio], float)


def load_ref(variant='a', rot=0):
    meta = json.load(open(ATLAS_JSON, encoding='utf-8'))
    fr = meta['frames']['townhall_%s_%d' % (variant, rot)]
    im = Image.open(ATLAS).convert('RGBA').crop(
        (fr['x'], fr['y'], fr['x'] + fr['w'], fr['y'] + fr['h']))
    return im


def report(name, im, fam, cols):
    a = np.asarray(im.convert('RGB')).astype(float)
    alpha = np.asarray(im.convert('RGBA'))[:, :, 3]
    mask = alpha > 0
    # объект = непрозрачное и не контур
    d_out = np.abs(a - OUTLINE).sum(axis=2)
    obj = mask & (d_out > 40)
    px = a[mask]
    px_obj = a[obj]
    d = np.abs(px_obj[:, None, :] - cols[None, :, :]).sum(axis=2)
    near = d.argmin(axis=1)
    share = {}
    for i, k in enumerate(fam):
        share[k] = 100.0 * ((near >= i * 3) & (near < i * 3 + 3)).mean()
    print('%-22s пикселей %6d  средний тон %s  медиана %s'
          % (name, obj.sum(),
             np.round(px_obj.mean(axis=0)).astype(int),
             np.round(np.median(px_obj, axis=0)).astype(int)))
    return share


def main():
    fam, cols = tones()
    ref = load_ref()
    mine = Image.open(os.path.join(ROOT, 'out', 'sh_0.png')).convert('RGBA')
    a = report('ратуша (эталон)', ref, fam, cols)
    b = report('дом (ранняя стадия)', mine, fam, cols)
    print('\nдоля пикселей по краскам канона, %%:')
    print('%-10s %8s %8s %8s' % ('краска', 'ратуша', 'дом', 'разница'))
    for k in fam:
        print('%-10s %8.1f %8.1f %+8.1f' % (k, a[k], b[k], b[k] - a[k]))


if __name__ == '__main__':
    main()
