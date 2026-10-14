"""Рендер спрайтов топора: варианты x повороты -> renders/axe_<вар>_<поворот>_raw.png

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/build_axe.py -- [опции]

Опции:
    --variants a,b,c        какие варианты головы (a — железный, b — каменный,
                            c — железный на длинной рукояти)
    --rotations 0,90,180,270
    --samples 64            сэмплов EEVEE
    --save-blend            сохранить сцену варианта a (поворот 0) в axe.blend
    --export                выгрузить out/axe_<вар>.obj/.mtl/.glb

Конвенции камеры и света — из townhall/tools/thpipe.py (азимут 45°, подъём
35.2644°, солнце (-0.36, 0.30, 0.88), плоские фасеты). Меняется только кадр:
топор мелкий, поэтому кадр плотный — 384 px на юнит (4x от ppu атласа 96),
чтобы спрайт был годен и как иконка, и на предельном зуме игры.

Пост-обработка (контур, тень, обрезка, 1x/4x) — отдельно: python3 tools/compose_axe.py
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy
import thpipe as P
import axe as A

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

# Кадр топора: та же изометрия, но 384 px на юнит.
P.RES_X, P.RES_Y = 512, 640
P.ORTHO = P.RES_Y / 384.0            # 1.6667 -> ровно 384 px на юнит
PPU = 384.0

# Главный вариант: каменный топор с обвязкой — его сцена идёт в axe.blend.
MAIN = 'b'


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


def export_model(path_noext):
    """Выгрузить .obj (+.mtl) и .glb. Оси — Y вверх, как принято в движках."""
    os.makedirs(os.path.dirname(path_noext), exist_ok=True)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    obj = path_noext + '.obj'
    bpy.ops.wm.obj_export(filepath=obj, export_selected_objects=True,
                          export_materials=True, export_uv=False,
                          export_normals=True, export_triangulated_mesh=False,
                          forward_axis='Y', up_axis='Z', apply_modifiers=True)
    print('EXPORTED %s' % obj)

    glb = path_noext + '.glb'
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB',
                              use_selection=True, export_yup=True,
                              export_apply=True, export_materials='EXPORT')
    print('EXPORTED %s' % glb)


def main():
    variants = str(opt('--variants', 'a,b,c')).split(',')
    rotations = [int(x) for x in str(opt('--rotations', '0,90,180,270')).split(',')]
    samples = int(opt('--samples', 64))
    save_blend = bool(opt('--save-blend', False))
    do_export = bool(opt('--export', False))
    os.makedirs(RENDERS, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    report = {'ortho': P.ORTHO, 'res': [P.RES_X, P.RES_Y], 'ppu': PPU,
              'el_deg': math.degrees(P.EL), 'az_deg': math.degrees(P.AZ),
              'sun': list(P.SUN_DIR), 'sun_energy': P.SUN_ENERGY,
              'lift': A.LIFT, 'frames': {}}

    for var in variants:
        for rot in rotations:
            P.clear_scene()
            A.reset_palette()
            P.setup_camera()
            P.setup_light()
            P.setup_render(samples=samples)
            objs = A.build(var)
            if rot:
                rotate_meshes(rot)
            name = 'axe_%s_%d' % (var, rot)
            P.render_to(os.path.join(RENDERS, name + '_raw.png'))
            tris, verts = A.tris_verts(objs)
            report['frames'][name] = dict(tris=tris, verts=verts,
                                          objects=len(objs), variant=var, rotation=rot)
            print('RENDERED %s  объектов=%d треугольников=%d вершин=%d' % (
                name, len(objs), tris, verts))
            if save_blend and rot == 0:
                blend = os.path.join(ROOT, 'axe_%s.blend' % var)
                bpy.ops.wm.save_as_mainfile(filepath=blend)
                print('СЦЕНА СОХРАНЕНА %s' % blend)
                if var == MAIN:
                    main = os.path.join(ROOT, 'axe.blend')
                    bpy.ops.wm.save_as_mainfile(filepath=main, copy=True)
                    print('СЦЕНА СОХРАНЕНА %s (главный вариант %s)' % (main, MAIN))
            if do_export and rot == 0:
                export_model(os.path.join(OUT, 'axe_%s' % var))

    with open(os.path.join(RENDERS, 'axe_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('axe_report.json записан')


if __name__ == '__main__':
    main()
