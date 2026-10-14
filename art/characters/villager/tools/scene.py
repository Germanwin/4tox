"""scene.py — своя сцена жительницы: чужие объекты и сцены не трогаем.

Признак headless — **только `bpy.app.background`**. Проверка
`bpy.context.window is None` как признак «мы в фоне» — ловушка: в контексте
таймера аддона blender-mcp окно может оказаться недоступным, и код ушёл бы в
headless-ветку, снёс бы файл заказчика вместе со всеми его сценами
(4tox-lowpoly-3d/references/blender-mcp.md).

КАМЕРА — КАНОН ИГРЫ, А НЕ thpipe. Игра считает ближе к камере того, у кого
больше `x + y` (js/render.js, mapgen2/README), значит камера стоит в квадранте
(+X, +Y, +Z) и модель, смотрящая в +X, видна спереди-слева. В общем пайплайне
проекта (townhall/tools/thpipe.py::setup_camera) камера стоит в (−X, +Y, +Z) —
на 90° мимо; поэтому камера собирается здесь сама, а из thpipe берётся только
свет (он один на всю игру и от камеры не зависит).
"""
import math

import bpy
from mathutils import Matrix, Vector

import thpipe as P
import palette as PAL

SCENE_NAME = 'villager'
PREFIX = 'vg_'

AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
RES_X, RES_Y = 144, 192


def use_scene(name=SCENE_NAME, fresh=False):
    if fresh and bpy.app.background:
        P.clear_scene()
        sc = bpy.context.scene
        sc.name = name
        return sc
    if not bpy.app.background and bpy.context.window is None:
        raise RuntimeError(
            'у Blender нет активного окна: сборку в живой сессии вести нельзя, '
            'а сбрасывать файл пользователя мы не будем.')
    sc = bpy.data.scenes.get(name)
    if sc is None:
        sc = bpy.data.scenes.new(name)
    if bpy.context.window is not None:
        bpy.context.window.scene = sc
    return sc


def mark(cam=None, sun=None, world=None):
    if cam:
        cam.name = PREFIX + 'cam'
        cam.data.name = PREFIX + 'cam'
    if sun:
        sun.name = PREFIX + 'sun'
        sun.data.name = PREFIX + 'sun'
    if world:
        world.name = PREFIX + 'world'


def clear_own(scene=None):
    """Убрать из сцены ТОЛЬКО свои объекты (по префиксу имён)."""
    scene = scene or bpy.context.scene
    for ob in list(scene.objects):
        if ob.name.startswith(PREFIX):
            bpy.data.objects.remove(ob, do_unlink=True)
    purge_orphans()


def purge_orphans():
    for coll in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights,
                 bpy.data.worlds):
        for item in list(coll):
            if item.users == 0 and item.name.startswith(PREFIX):
                coll.remove(item)


def drop_materials(prefix=PREFIX):
    for mat in list(bpy.data.materials):
        if mat.name.startswith(prefix):
            bpy.data.materials.remove(mat)


def setup_camera(target=(0.0, 0.0, 0.0), ppu=96.0, res=(RES_X, RES_Y), ortho=None):
    """Ортокамера канона: смотрим из (+X, +Y, +Z) в точку `target`.

    Локальные оси камеры: +X = экранное «вправо» (cos az, −sin az, 0),
    +Y = экранное «вверх» (−sin el·cos az, −sin el·sin az, cos el),
    +Z = назад, к глазу (cos el·cos az, cos el·sin az, sin el).
    """
    s, c = math.sin(AZ), math.cos(AZ)
    se, ce = math.sin(EL), math.cos(EL)
    right = Vector((c, -s, 0.0))
    up = Vector((-se * c, -se * s, ce))
    eye = Vector((ce * c, ce * s, se))
    R = Matrix(((right.x, up.x, eye.x),
                (right.y, up.y, eye.y),
                (right.z, up.z, eye.z)))
    tgt = Vector(target)
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ortho if ortho else (res[1] / float(ppu))
    cam = bpy.data.objects.new('Cam', cam_data)
    bpy.context.collection.objects.link(cam)
    cam.matrix_world = Matrix.Translation(tgt + eye * 40.0) @ R.to_4x4()
    bpy.context.scene.camera = cam
    return cam


def setup(target=(0.0, 0.0, 0.42), ppu=96.0, res=(RES_X, RES_Y), samples=32):
    """Камера, свет и настройки рендера. Возвращает (cam, sun).

    Дизеринг гасим (иначе ±1 LSB шума рассыпает фасеты в метрике детализации),
    трассировку лучей гасим (она размазывает тон по большой плоскости).
    Обоснование обоих — villager_house/tools/scene.py, те же грабли.
    """
    cam = setup_camera(target=target, ppu=ppu, res=res)
    from mathutils import Vector as _V
    P.SUN_DIR = _V(PAL.SUN_DIR).normalized()  # см. palette.SUN_DIR: зеркало по X
    sun = P.setup_light()
    sc = bpy.context.scene
    mark(cam, sun, sc.world)
    P.setup_render(samples=samples)
    P.RES_X, P.RES_Y = res
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.dither_intensity = 0.0
    try:
        sc.eevee.use_raytracing = False
    except Exception:
        pass
    return cam, sun


def viewport_camera(shading='MATERIAL'):
    win = getattr(bpy.context, 'window', None)
    if win is None:
        return False
    found = False
    for area in win.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        for space in area.spaces:
            if space.type != 'VIEW_3D':
                continue
            space.region_3d.view_perspective = 'CAMERA'
            space.shading.type = shading
            found = True
        area.tag_redraw()
    return found
