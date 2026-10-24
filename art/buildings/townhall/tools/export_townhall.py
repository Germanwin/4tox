"""Экспорт вариантов ратуши в .glb — в УЖЕ ЗАПУЩЕННОМ Blender.

    $PY tools/blmcp.py run tools/export_townhall.py

Пакетно, когда живой сессии нет физически (выгрузка уже замороженной геометрии):

    blender -b --factory-startup -P tools/export_townhall.py

Зачем отдельный вход. `build_live.py` рисует кадры и GLB не выгружает вовсе, а
`build_townhall.py` зовёт `read_factory_settings` — в живой сессии это сносит
файл заказчика вместе с его сценами. Здесь только геометрия и выгрузка:

  * файл не сбрасывается и не сохраняется;
  * в живой сессии сборка идёт в СВОЕЙ сцене (`th_export`), и чистятся только
    её объекты; активная сцена ставится ПЕРЕД сборкой — иначе объекты уедут в
    чужую сцену (грабля из скилла `4tox-building-forge`);
  * камера и свет не создаются: для выгрузки мешей они не нужны, а мусорить в
    чужой сцене незачем.

Ориентация — та же, что у `hutrect_*.glb`: **дверь смотрит в glTF +Z**. В сцене
дверь стоит в +Y Blender (`townhall.py::build_door(side=1)`), а конвертация
glTF берёт −Y Blender за +Z, поэтому перед выгрузкой геометрия поворачивается
на 180° вокруг Z — ровно как в `export_hut_rect.py`. Куда смотрит дверь,
скрипт проверяет по самому мешу, а не по вере: если дверь не нашлась, он
скажет об этом вслух.

Файлы: `out/townhall_<вариант>.glb`, начало координат — центр пятна 4 x 3,
z = 0 — земля. Стенд моделей (`art/tools/model-stand`) читает их как есть и
разворачивает обратно, чтобы «4 поворота» совпадали с кадрами атласа.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import thpipe as P
import townhall as T

SCENE = 'th_export'
OUT = os.path.join(ROOT, 'out')
VARIANTS = ('a', 'b', 'c')
DOOR_HINTS = ('door', 'двер')


def live():
    """Признак живой сессии — только bpy.app.background (см. AGENTS.md)."""
    return not bpy.app.background


def my_scene():
    """Своя сцена: создать или взять прежнюю. Чужие сцены не трогаем."""
    sc = bpy.data.scenes.get(SCENE)
    if sc is None:
        sc = bpy.data.scenes.new(SCENE)
    wm = getattr(bpy.context, 'window_manager', None)
    for w in (getattr(wm, 'windows', None) or []):
        w.scene = sc
    return sc


def clear_mine(sc):
    """Убрать объекты только из своей сцены."""
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def door_side(meshes):
    """В какую сторону смотрит дверь: +1 — в +Y, −1 — в −Y, 0 — не нашлась."""
    for o in meshes:
        if not any(h in o.name.lower() for h in DOOR_HINTS):
            continue
        ys = [v.co.y for v in o.data.vertices]
        if ys:
            return 1 if sum(ys) / len(ys) > 0 else -1
    return 0


def export_variant(v, meshes, out):
    """Повернуть так, чтобы дверь смотрела в glTF +Z, и выгрузить .glb."""
    side = door_side(meshes)
    if side > 0:                       # дверь в +Y Blender -> развернуть в −Y
        yaw = math.pi
    elif side < 0:
        yaw = 0.0
    else:
        yaw = 0.0
        print('  ВНИМАНИЕ: дверь не нашлась среди %d мешей — ориентация как в сцене'
              % len(meshes))
    if yaw:
        # Поворот прямо в данных меша, без bpy.ops: в таймере аддона
        # `object.select_all` молча не срабатывает, и `transform_apply` может
        # задеть чужие выделенные объекты (грабля из villager_house/README).
        R = Matrix.Rotation(yaw, 4, 'Z')
        for o in meshes:
            o.data.transform(R)
            o.data.update()

    for o in bpy.data.objects:         # выделение без bpy.ops: в таймере аддона
        try:                           # object.select_all молча не срабатывает
            o.select_set(False)
        except Exception:
            pass
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    verts = sum(len(o.data.vertices) for o in meshes)
    path = os.path.join(out, 'townhall_%s.glb' % v)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                              use_selection=True, use_active_scene=True,
                              export_yup=True, export_apply=True,
                              export_materials='EXPORT',
                              export_cameras=False, export_lights=False)
    print('EXPORTED %-24s door=%+d yaw=%3.0f°  объектов=%2d трис=%4d верш=%4d'
          % (os.path.basename(path), side, math.degrees(yaw),
             len(meshes), tris, verts))


def main():
    os.makedirs(OUT, exist_ok=True)
    for v in VARIANTS:
        if live():
            sc = my_scene()
            clear_mine(sc)
            bpy.context.window.scene = sc
            T.reset_palette()
            T.build(v)
            meshes = [o for o in sc.objects if o.type == 'MESH']
        else:
            P.clear_scene()
            T.reset_palette()
            T.build(v)
            meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        export_variant(v, meshes, OUT)
    print('готово: %s' % OUT)


if __name__ == '__main__':
    main()
