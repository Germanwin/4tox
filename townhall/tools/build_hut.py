"""Рендер спрайтов хижины: N поворотов -> renders/hut_<поворот>_raw.png

    blender -b --factory-startup -P tools/build_hut.py -- [опции]

Опции:
    --rotations 0,90,180,270   какие повороты
    --samples 48               сэмплов EEVEE
    --save-blend               сохранить сцену поворота 0 в townhall/hut.blend

Пост-обработка (тень, контур, обрезка) — отдельно: python3 tools/compose_hut.py
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
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            o.rotation_euler.z += r
    P.apply_transforms([o for o in bpy.context.scene.objects if o.type == 'MESH'])


def main():
    rotations = [int(x) for x in str(opt('--rotations', '0,90,180,270')).split(',')]
    samples = int(opt('--samples', 48))
    save_blend = bool(opt('--save-blend', False))
    os.makedirs(RENDERS, exist_ok=True)

    report = {'ortho': P.ORTHO, 'res': [P.RES_X, P.RES_Y], 'ppu': P.PPU,
              'el_deg': math.degrees(P.EL), 'az_deg': math.degrees(P.AZ),
              'sun': list(P.SUN_DIR), 'sun_energy': P.SUN_ENERGY, 'frames': {}}

    for rot in rotations:
        P.clear_scene()
        H.reset_palette()
        P.setup_camera()
        P.setup_light()
        P.setup_render(samples=samples)
        objs = H.build('h')
        if rot:
            rotate_meshes(rot)
        name = 'hut_%d' % rot
        P.render_to(os.path.join(RENDERS, name + '_raw.png'))
        tris, verts = P.stats()
        report['frames'][name] = dict(tris=tris, verts=verts, objects=len(objs))
        print('RENDERED %s  объектов=%d треугольников=%d вершин=%d' % (
            name, len(objs), tris, verts))
        if save_blend and rot == 0:
            blend = os.path.join(ROOT, 'hut.blend')
            bpy.ops.wm.save_as_mainfile(filepath=blend)
            print('СЦЕНА СОХРАНЕНА %s' % blend)

    with open(os.path.join(RENDERS, 'hut_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('hut_report.json записан')


if __name__ == '__main__':
    main()
