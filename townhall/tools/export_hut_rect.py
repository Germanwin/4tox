"""Экспорт трёх вариантов прямоугольной хижины в .glb (для движка/просмотра).

    blender -b --factory-startup -P tools/export_hut_rect.py -- [--out out]

Каждый вариант — отдельный файл hutrect_<вариант>.glb, начало координат в
центре пятна 3 x 2, z = 0 — земля. Дверь смотрит в -Y Blender, то есть
после конвертации glTF (y-up) — в +Z, как принято в glTF.
"""
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
    out = opt('--out', os.path.join(ROOT, 'out'))
    os.makedirs(out, exist_ok=True)
    for v in ('a', 'b', 'c'):
        P.clear_scene()
        HR.reset_palette()
        P.setup_camera()
        P.setup_light()
        HR.build(v)
        objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        for o in objs:                     # дверь в -Y -> в glTF это +Z
            o.rotation_euler.z += math.pi
        P.apply_transforms(objs)
        for o in bpy.context.scene.objects:      # убрать камеру и солнце
            if o.type != 'MESH':
                bpy.data.objects.remove(o, do_unlink=True)
        tris, verts = P.stats()
        path = os.path.join(out, 'hutrect_%s.glb' % v)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                                  use_selection=False, export_apply=True,
                                  export_yup=True, export_materials='EXPORT',
                                  export_cameras=False, export_lights=False)
        print('EXPORTED %-22s tris=%4d verts=%4d' % (os.path.basename(path), tris, verts))


if __name__ == '__main__':
    main()
