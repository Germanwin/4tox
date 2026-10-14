"""Рендер спрайтов прямоугольной хижины 3 x 2: варианты x повороты.

    blender -b --factory-startup -P tools/build_hut_rect.py -- [опции]

Опции:
    --variants a,b,c           какие варианты
    --rotations 0,90,180,270   какие повороты
    --samples 48               сэмплов EEVEE
    --save-blend               сохранить сцену (вариант a, поворот 0)

Пишет renders/hutrect_<вариант>_<поворот>_raw.png и hutrect_report.json.
Пост-обработка (тень, контур, обрезка) — python3 tools/compose_hut_rect.py
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
import hut_rect as HR

ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')


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


def rotate_meshes(deg):
    r = math.radians(deg)
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in objs:
        o.rotation_euler.z += r
    P.apply_transforms(objs)


def main():
    variants = str(opt('--variants', 'a,b,c')).split(',')
    rotations = [int(x) for x in str(opt('--rotations', '0,90,180,270')).split(',')]
    samples = int(opt('--samples', 48))
    save_blend = bool(opt('--save-blend', False))
    os.makedirs(RENDERS, exist_ok=True)

    report = {'ortho': P.ORTHO, 'res': [P.RES_X, P.RES_Y], 'ppu': P.PPU,
              'el_deg': math.degrees(P.EL), 'az_deg': math.degrees(P.AZ),
              'footprint': [3, 2], 'frames': {}}

    for v in variants:
        for rot in rotations:
            P.clear_scene()
            HR.reset_palette()
            P.setup_camera()
            P.setup_light()
            P.setup_render(samples=samples)
            HR.build(v)
            if rot:
                rotate_meshes(rot)
            name = 'hutrect_%s_%d' % (v, rot)
            P.render_to(os.path.join(RENDERS, name + '_raw.png'))
            tris, verts = P.stats()
            report['frames'][name] = dict(variant=v, rotation=rot, tris=tris,
                                          verts=verts)
            print('RENDERED %-18s tris=%4d verts=%4d' % (name, tris, verts))
            if save_blend and v == 'a' and rot == 0:
                bpy.ops.wm.save_as_mainfile(
                    filepath=os.path.join(ROOT, 'hut_rect.blend'))

    with open(os.path.join(RENDERS, 'hutrect_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('hutrect_report.json записан')


if __name__ == '__main__':
    main()
