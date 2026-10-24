# -*- coding: utf-8 -*-
"""Сцена Blender для плитки низкой травы.

Собирает только СВОЮ сцену с префиксом `pg_`: чистый factory-startup,
никаких чужих файлов. Геометрия приходит из `grass_tile.py` (чистый Python),
здесь — материалы, свет, камера и девять периодических копий плитки.

Запуск (headless, когда живой сессии нет):
    blender -b --factory-startup -P tools/build_tile.py

В живом Blender тот же сценарий запускается через MCP — форма от этого не
меняется: она лежит в grass_tile.py, а не в этом файле.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

# --- своя геометрия -------------------------------------------------------
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
TOOLS = os.path.join(ROOT, 'art', 'textures', 'plot_grass', 'tools')
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

import grass_tile  # noqa: E402

PREFIX = 'pg_'
FLAT = os.environ.get('PG_FLAT') == '1'


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgba(rgb):
    return (srgb_to_linear(rgb[0]), srgb_to_linear(rgb[1]), srgb_to_linear(rgb[2]), 1.0)


# --- чистая сцена ---------------------------------------------------------

def clear_scene():
    """Сносим только своё: файл открыт factory-startup, но правило то же."""
    for obj in list(bpy.data.objects):
        if obj.name.startswith(PREFIX):
            bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name.startswith(PREFIX):
            bpy.data.collections.remove(coll)
    for mat in list(bpy.data.materials):
        if mat.name.startswith(PREFIX):
            bpy.data.materials.remove(mat)
    # factory-startup: куб, камера и свет по умолчанию — тоже своё место,
    # но имена у них чужие. Удаляем всё, кроме нашей сцены: это одноразовый
    # старт, а не файл заказчика.
    if not bpy.app.background:
        raise RuntimeError('build_tile.py — только для отдельной сцены, не для живого файла')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


# --- материалы ------------------------------------------------------------

def make_material(name, rgb):
    mat = bpy.data.materials.new(PREFIX + name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (240, 0)
    if FLAT:
        # Плоский рендер: эмиссия без света и теней. Цвет листа — ровно тот,
        # что в палитре, поэтому плитка читается как рисованная поверхность,
        # а не как заросли с чёрными щелями.
        em = nt.nodes.new('ShaderNodeEmission')
        em.location = (0, 0)
        em.inputs['Color'].default_value = rgba(rgb)
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    else:
        # Чисто диффузный материал: у спрайтов игры roughness 1, specular 0.
        diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
        diff.location = (0, 0)
        diff.inputs['Color'].default_value = rgba(rgb)
        nt.links.new(diff.outputs['BSDF'], out.inputs['Surface'])
    return mat


# --- геометрия ------------------------------------------------------------

def make_mesh(data):
    me = bpy.data.meshes.new(PREFIX + 'turf')
    me.from_pydata(data['verts'], [], data['faces'])
    me.validate(verbose=False)
    me.update()
    for p in me.polygons:
        p.use_smooth = False
    # материалы в фиксированном порядке
    mats = []
    for name in data['mat_order']:
        mats.append(make_material(name, data['materials'][name]))
        me.materials.append(mats[-1])
    index = {name: i for i, name in enumerate(data['mat_order'])}
    for p, name in zip(me.polygons, data['face_mats']):
        p.material_index = index.get(name, 0)
    return me


def make_ground(tile):
    """Подложка: ровная тёмная земля, на которой лежит дерн."""
    me = bpy.data.meshes.new(PREFIX + 'ground')
    s = tile * 2.0
    verts = [(-s, -s, -0.002), (s, -s, -0.002), (s, s, -0.002), (-s, s, -0.002)]
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    me.update()
    obj = bpy.data.objects.new(PREFIX + 'ground', me)
    bpy.context.scene.collection.objects.link(obj)
    mat = make_material('ground_plane', grass_tile.MATERIALS['ground'])
    me.materials.append(mat)
    return obj


def make_camera(tile):
    cam_data = bpy.data.cameras.new(PREFIX + 'cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = tile
    cam = bpy.data.objects.new(PREFIX + 'cam', cam_data)
    cam.location = (tile * 0.5, tile * 0.5, 6.0)
    cam.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def make_sun(tile):
    light = bpy.data.lights.new(PREFIX + 'sun', 'SUN')
    # Канон игры: солнце смотрит из (-0.36, 0.30, 0.88). Свет летит в
    # противоположную сторону, поэтому -Z светильника смотрит (0.36,-0.30,-0.88):
    # тени падают вправо-вниз, как у спрайтов карты.
    vec = Vector((0.36, -0.30, -0.88)).normalized()
    light.energy = 0.0 if FLAT else 3.8
    light.angle = math.radians(10.0)
    obj = bpy.data.objects.new(PREFIX + 'sun', light)
    obj.rotation_euler = vec.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(obj)
    return obj


def setup_world():
    scene = bpy.context.scene
    world = bpy.data.worlds.get(PREFIX + 'world')
    if world is None:
        world = bpy.data.worlds.new(PREFIX + 'world')
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get('Background')
    if bg is None:
        bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Color'].default_value = (0.50, 0.58, 0.48, 1.0)
    bg.inputs['Strength'].default_value = 0.0 if FLAT else 0.95
    scene.world = world


def setup_render(tile):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48 if FLAT else 96
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.015
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 1
    scene.cycles.transmission_bounces = 0
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    # Стандартный view transform: нам нужен предсказуемый sRGB, а не кино.
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.fps = 24
    scene.render.filepath = os.path.join(ROOT, 'art', 'textures', 'plot_grass',
                                         'renders', 'tile_raw.png')


def main():
    clear_scene()
    data = grass_tile.build()
    tile = float(data['tile'])
    me = make_mesh(data)

    # Девять копий: центральная и восемь соседних. Так край плитки
    # продолжается с другой стороны, и шва нет по построению.
    for dy in (-tile, 0.0, tile):
        for dx in (-tile, 0.0, tile):
            obj = bpy.data.objects.new('%sturf_%d_%d' % (PREFIX, int(dx), int(dy)), me)
            obj.location = (dx, dy, 0.0)
            bpy.context.scene.collection.objects.link(obj)

    make_ground(tile)
    make_camera(tile)
    make_sun(tile)
    setup_world()
    setup_render(tile)

    bpy.context.scene['pg_tile'] = tile
    bpy.context.scene['pg_seed'] = int(data['seed'])
    bpy.context.scene['pg_tris'] = int(data['stats']['tris'])
    bpy.context.view_layer.update()

    # Когда сцена собирается headless, .blend для отдачи сохраняем копией:
    # чужой открытый файл этот сценарий не трогает.
    save = os.environ.get('PG_SAVE')
    if save:
        bpy.ops.wm.save_as_mainfile(filepath=save, copy=True)

    global dsh_result
    dsh_result = {
        'tile': tile,
        'seed': data['seed'],
        'stats': data['stats'],
        'objects': len(bpy.data.objects),
        'triangles_rendered': data['stats']['tris'] * 9,
        'camera': bpy.context.scene.camera.name if bpy.context.scene.camera else None,
        'engine': bpy.context.scene.render.engine,
    }
    print('PG_TILE_READY', dsh_result)


if __name__ == '__main__':
    main()
