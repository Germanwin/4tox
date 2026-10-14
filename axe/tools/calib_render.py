"""Калибровка палитры, шаг 1: рендер проб по нормалям фасетов.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/calib_render.py -- --variant a

Для каждой семьи (дерево, железо/камень, кожа) и каждого тона (свет /
средний / тень) берётся представительная нормаль — самый крупный видимый
фасет этого тона в собранной модели, — и рисуется плоская проба тем же
материалом и тем же светом, что и спрайт.

На выходе renders/calib_probes.json: что рисовали и чем. Решение (какой
базовый цвет даёт тон эталона) считает tools/calib_solve.py — там есть
Pillow, а в Blender его нет.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bmesh
import bpy
from mathutils import Matrix, Vector

import color as C
import thpipe as P
import axe as A

RENDERS = os.path.join(ROOT, 'renders')
P.RES_X, P.RES_Y = 256, 256
P.ORTHO = 0.5


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


def probe(normal, key, path, samples=16):
    """Плоская проба: квадрат с заданной нормалью, в центре кадра."""
    P.clear_scene()
    A.reset_palette()          # clear_scene снёс материалы: палитра строится заново
    P.setup_camera()
    P.setup_light()
    P.setup_render(samples=samples)
    n = Vector(normal).normalized()
    ref = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))
    u = n.cross(ref).normalized()
    v = n.cross(u).normalized()
    half = 0.20
    pts = [(-u * half - v * half), (u * half - v * half),
           (u * half + v * half), (-u * half + v * half)]
    bm = bmesh.new()
    vs = [bm.verts.new(tuple(p)) for p in pts]
    bm.faces.new(vs)
    me = bpy.data.meshes.new('probe')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('probe', me)
    ob.data.materials.append(A.M(key))
    bpy.context.collection.objects.link(ob)
    P.render_to(path)


ROLES = dict(handle='wood', lashing='leather')


def collect_normals(variant, rotations=(0, 90, 180, 270)):
    """Представительные нормали тонов по ВСЕМ поворотам.

    Тон, который на повороте 0° лежит на невидимых фасетах (у головы это
    тёмный тон), на повороте 180° выходит на щёку — и должен попадать в цель
    именно там. Поэтому нормаль каждого тона берётся как самый крупный
    видимый фасет среди всех четырёх поворотов: поворот модели заменяем
    поворотом света и камеры, чтобы не трогать геометрию.
    """
    v0, s0 = A.VIEW_FROM.copy(), A.SUN_FROM.copy()
    best = {}
    for rot in rotations:
        R = Matrix.Rotation(math.radians(rot), 3, 'Z')
        A.VIEW_FROM = R.inverted() @ v0
        A.SUN_FROM = R.inverted() @ s0
        P.clear_scene()
        A.reset_palette()
        P.setup_camera()
        P.setup_light()
        P.setup_render(samples=16)
        for ob in A.build(variant):
            fam = ROLES.get(ob.name, A.HEAD_FAMILY[variant])
            for tone, (n, w) in A.bucket_normals(ob, fam).items():
                key = (fam, tone)
                if key not in best or w > best[key][1]:
                    best[key] = (R @ n, w)
    A.VIEW_FROM, A.SUN_FROM = v0, s0
    return best


def base_hex(mat):
    """Линейный hex материала — ровно то, что положил make_material."""
    b = mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value
    return C.lin_hex([b[0], b[1], b[2]])


def main():
    variant = str(opt('--variant', 'a'))
    samples = int(opt('--samples', 16))
    os.makedirs(RENDERS, exist_ok=True)

    # 1. представительные нормали тонов по всем поворотам
    best = collect_normals(variant)
    P.clear_scene()
    A.reset_palette()
    P.setup_camera()
    P.setup_light()
    P.setup_render(samples=samples)
    for ob in A.build(variant):
        print('%-8s тона: %s' % (ob.name, A.tone_census([ob])))

    # 2. по пробе на каждый тон
    probes = []
    for (fam, tone), (n, w) in sorted(best.items()):
        key = A.FAMILY[fam][tone]
        png = os.path.join(RENDERS, 'calib_%s_%d.png' % (fam, tone))
        probe(n, key, png, samples=samples)
        mat = A.M(key)          # материал после пробы: палитра пересоздана
        target = A.TARGET.get(key, A.TARGET_STONE.get(key))
        probes.append(dict(family=fam, tone=tone, key=key,
                           normal=[round(x, 5) for x in n],
                           weight=round(w, 6),
                           base_hex='#%06X' % base_hex(mat),
                           target_hex='#%06X' % target,
                           probe=os.path.relpath(png, ROOT)))
        print('ПРОБА %-8s тон=%d  n=(%.2f, %.2f, %.2f)  base=#%06X  цель=#%06X'
              % (fam, tone, n.x, n.y, n.z, base_hex(mat), target))

    out = os.path.join(RENDERS, 'calib_probes.json')
    with open(out, 'w') as f:
        json.dump(dict(variant=variant, probes=probes), f, ensure_ascii=False, indent=1)
    print('записано %s' % out)


if __name__ == '__main__':
    main()
