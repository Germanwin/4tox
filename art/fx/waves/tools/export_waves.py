"""Экспорт форм гребня волны в .glb — по одному файлу на форму.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/export_waves.py

Волны — эффект, а не постройка: у них нет ни пятна, ни поворотов модели.
В игре живут пять форм гребня (`wave_models.SHAPES`), каждая в двух поворотах
вала; поворот — это то, как вал лежит на воде, поэтому в .glb он не запекается
(выгружается поворот 0, поворот выбирает игра, `js/waves.js`).

Ориентация — как в сцене: волны, в отличие от хижины, никуда не разворачиваются,
и кадр атласа `wave_<форма>_0` соответствует .glb один в один.

В живой сессии (если понадобится) сборка идёт в своей сцене `waves_export`, и
`read_factory_settings` не зовётся — в пакетном режиме сцена сбрасывается, как
в `build_waves.py`.

Файлы: `out/wave_<форма>.glb`, начало координат — центр вала на уровне воды.
"""
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Корень 4tox — три уровня вверх от проекта (docs/STRUCTURE.md §6.1):
# waves → fx → art → 4tox. В `build_waves.py` здесь остался путь времён, когда
# townhall лежал в корне репозитория, и импорт thpipe оттуда больше не находится.
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, 'art', 'buildings', 'townhall', 'tools'))

import thpipe as P
import wave_models as W

SCENE = 'waves_export'
OUT = os.path.join(ROOT, 'out')


def live():
    """Признак живой сессии — только bpy.app.background (см. AGENTS.md)."""
    return not bpy.app.background


def my_scene():
    sc = bpy.data.scenes.get(SCENE)
    if sc is None:
        sc = bpy.data.scenes.new(SCENE)
    wm = getattr(bpy.context, 'window_manager', None)
    for w in (getattr(wm, 'windows', None) or []):
        w.scene = sc
    return sc


def clear_mine(sc):
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    for shape in range(len(W.SHAPES)):
        if live():
            sc = my_scene()
            clear_mine(sc)
            bpy.context.window.scene = sc
        else:
            P.clear_scene()
        W.reset_palette()
        W.build(shape, 0)
        meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

        for o in bpy.data.objects:          # выделение без bpy.ops: в таймере
            try:                            # аддона object.select_all молчит
                o.select_set(False)
            except Exception:
                pass
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]

        tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
        verts = sum(len(o.data.vertices) for o in meshes)
        path = os.path.join(OUT, 'wave_%d.glb' % shape)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                                  use_selection=True, use_active_scene=True,
                                  export_yup=True, export_apply=True,
                                  export_materials='EXPORT',
                                  export_cameras=False, export_lights=False)
        print('EXPORTED %-16s объектов=%2d трис=%4d верш=%4d'
              % (os.path.basename(path), len(meshes), tris, verts))
    print('готово: %s' % OUT)


if __name__ == '__main__':
    main()
