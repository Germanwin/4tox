"""closeup_live.py — крупные планы модели ВНУТРИ живого Blender (проверка стыков).

    $PY tools/blmcp.py run tools/closeup_live.py

Камера `vh_cam` на время съёмки уводится в точку крупного плана и возвращается
на место: сцена заказчика не меняется, а в renders/ ложатся кадры, по которым
видно, что раскосы, рамы окон и кровля сходятся.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy                                                      # noqa: E402
import scene as SC                                              # noqa: E402

RENDERS = os.path.join(ROOT, 'renders')

# (имя, точка взгляда, цель, фокус) — близкие ракурсы «как смотрел заказчик»
SHOTS = [
    ('cu_window', (0.80, 1.62, 0.86), (0.78, 0.84, 0.72), 50.0),
    ('cu_brace', (1.18, 1.38, 1.30), (1.30, 0.85, 1.14), 50.0),
    ('cu_gable', (-5.10, 0.34, 2.10), (-1.36, 0.00, 1.42), 50.0),
    ('cu_door', (0.06, 1.62, 1.00), (0.0, 0.84, 0.62), 50.0),
    ('cu_eave', (0.86, 1.42, 1.46), (0.58, 0.90, 1.26), 50.0),
]


def look_at(cam, eye, target):
    import mathutils
    e = mathutils.Vector(eye)
    d = mathutils.Vector(target) - e
    rot = d.to_track_quat('-Z', 'Y').to_euler()
    cam.location = e
    cam.rotation_euler = rot


def main():
    sc = bpy.context.scene
    cam = bpy.data.objects.get('vh_cam')
    if cam is None:
        raise SystemExit('в сцене нет vh_cam — сначала сборка (build_live.py)')
    keep = (tuple(cam.location), tuple(cam.rotation_euler), cam.data.lens,
            sc.camera, sc.render.resolution_x, sc.render.resolution_y,
            sc.render.filepath, cam.data.type, cam.data.ortho_scale)
    # камера пайплайна ОРТОГРАФИЧЕСКАЯ (кадр спрайта) — для крупного плана
    # нужна перспектива, иначе масштаб кадра не зависит от расстояния
    cam.data.type = 'PERSP'
    sc.camera = cam
    old_focus = cam.data.dof.focus_distance if cam.data.dof else None
    sc.render.resolution_x, sc.render.resolution_y = 720, 720
    sc.render.image_settings.file_format = 'PNG'
    for name, eye, target, lens in SHOTS:
        cam.data.lens = lens
        look_at(cam, eye, target)
        try:
            cam.data.dof.use_dof = False
        except Exception:
            pass
        sc.render.filepath = os.path.join(RENDERS, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('CU %s -> %s' % (name, sc.render.filepath))
    cam.location, cam.rotation_euler = keep[0], keep[1]
    cam.data.type = keep[7]
    cam.data.ortho_scale = keep[8]
    cam.data.lens = keep[2]
    sc.camera = keep[3]
    sc.render.resolution_x, sc.render.resolution_y = keep[4], keep[5]
    sc.render.filepath = keep[6]
    if old_focus is not None:
        cam.data.dof.focus_distance = old_focus
    print('камера возвращена: %s, линза %.0f' % (keep[3].name if keep[3] else '—',
                                                keep[2]))


if __name__ == '__main__':
    main()
