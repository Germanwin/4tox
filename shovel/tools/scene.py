"""Сцена сборки лопаты: своя сцена, свои материалы, чужие не трогаем.

Два режима, и разница принципиальная:

* **headless** (`blender -b --factory-startup -P ...`, как у топора и ратуши):
  чужих данных в файле нет, можно звать `thpipe.clear_scene()` и
  `read_factory_settings` — `fresh=True`.
* **живая сессия** (Blender уже запущен, к нему подключён MCP-сокет 9876):
  `read_factory_settings` снёс бы сцену пользователя, поэтому мы
  * берём (или заводим) ОТДЕЛЬНУЮ сцену `shovel` и делаем её активной в окне;
  * чистим только объекты с префиксом `shovel_` — то есть свои;
  * материалы палитры тоже с префиксом, чтобы не столкнуться с чужими именами;
  * осиротевшие дата-блоки убираем только те, у которых 0 пользователей И наше
    имя (чужой неиспользуемый меш с таким именем исключён).

Сцена пользователя при этом цела и остаётся в файле со своим именем.

ГРАБЛИ (уже наступили). Признак headless — **только `bpy.app.background`**.
Проверка `bpy.context.window is None` как признак «мы в фоне» — ловушка: в
контексте таймера аддона blender-mcp окно может оказаться недоступным, и тогда
код уходил в headless-ветку, звал `read_factory_settings` и **сносил открытый
файл пользователя** вместе со всеми его сценами. Поэтому теперь:
`fresh=True` срабатывает только при `bpy.app.background`, а в живой сессии без
окна сборка честно падает с ошибкой, а не «наводит порядок» в чужом файле.
"""
import bpy

import thpipe as P

SCENE_NAME = 'shovel'
PREFIX = 'shovel_'


def use_scene(name=SCENE_NAME, fresh=False):
    """Сделать активной сцену сборки.

    fresh=True (пустая сцена через read_factory_settings) допустим ТОЛЬКО в
    headless-процессе: в живом Blender это снесло бы файл пользователя.
    """
    if fresh and bpy.app.background:
        P.clear_scene()
        sc = bpy.context.scene
        sc.name = name
        return sc
    if not bpy.app.background and bpy.context.window is None:
        raise RuntimeError(
            'у Blender нет активного окна: сборку в живой сессии вести нельзя, '
            'а сбрасывать файл пользователя мы не будем. '
            'Переключитесь в окно Blender и повторите команду.')
    sc = bpy.data.scenes.get(name)
    if sc is None:
        sc = bpy.data.scenes.new(name)
    if bpy.context.window is not None:
        bpy.context.window.scene = sc
    return sc


def mark(cam=None, sun=None, world=None):
    """Переименовать камеру, солнце и мир в своё пространство имён."""
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
    """Снести осиротевшие дата-блоки с нашими именами (users == 0)."""
    for coll in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.worlds):
        for item in list(coll):
            if item.users == 0 and item.name.startswith(PREFIX):
                coll.remove(item)


def drop_materials(prefix=PREFIX):
    """Снести материалы палитры — перед пересборкой палитры из калибровки."""
    for mat in list(bpy.data.materials):
        if mat.name.startswith(prefix):
            bpy.data.materials.remove(mat)


def setup(scene=None, samples=64):
    """Камера, свет и настройки рендера пайплайна — на активной сцене."""
    cam, right, up, fwd = P.setup_camera()
    sun = P.setup_light()
    mark(cam, sun, bpy.context.scene.world)
    P.setup_render(samples=samples)
    return cam, sun


def viewport_camera(shading='MATERIAL'):
    """Показать в вьюпорте вид камеры — модель видно как будущий спрайт.

    Возвращает True, если вьюпорт найден (в `blender -b` его нет).
    """
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


def frame_view():
    """Показать в вьюпорте всю модель (Home) — когда камеру ставить не нужно."""
    win = getattr(bpy.context, 'window', None)
    if win is None:
        return False
    for area in win.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        region = next((r for r in area.regions if r.type == 'WINDOW'), None)
        if region is None:
            continue
        with bpy.context.temp_override(area=area, region=region):
            bpy.ops.view3d.view_all(center=False)
        area.tag_redraw()
        return True
    return False
