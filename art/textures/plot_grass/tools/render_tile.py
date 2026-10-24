# -*- coding: utf-8 -*-
"""Рендер готовой сцены плитки: 1024 x 1024, Cycles, денойз.

Сцена уже собрана build_tile.py (в плоском режиме — эмиссия без света, см.
README). Этот файл только задаёт разрешение и путь, чтобы команда была одной
строкой и не тонула в --python-expr.

    blender -b --factory-startup plot_grass.blend -P tools/render_tile.py
"""

import os

import bpy

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RAW = os.path.join(ROOT, 'renders', 'plot_grass_flat_1024_raw.png')

scene = bpy.context.scene
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
scene.render.resolution_percentage = 100
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.filepath = RAW
bpy.ops.render.render(write_still=True)
print('PG_RENDER_READY', RAW)
