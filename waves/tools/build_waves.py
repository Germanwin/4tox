"""Рендер спрайтов волн: формы x повороты -> renders/wave_<форма>_<поворот>_raw.png

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/build_waves.py -- [опции]

Опции:
    --rotations 0,90          поворот гребня вокруг вертикали: 0 — вал вдоль
                              течения (по X), 90 — вал поперёк течения, пеной
                              по ходу волны (камера рендера кладёт +X влево,
                              поэтому именно 90°, а не 270°)
    --shapes 4                сколько форм из wave_models.SHAPES
    --samples 64              сэмплов EEVEE
    --save-blend              сохранить сцену первой формы

Конвенции сцены берутся из townhall/tools/thpipe.py — тот же свет, та же
изометрия (азимут 45°, подъём 35.2644°), те же примитивы. Меняется только
кадр: гребень мелкий, и на предельном зуме игры (120 px на клетку) спрайт
должен быть примерно 1:1, поэтому кадр плотнее — 120 px на юнит.

Пост-обработка (тень, контур, обрезка) — отдельно: python3 tools/compose_waves.py
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy
import thpipe as P
import wave_models as W

RENDERS = os.path.join(ROOT, 'renders')

# Кадр волн: та же изометрия, но 120 px на юнит вместо 80 — в игре гребень
# рисуется мелким, и запас по пикселям тут важнее, чем у ратуши.
P.RES_X, P.RES_Y = 768, 960
P.ORTHO = 8.0
PPU = P.RES_Y / P.ORTHO          # 120 px на юнит


def argv():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def opt(name, default=None):
    a = argv()
    if name in a:
        i = a.index(name)
        if i + 1 < len(a) and not a[i + 1].startswith('--'):
            return a[i + 1]
        return True
    return default


def main():
    rotations = [float(x) for x in str(opt('--rotations', '0,90')).split(',')]
    shapes = int(opt('--shapes', len(W.SHAPES)))
    samples = int(opt('--samples', 64))
    save_blend = bool(opt('--save-blend', False))
    os.makedirs(RENDERS, exist_ok=True)

    report = {'ortho': P.ORTHO, 'res': [P.RES_X, P.RES_Y], 'ppu': PPU,
              'el_deg': math.degrees(P.EL), 'az_deg': math.degrees(P.AZ),
              'sun': list(P.SUN_DIR), 'sun_energy': P.SUN_ENERGY, 'frames': {}}

    for shape in range(shapes):
        for rot in rotations:
            P.clear_scene()
            W.reset_palette()
            P.setup_camera()
            P.setup_light()
            P.setup_render(samples=samples)
            objs = W.build(shape, rot)
            name = 'wave_%d_%d' % (shape, int(rot))
            P.render_to(os.path.join(RENDERS, name + '_raw.png'))
            tris, verts = P.stats()
            report['frames'][name] = dict(tris=tris, verts=verts, objects=len(objs),
                                          shape=shape, rotation=rot)
            print('RENDERED %s  объектов=%d треугольников=%d вершин=%d' % (
                name, len(objs), tris, verts))
            if save_blend and shape == 0 and rot == rotations[0]:
                blend = os.path.join(ROOT, 'waves.blend')
                bpy.ops.wm.save_as_mainfile(filepath=blend)
                print('СЦЕНА СОХРАНЕНА %s' % blend)

    with open(os.path.join(RENDERS, 'wave_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('wave_report.json записан')


if __name__ == '__main__':
    main()
