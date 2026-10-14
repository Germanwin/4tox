"""Калибровка палитры, шаг 1: рендер проб по нормалям фасетов.

Headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/calib_render.py -- --variants a --samples 16
В живой сессии Blender (MCP-сокет): tools/calib_live.py — тот же расчёт, но
в отдельной сцене `shovel` (см. tools/scene.py).

Для каждой семьи (дерево, железо, кожа) и каждого тона (свет / средний / тень)
берётся представительная нормаль — самый крупный ВИДИМЫЙ фасет этого тона в
собранной модели, — и рисуется плоская проба тем же материалом и тем же светом,
что и спрайт. На выходе renders/calib_probes.json: что рисовали и чем. Решение
(какой базовый цвет даёт тон эталона) считает tools/calib_solve.py — там есть
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
import shovel as S
import scene as SC

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


def probe(normal, key, path, samples=16, scene=None):
    """Плоская проба: квадрат с заданной нормалью, в центре кадра."""
    scene = scene or bpy.context.scene
    SC.clear_own(scene)
    SC.setup(samples=samples)
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
    me = bpy.data.meshes.new('shovel_probe')
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.new('shovel_probe', me)
    ob.data.materials.append(S.M(key))
    bpy.context.collection.objects.link(ob)
    P.render_to(path)
    return ob


def collect_normals(variants=('a',), rotations=(0, 90, 180, 270), scene=None,
                    samples=16):
    """Представительные нормали тонов по всем поворотам.

    Тон, который на повороте 0° лежит на невидимых фасетах, на повороте 180°
    выходит на щёку — и должен попадать в цель именно там. Поэтому нормаль
    каждого тона берётся как самый крупный видимый фасет среди всех четырёх
    поворотов: поворот модели заменяем поворотом света и камеры, чтобы не
    трогать геометрию.
    """
    scene = scene or bpy.context.scene
    v0, s0 = S.VIEW_FROM.copy(), S.SUN_FROM.copy()
    best = {}
    for var in variants:
        for rot in rotations:
            R = Matrix.Rotation(math.radians(rot), 3, 'Z')
            S.VIEW_FROM = R.inverted() @ v0
            S.SUN_FROM = R.inverted() @ s0
            SC.clear_own(scene)
            SC.setup(samples=samples)
            fams = S.families(var)
            for ob in S.build(var):
                for tone, (n, w) in S.bucket_normals(ob, fams[ob.name]).items():
                    key = (fams[ob.name], tone)
                    if key not in best or w > best[key][1]:
                        best[key] = (R @ n, w)
    S.VIEW_FROM, S.SUN_FROM = v0, s0
    return best


def render_probes(best, samples=16, scene=None, prefix='calib'):
    """По пробе на каждый (семья, тон). Возвращает список записей для solve."""
    scene = scene or bpy.context.scene
    probes = []
    for (fam, tone), (n, w) in sorted(best.items()):
        key = S.FAMILY[fam][tone]
        png = os.path.join(RENDERS, '%s_%s_%d.png' % (prefix, fam, tone))
        ob = probe(n, key, png, samples=samples, scene=scene)
        mat = ob.data.materials[0]
        b = mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value
        base = C.lin_hex([b[0], b[1], b[2]])
        target = S.TARGET.get(key, S.TARGET_STONE.get(key))
        probes.append(dict(family=fam, tone=tone, key=key,
                           normal=[round(x, 5) for x in n],
                           weight=round(w, 6),
                           base_hex='#%06X' % base,
                           target_hex='#%06X' % target,
                           probe=os.path.relpath(png, ROOT)))
        print('ПРОБА %-8s тон=%d  n=(%.2f, %.2f, %.2f)  base=#%06X  цель=#%06X'
              % (fam, tone, n.x, n.y, n.z, base, target))
    return probes


def write_probes(probes, variants):
    out = os.path.join(RENDERS, 'calib_probes.json')
    with open(out, 'w') as f:
        json.dump(dict(variants=list(variants), probes=probes), f,
                  ensure_ascii=False, indent=1)
    print('записано %s' % out)
    return out


def main():
    variants = str(opt('--variants', 'a')).split(',')
    rotations = tuple(int(x) for x in str(opt('--rotations', '0,90,180,270')).split(','))
    samples = int(opt('--samples', 16))
    os.makedirs(RENDERS, exist_ok=True)

    sc = SC.use_scene(fresh=True)
    best = collect_normals(variants, rotations, scene=sc, samples=samples)
    SC.clear_own(sc)
    SC.setup(samples=samples)
    for var in variants:
        for ob in S.build(var):
            print('%-16s (%s) тона: %s' % (ob.name, var, S.tone_census([ob])))
    probes = render_probes(best, samples=samples, scene=sc)
    write_probes(probes, variants)


if __name__ == '__main__':
    main()
