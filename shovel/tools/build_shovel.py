"""Рендер спрайтов лопаты: варианты x повороты -> renders/shovel_<вар>_<поворот>_raw.png

Headless (как топор и ратуша) — один запуск Blender на весь список кадров:

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/build_shovel.py -- --variants a,b,c --rotations 0,90,180,270 \
        --samples 64 --save-blend --export

Внутри УЖЕ ЗАПУЩЕННОГО Blender (через MCP-сокет 9876) гоняют
`tools/build_live.py`: он зовёт те же `render_frame()` / `export_model()`, но
работает в отдельной сцене `shovel` и не сносит сцену пользователя
(см. tools/scene.py).

Опции:
    --variants a,b,c        какие варианты штыка (a — железный, b — деревянный,
                            c — железный на длинной рукояти)
    --rotations 0,90,180,270
    --samples 64            сэмплов EEVEE
    --save-blend            сохранить сцену варианта (штык a -> shovel.blend)
    --export                выгрузить out/shovel_<вар>.obj/.mtl/.glb

Конвенции камеры и света — из townhall/tools/thpipe.py (азимут 45°, подъём
35.2644°, солнце (-0.36, 0.30, 0.88), плоские фасеты). Кадр плотный: 384 px на
юнит (4x от ppu атласа 96), чтобы спрайт годился и как иконка, и на предельном
зуме игры. Пост-обработка (контур, тень, обрезка, 1x/4x) — отдельно:
`python3 tools/compose_shovel.py`.
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
from mathutils import Matrix

import thpipe as P
import shovel as S
import scene as SC

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')

# Кадр лопаты: та же изометрия, но 384 px на юнит.
P.RES_X, P.RES_Y = 512, 640
P.ORTHO = P.RES_Y / 384.0            # 1.6667 -> ровно 384 px на юнит
PPU = 384.0

# Главный вариант — железный штык: его сцена идёт в shovel.blend.
MAIN = 'a'


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
    """Поворот модели вокруг Z прямо в данных меша (без bpy.ops)."""
    R = Matrix.Rotation(math.radians(deg), 4, 'Z')
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            o.data.transform(R)


def export_model(path_noext):
    """Выгрузить .obj (+.mtl) и .glb. В .obj — Z вверх, в .glb — Y вверх."""
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


def render_frame(variant, rot, samples, out_png, scene=None):
    """Один кадр: почистить свою мебель, собрать модель, повернуть, отрендерить.

    Сцена должна быть уже активной. Возвращает отчёт по кадру.
    """
    scene = scene or bpy.context.scene
    SC.clear_own(scene)
    SC.setup(samples=samples)
    objs = S.build(variant)
    if rot:
        rotate_meshes(rot)
    P.render_to(out_png)
    tris, verts = S.tris_verts(objs)
    census = S.tone_census(objs)
    return dict(tris=tris, verts=verts, objects=len(objs),
                size=round(S.size_units(variant), 3),
                tones={'%s' % k: [v[0], round(v[1], 5)] for k, v in census.items()})


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
              'lift': S.LIFT, 'frames': {}}

    for var in variants:
        for rot in rotations:
            SC.use_scene(fresh=True)
            name = 'shovel_%s_%d' % (var, rot)
            info = render_frame(var, rot, samples,
                                os.path.join(RENDERS, name + '_raw.png'))
            report['frames'][name] = dict(info, variant=var, rotation=rot)
            print('RENDERED %s  объектов=%d треугольников=%d вершин=%d (%.3f юнита)'
                  % (name, info['objects'], info['tris'], info['verts'], info['size']))
            if save_blend and rot == 0:
                blend = os.path.join(ROOT, 'shovel_%s.blend' % var)
                bpy.ops.wm.save_as_mainfile(filepath=blend)
                print('СЦЕНА СОХРАНЕНА %s' % blend)
                if var == MAIN:
                    main_blend = os.path.join(ROOT, 'shovel.blend')
                    bpy.ops.wm.save_as_mainfile(filepath=main_blend, copy=True)
                    print('СЦЕНА СОХРАНЕНА %s (главный вариант %s)' % (main_blend, MAIN))
            if do_export and rot == 0:
                export_model(os.path.join(OUT, 'shovel_%s' % var))

    with open(os.path.join(RENDERS, 'shovel_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('shovel_report.json записан')


if __name__ == '__main__':
    main()
