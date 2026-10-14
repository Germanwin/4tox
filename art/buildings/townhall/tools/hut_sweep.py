"""Перебор вариантов пропорций хижины: рендер пачки кадров для оценки силуэта.

    blender -b --factory-startup -P tools/hut_sweep.py -- --out ref/sweep

Пишет <out>/v<номер>.png (RGBA, без пост-обработки) — дальше ref/score.py
считает совпадение силуэта с эталоном.
"""
import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import thpipe as P
import hut as H

ROOT = os.path.dirname(HERE)

VARIANTS = [
    dict(name='r1_план0.95', A_WALL=0.95, B_WALL=1.05, WALL_H=1.25, EAVE_Z=1.23, RIDGE_Z=2.25, OVER_GABLE=0.14, OVER_EAVE=0.12),
    dict(name='r2_план0.90', A_WALL=0.90, B_WALL=1.00, WALL_H=1.25, EAVE_Z=1.23, RIDGE_Z=2.20, OVER_GABLE=0.12, OVER_EAVE=0.10),
    dict(name='r3_текущий', A_WALL=1.02, B_WALL=1.12, WALL_H=1.25, EAVE_Z=1.23, RIDGE_Z=2.40, OVER_GABLE=0.16, OVER_EAVE=0.14),
    dict(name='r4_стена1.35', A_WALL=0.95, B_WALL=1.05, WALL_H=1.35, EAVE_Z=1.33, RIDGE_Z=2.35, OVER_GABLE=0.14, OVER_EAVE=0.12),
    dict(name='r5_стена1.35_план0.9', A_WALL=0.90, B_WALL=1.00, WALL_H=1.35, EAVE_Z=1.33, RIDGE_Z=2.30, OVER_GABLE=0.12, OVER_EAVE=0.10),
    dict(name='r6_стена1.15', A_WALL=0.95, B_WALL=1.05, WALL_H=1.15, EAVE_Z=1.13, RIDGE_Z=2.15, OVER_GABLE=0.14, OVER_EAVE=0.12),
    dict(name='r7_план1.08', A_WALL=1.08, B_WALL=1.18, WALL_H=1.25, EAVE_Z=1.23, RIDGE_Z=2.50, OVER_GABLE=0.18, OVER_EAVE=0.16),
    dict(name='r8_план0.85_стена1.35', A_WALL=0.85, B_WALL=0.95, WALL_H=1.35, EAVE_Z=1.33, RIDGE_Z=2.25, OVER_GABLE=0.12, OVER_EAVE=0.10),
    dict(name='r9_свес+', A_WALL=0.92, B_WALL=1.02, WALL_H=1.25, EAVE_Z=1.23, RIDGE_Z=2.25, OVER_GABLE=0.22, OVER_EAVE=0.20),
    dict(name='r10_стена1.45', A_WALL=0.92, B_WALL=1.02, WALL_H=1.45, EAVE_Z=1.43, RIDGE_Z=2.45, OVER_GABLE=0.14, OVER_EAVE=0.12),
]


def argv():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def opt(name, default=None):
    a = argv()
    if name in a:
        i = a.index(name)
        if i + 1 < len(a) and not a[i + 1].startswith('--'):
            return a[i + 1]
        return True
    return default


def main():
    out = opt('--out', os.path.join(ROOT, 'ref', 'sweep'))
    os.makedirs(out, exist_ok=True)
    meta = []
    for i, v in enumerate(VARIANTS):
        kw = {k: x for k, x in v.items() if k != 'name'}
        P.clear_scene()
        H.reset_palette()
        P.setup_camera()
        P.setup_light()
        P.setup_render(samples=8)
        bpy.context.scene.render.resolution_x = 320
        bpy.context.scene.render.resolution_y = 380
        H.set_params(**kw)
        H.build('h')
        path = os.path.join(out, 'v%d.png' % i)
        P.render_to(path)
        meta.append(dict(idx=i, name=v['name'], params=kw, file=os.path.basename(path)))
        print('SWEEP %d %s' % (i, v['name']))
    with open(os.path.join(out, 'variants.json'), 'w') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
