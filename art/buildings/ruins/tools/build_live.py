"""build_live.py — сборка РУИН в УЖЕ ЗАПУЩЕННОМ Blender через сокет MCP.

    $PY tools/mcp.py run tools/build_live.py -- --types house
    $PY tools/mcp.py run tools/build_live.py -- --types house --rotations 0,90,180,270
    $PY tools/mcp.py run tools/build_live.py -- --types townhall --ppu 80
    $PY tools/mcp.py run tools/build_live.py -- --types house --gate
    $PY tools/mcp.py shot renders/live.png        # вьюпорт — ОТДЕЛЬНОЙ командой

Почему ppu у типов разный.  У целых атласов: ратуша — 80 ppu, дом, лагерь,
казарма и лагерь военный — 96.  Руина обязана стоять на карте там же, где
целая: `anchorX/anchorY`, `mul` и `ground` берутся у целого атласа, а кадр
рисуется ТОЙ ЖЕ камерой и с ТЕМ ЖЕ ppu.  Иначе 431-пиксельный кадр ратуши,
посчитанный при 96 ppu, просто не влезает в её пятно 4 x 3 (при 96 ppu
диагональ 4 x 3 — 475 px против 431).  Поэтому `--ppu` задаётся на тип, а не
один на все; в atlas.json ppu пишется и общий (96), и покадровый (точный).

ЧТО ЗДЕСЬ ВАЖНО:
    * работаем в СВОЕЙ сцене `ruins` и со своим префиксом `rn_`;
    * `read_factory_settings` не зовём НИКОГДА — в этом Blender открыт файл
      заказчика;
    * `.blend` отдаём КОПИЕЙ;
    * `--gate` собирает ту же геометрию ДЕТАЛЬ = ОБЪЕКТ: приёмка
      `3d-model-acceptance` ищет детали по именам, а сведённый меш имён не
      имеет.
"""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy                                                       # noqa: E402


def _pin(name, path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


F = _pin('forge', os.path.join(HERE, 'forge.py'))
V = _pin('ruin_palette', os.path.join(HERE, 'ruin_palette.py'))
K = _pin('ruinkit', os.path.join(HERE, 'ruinkit.py'))
BL = _pin('blender_live', os.path.join(HERE, 'blender_live.py'))

TYPES = ('townhall', 'house', 'lumbercamp', 'barracks', 'warcamp')
# ppu целых атласов: townhall 80, остальные 96 (см. mapgen2/assets/*/atlas.json)
PPU = {'townhall': 80.0, 'house': 96.0, 'lumbercamp': 96.0,
       'barracks': 96.0, 'warcamp': 96.0}
SCENE = 'ruins'
PREFIX = 'rn_'
RES = [512, 640]


def _argv():
    a = sys.argv
    if '--' in a:
        return a[a.index('--') + 1:]
    return a[1:] if a else []


def opt(name, default=None):
    a = _argv()
    if name in a:
        i = a.index(name)
        if i + 1 < len(a) and not a[i + 1].startswith('--'):
            return a[i + 1]
        return True
    return default


def load_type(t):
    return _pin('ruin_' + t, os.path.join(HERE, 'ruin_%s.py' % t))


def build_parts_separately(scene, prefix, parts):
    """Один объект на деталь — для приёмки `gate.py` (имена деталей видны)."""
    mats, out, seen = {}, [], {}
    for p in parts:
        zone = p['family']
        if zone not in mats:
            hex_lin, rough, spec = V.paint(zone)
            mats[zone] = BL.make_material(prefix + zone, hex_lin,
                                          rough=rough, spec=spec)
        base = prefix + p['name']
        n = seen.get(base, 0)
        seen[base] = n + 1
        name = base if n == 0 else '%s.%03d' % (base, n)
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in p['verts']], [],
                       [tuple(f) for f in p['faces']])
        me.validate(verbose=False)
        me.update()
        ob = bpy.data.objects.new(name, me)
        scene.collection.objects.link(ob)
        ob.data.materials.append(mats[zone])
        for poly in me.polygons:
            poly.use_smooth = False
            poly.material_index = 0
        out.append(ob)
    return out


def main():
    t0 = time.time()
    types = (opt('--types') or ','.join(TYPES)).split(',')
    rots = [int(r) for r in (opt('--rotations') or '0,90,180,270').split(',')]
    scale = float(opt('--scale') or 1.0)
    gate = bool(opt('--gate', False))
    save_blend = bool(opt('--save-blend', False))
    closeup = bool(opt('--closeups', False))

    sc = BL.use_scene(SCENE)
    print('сцена сборки: %r (в файле сцен: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    print('палитра руин: зон %d, угольных 2 (char, ash)' % len(V.ZONES))
    os.makedirs(os.path.join(ROOT, 'renders'), exist_ok=True)

    frames = {}
    for t in types:
        if t not in TYPES:
            raise SystemExit('неизвестный тип %r (есть %s)' % (t, ', '.join(TYPES)))
        ppu = float(opt('--ppu') or PPU[t]) * scale
        res = [RES[0] * int(round(scale)), RES[1] * int(round(scale))]
        BLD = load_type(t)
        BL.setup(sc, PREFIX, ppu=ppu, res=res, samples=32 if gate else 64)
        print('--- %s: ppu %s, кадр %sx%s, кадров %d ---'
              % (t, ppu, res[0], res[1], 0 if gate else len(rots)))
        if gate:
            BL.clear_own(sc, PREFIX, keep=('cam', 'sun'))
            parts = BLD.build(None)
            objs = build_parts_separately(sc, PREFIX, parts)
            print('СЦЕНА ДЛЯ ПРИЁМКИ %s: объектов %d, деталей %d'
                  % (t, len(objs), len(parts)))
            frames[t] = dict(ppu=ppu, parts=len(parts), objects=len(objs))
            continue
        for rot in rots:
            BL.clear_own(sc, PREFIX, keep=('cam', 'sun'))
            parts = BLD.build(None)
            ob, slots, fams = BL.build_object_zones(
                parts, PREFIX + '%s_%d' % (t, rot), PREFIX, sc)
            if rot:
                BL.rotate_meshes(rot, PREFIX, sc)
            tag = 'rn_%s_%d' % (t, rot)
            raw = os.path.join(ROOT, 'renders', tag + (
                '@4x' if scale > 1.0 else '') + '_raw.png')
            BL.render_to(raw, sc)
            size = BL.world_size([ob])
            fp = BL.footprint([ob])
            tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
            frames['%s_%d' % (t, rot)] = dict(
                type=t, rotation=rot, raw=raw, ppu=ppu, res=res, tris=tris,
                verts=len(ob.data.vertices), parts=len(parts), size=size,
                footprint=list(fp))
            print('RENDERED %s трис=%d деталей=%d габарит=%s (%.1f с)'
                  % (tag, tris, len(parts), size, time.time() - t0))

    if save_blend:
        BL.clear_own(sc, PREFIX, keep=('cam', 'sun'))
        # В сохранённой сцене типы ставятся В РЯД, а не друг в друге: иначе
        # .blend-исходник открывается кашей из пяти моделей в одной точке.
        for k, t in enumerate(types):
            BLD = load_type(t)
            parts = BLD.build(None)
            ob, slots, fams = BL.build_object_zones(parts, PREFIX + t,
                                                    PREFIX, sc)
            ob.location = (0.0, -k * 4.2, 0.0)
        path = os.path.join(ROOT, 'ruins_model.blend')
        print('СЦЕНА СОХРАНЕНА КОПИЕЙ %s' % BL.save_blend_copy(path))

    tag = 'rn_gate' if gate else ('rn4x' if scale > 1.0 else 'rn')
    with open(os.path.join(ROOT, 'renders', '%s_report.json' % tag), 'w',
              encoding='utf-8') as fh:
        json.dump(dict(scene=sc.name, prefix=PREFIX, frames=frames,
                       el_deg=math.degrees(BL.EL), az_deg=math.degrees(BL.AZ),
                       sun=list(BL.SUN_DIR), ppu=PPU), fh,
                  ensure_ascii=False, indent=1)
    print('%s_report.json записан; кадров %d, время %.1f с'
          % (tag, len(frames), time.time() - t0))


if __name__ == '__main__':
    main()
