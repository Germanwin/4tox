"""calib_live.py — проходы A/B для калибровки палитры (исполняется в Blender).

    $PY tools/blmcp.py run tools/calib_live.py

Для КАЖДОГО из четырёх поворотов снимаются два кадра:
    A — обычный канонный рендер (то, что увидит игрок);
    B — тот же кадр, но вместо палитры подставлены ПЛОСКИЕ ЭМИССИИ с уникальным
        цветом на каждую пару (семейство, тон): карта «какой фасет куда попал».
        Солнце и мир на проходе B глушатся, view transform Standard — цвет
        эмиссии доезжает до PNG без искажений.

Четыре поворота нужны потому, что в одном кадре видно не всё: при повороте 0
видны фасад (+Y) и торец (-X), а стена -Y и торец +X закрыты. Без 180° у части
пар (семейство, тон) не набирается пикселей, и калибровать их нечем.

Считает внешний python (tools/calib_solve.py): в Blender нет Pillow.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
sys.path.append(os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy                                                        # noqa: E402

import build as B                                                 # noqa: E402
import scene as SC                                                # noqa: E402

ROTATIONS = (0, 90, 180, 270)

# 27 цветов-идентификаторов: узлы сетки 3 x 3 x 3, разнесены на 0.30+ по каналу
GRID = [0.13, 0.46, 0.80]
IDS = [(r, g, b) for r in GRID for g in GRID for b in GRID]


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def id_material(k):
    name = 'vh_id_%d' % k
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    r, g, b = IDS[k]
    em.inputs['Color'].default_value = (_lin(r), _lin(g), _lin(b), 1.0)
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    mat.diffuse_color = (r, g, b, 1.0)
    return mat


def main():
    sc = SC.use_scene(fresh=False)
    B.PPU = 80.0
    os.makedirs(B.RENDERS, exist_ok=True)
    pair_meta = []

    for rot in ROTATIONS:
        SC.clear_own(sc)
        B.reset_palette()
        B.P.RES_X, B.P.RES_Y = B.RES_X, B.RES_Y
        B.P.ORTHO = B.P.RES_Y / B.PPU
        SC.setup(samples=16)
        objs, parts = B.build_variant('a', sc)
        ob = objs[0]
        if rot:
            B.rotate_meshes(rot, sc)
            B.assign_tones(ob)

        pa = os.path.join(B.RENDERS, 'calib_a_%d.png' % rot)
        B.P.render_to(pa)

        normal_mats = list(ob.data.materials)
        for k in range(len(B.SLOTS)):
            ob.data.materials[k] = id_material(k)
        sun = bpy.data.objects.get(SC.PREFIX + 'sun')
        old_e = sun.data.energy if sun else None
        if sun:
            sun.data.energy = 0.0
        world = bpy.context.scene.world
        bg = (world.node_tree.nodes.get('Background')
              if world and world.use_nodes else None)
        old_s = bg.inputs['Strength'].default_value if bg else None
        if bg:
            bg.inputs['Strength'].default_value = 0.0
        pb = os.path.join(B.RENDERS, 'calib_b_%d.png' % rot)
        B.P.render_to(pb)
        for i, m in enumerate(normal_mats):
            ob.data.materials[i] = m
        if sun and old_e is not None:
            sun.data.energy = old_e
        if bg and old_s is not None:
            bg.inputs['Strength'].default_value = old_s
        pair_meta.append(dict(rot=rot, a=os.path.basename(pa), b=os.path.basename(pb)))
        print('поворот %3d: %s + %s' % (rot, os.path.basename(pa),
                                        os.path.basename(pb)))

    meta = dict(slots=[list(s) for s in B.SLOTS], ids=IDS[:len(B.SLOTS)],
                targets={fam: list(B.PAL.tones(fam)) for fam in B.PAL.FAMILIES},
                pairs=pair_meta, ppu=B.PPU, res=[B.P.RES_X, B.P.RES_Y],
                base={fam: [B.base_hex(fam, t) for t in range(3)]
                      for fam in B.PAL.FAMILIES})
    with open(os.path.join(B.RENDERS, 'calib_meta.json'), 'w',
              encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print('пар (семейство, тон): %d; кадров: %d'
          % (len(B.SLOTS), 2 * len(pair_meta)))


if __name__ == '__main__':
    main()
