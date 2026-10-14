"""Сборка ратуши в УЖЕ ЗАПУЩЕННОМ Blender: 3 варианта x 4 поворота -> renders/*_raw.png

    PY=/Users/hermmoment/.dsh/profiles/desktop/node_modules/dsh-blender/.venv/bin/python
    $PY shovel/tools/blmcp.py run townhall/tools/build_live.py

Зачем отдельный вход, если есть `build_townhall.py`: тот пакетный, он зовёт
`bpy.ops.wm.read_factory_settings` — в живой сессии это сносит файл заказчика
вместе с его сценами. Здесь то же самое, но по правилам живой сессии:

  * файл не сбрасывается и не сохраняется;
  * сборка идёт в СВОЕЙ сцене (`th_live`), чистятся только свои объекты;
  * активная сцена ставится ПЕРЕД настройкой камеры, света и рендера — иначе
    они уедут в чужую сцену (грабля из скилла 4tox-building-forge);
  * геометрия та же (`townhall.py`), поэтому кадры совпадают с пакетными.

Кадры видно во вьюпорте заказчика по мере сборки; спрайты (тень, контур,
обрезка) делаются после — `tools/compose.py`.
"""
import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import thpipe as P
import townhall as T

SCENE = 'th_live'
RENDERS = os.path.join(ROOT, 'renders')
VARIANTS = ('a', 'b', 'c')
ROTATIONS = (0, 90, 180, 270)
SAMPLES = 48


def my_scene():
    """Своя сцена: создать или взять прежнюю. Чужие сцены не трогаем."""
    sc = bpy.data.scenes.get(SCENE)
    if sc is None:
        sc = bpy.data.scenes.new(SCENE)
    # Окна живут в window_manager, а не в bpy.data (в 5.x bpy.data.windows нет).
    wm = getattr(bpy.context, 'window_manager', None)
    for w in (getattr(wm, 'windows', None) or []):
        w.scene = sc
    return sc


def clear_mine(sc):
    """Убрать объекты только из своей сцены."""
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def main():
    sc = my_scene()
    os.makedirs(RENDERS, exist_ok=True)
    report = {'ortho': P.ORTHO, 'res': [P.RES_X, P.RES_Y], 'ppu': P.PPU,
              'el_deg': math.degrees(P.EL), 'az_deg': math.degrees(P.AZ),
              'sun': list(P.SUN_DIR), 'sun_energy': P.SUN_ENERGY, 'frames': {}}

    for v in VARIANTS:
        for rot in ROTATIONS:
            clear_mine(sc)
            T.reset_palette()
            bpy.context.window.scene = sc
            P.setup_camera()
            P.setup_light()
            P.setup_render(samples=SAMPLES)
            objs = T.build(v)
            if rot:
                r = math.radians(rot)
                for o in sc.objects:
                    if o.type == 'MESH':
                        o.rotation_euler.z += r
                P.apply_transforms([o for o in sc.objects if o.type == 'MESH'])
            name = 'th_%s_%d' % (v, rot)
            P.render_to(os.path.join(RENDERS, name + '_raw.png'))
            tris, verts = P.stats()
            report['frames'][name] = dict(tris=tris, verts=verts, objects=len(objs))
            print('RENDERED %s  объектов=%d треугольников=%d' % (name, len(objs), tris))

    with open(os.path.join(RENDERS, 'render_report.json'), 'w') as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    print('готово: 12 кадров в renders/, отчёт render_report.json')


if __name__ == '__main__':
    main()
