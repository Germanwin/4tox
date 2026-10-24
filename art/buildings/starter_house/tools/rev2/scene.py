"""scene.py — своя сцена стартового дома: чужие объекты и сцены не трогаем.

Два режима, и разница принципиальная:

* **headless** (`blender -b --factory-startup -P ...`): чужих данных в файле
  нет, можно чистить всё (`fresh=True`).
* **живая сессия** (Blender открыт заказчиком, к нему подключён MCP-сокет
  9876): `read_factory_settings` снёс бы открытый файл вместе со всеми его
  сценами.  Поэтому берём (или заводим) ОТДЕЛЬНУЮ сцену `starter_house`,
  делаем её активной в окне и чистим ТОЛЬКО объекты со своим префиксом.

Признак headless — **только `bpy.app.background`**.  Проверка
`bpy.context.window is None` как признак «мы в фоне» — ловушка: в контексте
таймера аддона blender-mcp окно может оказаться недоступным, и код ушёл бы
в headless-ветку, снося файл заказчика.

Сцена (камера, солнце, небо, рендер) — ТА ЖЕ, что у ратуши и дома жителя:
`thpipe.py` лежит в проекте ратуши, кадры обязаны сходиться попиксельно.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if os.path.join(os.path.dirname(ROOT), 'townhall', 'tools') not in sys.path:
    sys.path.append(os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy                                                       # noqa: E402

import thpipe as P                                               # noqa: E402

SCENE_NAME = 'starter_house'
PREFIX = 'sh_'


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


def setup(samples=64, res=(512, 640)):
    """Канонная сцена: камера ратуши, солнце ратуши, рендер ратуши.

    АКТИВНАЯ СЦЕНА ставится ПЕРЕД КАЖДОЙ настройкой: `thpipe.setup_camera`
    и `setup_light` кладут объекты в `bpy.context.scene`, а в живом Blender это
    ЧУЖАЯ сцена, если её не переключить (грабли: сборка ушла в свою сцену, а
    камера создалась в сцене заказчика, и рендер падал «Cannot render, no
    camera»).
    """
    global _SCENE
    sc = use_scene()

    def _own(name):
        return bpy.data.objects.get(PREFIX + name) is not None

    if not _own('cam'):
        bpy.context.window.scene = sc
        cam, right, up, fwd = P.setup_camera()
        mark(cam=cam)
        sc.camera = cam
    if not _own('sun'):
        bpy.context.window.scene = sc
        sun = P.setup_light()
        mark(sun=sun, world=sc.world)
    P.RES_X, P.RES_Y = res
    P.setup_render(samples=samples)

    # ДИЗЕРИНГ ГАСИМ.  Blender по умолчанию `render.dither_intensity = 1.0` и
    # добавляет к кадру шум ±1 LSB: один и тот же тон соломы расползается на
    # десяток почти одинаковых цветов, метрика детализации гейта рассыпает
    # спрайт на «мусорные» фасеты по 6 px и падает в FAIL при чистом кадре.
    sc.render.dither_intensity = 0.0

    # ТРАССИРОВКУ ЛУЧЕЙ ГАСИМ — тоже осознанно.  Канон требует ПЛОСКИХ крупных
    # фасетов, а экранный GI/AO EEVEE размазывает цвет по большой плоскости:
    # один и тот же фасет стены уезжает на 2..3 тона от края к центру, и
    # детализация падает (замер на доме жителя: 31% -> 42% крупных фасетов).
    try:
        sc.eevee.use_raytracing = False
    except Exception:                                            # noqa: BLE001
        pass
    return sc


def viewport_camera():
    """Перевести вьюпорт в вид камеры — модель видно заказчику сразу."""
    try:
        win = bpy.context.window
        if win is None:
            return 'нет окна'
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                for space in area.spaces:
                    if space.type == 'VIEW_3D':
                        space.region_3d.view_perspective = 'CAMERA'
                        region = next((r for r in area.regions
                                       if r.type == 'WINDOW'), None)
                        if region is not None:
                            with bpy.context.temp_override(area=area,
                                                           region=region):
                                bpy.ops.view3d.view_center_camera()
                        return 'вьюпорт в виде камеры'
    except Exception as e:                                        # noqa: BLE001
        return 'вьюпорт не переключился: %s' % e
    return 'окна 3D нет'
