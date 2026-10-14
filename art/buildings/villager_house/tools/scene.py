"""scene.py — своя сцена дома: чужие объекты и сцены не трогаем.

Два режима, и разница принципиальная (грабли уже наступили в shovel):

* **headless** (`blender -b --factory-startup -P ...`): чужих данных в файле нет,
  можно звать `thpipe.clear_scene()` — `fresh=True`.
* **живая сессия** (Blender уже открыт заказчиком, к нему подключён MCP-сокет
  9876): `read_factory_settings` снёс бы открытый файл вместе со всеми его
  сценами. Поэтому берём (или заводим) ОТДЕЛЬНУЮ сцену `villager_house`,
  делаем её активной в окне и чистим ТОЛЬКО объекты со своим префиксом.

Признак headless — **только `bpy.app.background`**. Проверка
`bpy.context.window is None` как признак «мы в фоне» — ловушка: в контексте
таймера аддона blender-mcp окно может оказаться недоступным, и код уходил бы
в headless-ветку, снося файл пользователя.
"""
import bpy

import thpipe as P

SCENE_NAME = 'villager_house'
PREFIX = 'vh_'


def use_scene(name=SCENE_NAME, fresh=False):
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
    for coll in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights,
                 bpy.data.worlds):
        for item in list(coll):
            if item.users == 0 and item.name.startswith(PREFIX):
                coll.remove(item)


def drop_materials(prefix=PREFIX):
    for mat in list(bpy.data.materials):
        if mat.name.startswith(prefix):
            bpy.data.materials.remove(mat)


def setup(scene=None, samples=64):
    """Камера, свет и настройки рендера пайплайна — на активной сцене.

    ДИЗЕРИНГ ГАСИМ. У Blender по умолчанию `render.dither_intensity = 1.0`, и
    он добавляет к кадру шум ±1 LSB. Метрика детализации гейта квантует кадр
    по 10 самым частым цветам: когда 10 частых цветов — это один и тот же тон
    соломы с разбросом ±1, весь спрайт рассыпается на 900 «фасетов» по 6 px,
    и детализация падает с 40% до 20% (грабли: на поворотах 90/270 гейт падал
    в FAIL при визуально чистом кадре).
    """
    cam, right, up, fwd = P.setup_camera()
    sun = P.setup_light()
    mark(cam, sun, bpy.context.scene.world)
    P.setup_render(samples=samples)
    sc = scene or bpy.context.scene
    sc.render.dither_intensity = 0.0
    # ТРАССИРОВКУ ЛУЧЕЙ ГАСИМ, и это осознанно. Канон скилла требует ПЛОСКИХ
    # крупных фасетов («кадр не залит градиентом»), а экранный GI/AO EEVEE
    # размазывает цвет по большой плоскости: один и тот же фасет стены уезжает
    # на 2..3 тона от края к центру, и метрика детализации гейта рассыпается.
    # Замер на повороте 0 (один и тот же кадр, отличается только флаг):
    #     RT вкл:  крупных фасетов 6 (31% площади), мусорных 39%  -> FAIL
    #     RT выкл: крупных фасетов 9 (42% площади), мусорных 22%  -> PASS
    try:
        sc.eevee.use_raytracing = False
    except Exception:
        pass
    return cam, sun


def viewport_camera(shading='MATERIAL'):
    """Показать в вьюпорте вид камеры — модель видно глазами сразу."""
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


def viewport_view(name='LEFT'):
    """Поставить вьюпорт в ортогональный вид сбоку/спереди (осмотр формы)."""
    win = getattr(bpy.context, 'window', None)
    if win is None:
        return False
    for area in win.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        for space in area.spaces:
            if space.type != 'VIEW_3D':
                continue
            space.region_3d.view_perspective = 'ORTHO'
            space.region_3d.view_rotation = {
                'FRONT': (1.0, 0.0, 0.0, 0.0),
                'RIGHT': (0.7071068, 0.7071068, 0.0, 0.0),
                'TOP': (0.0, 0.0, 0.0, 1.0),
                'LEFT': (0.7071068, -0.7071068, 0.0, 0.0),
            }.get(name, (1.0, 0.0, 0.0, 0.0))
        area.tag_redraw()
        return True
    return False
