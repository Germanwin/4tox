"""Сверка выгрузки: импорт out/shovel_*.glb и .obj и рендер в конвенциях пайплайна.

Headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/verify_shovel.py -- --variant a

Проверяет, что выгруженные файлы — это та же модель: рендер импортированного
файла сравнивается с рендером сцены по силуэту (IoU альфы) и по числу
треугольников. Разночтение по осям (obj — Z вверх, glb — Y вверх по стандарту)
ловится именно здесь, а не на глаз.

В ЖИВОЙ сессии этот шаг не гонять: `bpy.ops.wm.obj_import` в контексте таймера
аддона падает с `context is incorrect` (флаг `--live` оставлен для glTF, но
честная сверка — headless; см. references/pitfalls.md §5).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy
import thpipe as P
import scene as SC

RENDERS = os.path.join(ROOT, 'renders')
OUT = os.path.join(ROOT, 'out')
P.RES_X, P.RES_Y = 512, 640
P.ORTHO = P.RES_Y / 384.0


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


def render(path, importer, live=False):
    sc = SC.use_scene(fresh=not live)
    SC.clear_own(sc)
    SC.setup(samples=32)
    before = set(bpy.data.objects.keys())
    importer()
    imported = [bpy.data.objects[n] for n in set(bpy.data.objects.keys()) - before]
    tris = verts = 0
    mats = set()
    for ob in imported:
        if ob.type != 'MESH':
            continue
        verts += len(ob.data.vertices)
        for p in ob.data.polygons:
            tris += len(p.vertices) - 2
        for m in ob.data.materials:
            if m:
                mats.add(m.name)
    P.render_to(path)
    for ob in imported:
        bpy.data.objects.remove(ob, do_unlink=True)
    return tris, verts, sorted(mats)


def alpha_mask(path):
    """Маска силуэта прямо из Blender (Pillow в его питоне нет)."""
    import numpy as np
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.array(img.pixels[:], dtype='f4').reshape(h, w, 4)
    bpy.data.images.remove(img)
    return px[:, :, 3] > 0.15


def iou(a_path, b_path):
    a, b = alpha_mask(a_path), alpha_mask(b_path)
    if a.shape != b.shape:
        return 0.0
    inter = (a & b).sum()
    union = (a | b).sum()
    return float(inter) / max(1, int(union))


def main():
    var = str(opt('--variant', 'a'))
    live = bool(opt('--live', False))
    res = {}
    for ext, imp in (
            ('glb', lambda p: bpy.ops.import_scene.gltf(filepath=p)),
            ('obj', lambda p: bpy.ops.wm.obj_import(filepath=p,
                                                    forward_axis='Y', up_axis='Z'))):
        path = os.path.join(OUT, 'shovel_%s.%s' % (var, ext))
        if not os.path.exists(path):
            print('НЕТ ФАЙЛА %s' % path)
            continue
        png = os.path.join(RENDERS, 'verify_%s_%s.png' % (var, ext))
        tris, verts, mats = render(png, lambda p=path, i=imp: i(p), live=live)
        res[ext] = dict(tris=tris, verts=verts, materials=mats)
        print('ИМПОРТ %-3s треугольников=%d вершин=%d материалов=%d %s'
              % (ext, tris, verts, len(mats), mats))

    ref = os.path.join(RENDERS, 'shovel_%s_0_raw.png' % var)
    if os.path.exists(ref):
        for ext in res:
            png = os.path.join(RENDERS, 'verify_%s_%s.png' % (var, ext))
            v = iou(ref, png)
            print('СОВПАДЕНИЕ СИЛУЭТА %s: IoU=%.4f' % (ext, v))
            res[ext]['iou_vs_scene'] = round(v, 4)
    with open(os.path.join(RENDERS, 'verify_shovel.json'), 'w') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print('записано renders/verify_shovel.json')


if __name__ == '__main__':
    main()
