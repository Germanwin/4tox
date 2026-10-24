"""build_live.py — точка входа сборки: исполняется ВНУТРИ живого Blender.

    $PY tools/blmcp.py info                        # жив ли сокет и что открыто
    $PY tools/blmcp.py run tools/build_live.py     # по live_config.json
    $PY tools/blmcp.py run tools/build_live.py -- --config live_4x.json
    $PY tools/blmcp.py run tools/build_live.py -- --config live_export.json
    $PY tools/blmcp.py shot renders/live_view.png  # вьюпорт — ОТДЕЛЬНОЙ командой

Правило заказчика (2026-10-12): форма делается только в УЖЕ ЗАПУЩЕННОМ Blender.
Здесь Blender — способ ПОКАЗАТЬ то, что посчитал чистый Python (`house.py`).

ЧТО ЗДЕСЬ СВОЁ, А ЧТО ИЗ БИБЛИОТЕКИ:
  * геометрия — `tools/house.py` (чистый Python, ни одного `bpy`);
  * сцена, камера, свет, рендер, выгрузка — `tools/blender_live.py`;
  * МАТЕРИАЛЫ — свои: двенадцать ПЛОСКИХ красок ратуши, по одной на деталь
    (у ратуши нет тонов по нормали — на этом забракована первая ревизия дома).
    Поэтому `blender_live.build_object` (он раскладывает фасеты по тонам) тут
    не зовётся: детали собираются по одной, у каждой своя краска.

БЕЗОПАСНОСТЬ ЖИВОЙ СЕССИИ: своя сцена `starter_house`, свой префикс `sh_`,
чистим только свои объекты, `read_factory_settings` не зовём, `.blend` отдаём
КОПИЕЙ, выделение — через `select_set`, а не через `bpy.ops`.
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

import bpy                                                        # noqa: E402


def _pin(name, path):
    """Загрузить модуль проекта ПО ПУТИ и закрепить его в sys.modules.

    Живой Blender — один процесс на всех: у соседнего проекта есть свой
    `house.py` и свой `forge.py`, и импорт по имени молча отдал бы чужой код.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


F = _pin('forge', os.path.join(HERE, 'forge.py'))
BL = _pin('blender_live', os.path.join(HERE, 'blender_live.py'))
HS = _pin('starter_house_gen', os.path.join(HERE, 'house.py'))

THPAL = os.path.join(HERE, 'thpal.json')
CONFIG = os.path.join(ROOT, 'live_config.json')
DEFAULTS = dict(scene='starter_house', prefix='sh_', variants=[None],
                rotations=[0, 90, 180, 270], ppu=96, res=[512, 640],
                samples=64, export=False, save_blend=False, viewport=False,
                tag='sh', closeups=False, out='out', shots=None)
ROUGH = {'stone': 0.92, 'stone2': 0.92, 'iron': 0.78}


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


def config():
    cfg = dict(DEFAULTS)
    path = opt('--config', CONFIG)
    if not isinstance(path, str):
        path = CONFIG
    if not os.path.isabs(path):
        path = os.path.join(ROOT, path)

    def _load(p):
        with open(p, encoding='utf-8') as fh:
            return json.load(fh)

    try:
        cfg.update(_load(path))
        print('конфиг: %s' % path)
    except Exception as e:
        print('конфиг %s не прочитан (%s) — беру умолчания' % (path, e))
    # ПАЛИТРА КАНОНА: те же двенадцать hex, что в spec.json
    with open(THPAL, encoding='utf-8') as fh:
        cfg['palette'] = {k: v['light'] for k, v in _load(THPAL)['tones'].items()}
    return cfg


def palette_hex(cfg):
    return {k: int(v.lstrip('#'), 16) for k, v in cfg['palette'].items()}


def make_materials(cfg):
    mats = {}
    for fam, hexv in palette_hex(cfg).items():
        mats[fam] = BL.make_material(cfg['prefix'] + fam, hexv,
                                     rough=ROUGH.get(fam, 0.86))
    return mats


def build_objects(parts, cfg, mats, scene):
    """Одна деталь — один объект со своим именем и своей ПЛОСКОЙ краской.

    Имена обязаны дожить до приёмки: гейт ищет дверь, стены и цоколь по именам,
    а сведённый в один меш экспорт их теряет (на этом сгорел прошлый прогон:
    «полотна двери не нашлись»).
    """
    objs = []
    for p in parts:
        me = bpy.data.meshes.new(cfg['prefix'] + p['name'])
        me.from_pydata([tuple(v) for v in p['verts']], [],
                       [tuple(f) for f in p['faces']])
        me.validate(verbose=False)
        me.update()
        ob = bpy.data.objects.new(cfg['prefix'] + p['name'], me)
        (scene.collection if scene else bpy.context.collection).objects.link(ob)
        ob.data.materials.append(mats[p['family']])
        for poly in me.polygons:
            poly.use_smooth = False
        objs.append(ob)
    return objs


def rotate_own(objs, deg):
    """Поворот модели вокруг Z. Свет и камера НЕ подкручиваются (канон)."""
    if not deg:
        return
    ang = math.radians(deg)
    for ob in objs:
        ob.rotation_euler = (0.0, 0.0, ang)


def main():
    cfg = config()
    t0 = time.time()
    sc = BL.use_scene(cfg['scene'])
    print('сцена сборки: %r (сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    mats = make_materials(cfg)
    BL.setup(sc, cfg['prefix'], ppu=cfg['ppu'], res=cfg['res'],
             samples=cfg['samples'])
    os.makedirs(os.path.join(ROOT, 'renders'), exist_ok=True)
    os.makedirs(os.path.join(ROOT, cfg.get('out', 'out')), exist_ok=True)

    frames = {}
    for var in cfg['variants']:
        for rot in cfg['rotations']:
            name = '%s_%s_%d' % (cfg['tag'], var if var else 'x', rot)
            raw = os.path.join(ROOT, 'renders', name + '_raw.png')
            BL.clear_own(sc, cfg['prefix'], keep=('cam', 'sun'))
            parts = HS.build(var)
            objs = build_objects(parts, cfg, mats, sc)
            rotate_own(objs, rot)
            BL.render_to(raw, sc)
            size = BL.world_size(objs)
            frames[name] = dict(variant=var, rotation=rot, raw=raw,
                                tris=sum(len(p.vertices) - 2
                                         for o in objs for p in o.data.polygons),
                                verts=sum(len(o.data.vertices) for o in objs),
                                parts=len(parts), size=size,
                                footprint=list(BL.footprint(objs)))
            print('RENDERED %s трис=%d верт=%d деталей=%d габарит=%s (%.1f с)'
                  % (name, frames[name]['tris'], frames[name]['verts'],
                     frames[name]['parts'], size, time.time() - t0))

    if cfg['export'] or cfg['save_blend'] or cfg['viewport'] or cfg['closeups']:
        BL.clear_own(sc, cfg['prefix'], keep=('cam', 'sun'))
        parts = HS.build(cfg['variants'][0])
        objs = build_objects(parts, cfg, mats, sc)
    if cfg['closeups']:
        shots = cfg.get('shots')
        if not shots:
            shots = [('cu_door', (1.05, 2.25, 1.05), (0.0, 1.38, 0.62), 60.0),
                     ('cu_plinth', (-1.75, -2.05, 0.75), (-0.75, -1.30, 0.12), 55.0),
                     ('cu_eave', (-2.10, 0.35, 0.55), (-0.85, 0.45, 1.45), 50.0)]
        for p in BL.closeups(shots, os.path.join(ROOT, 'renders')):
            print('CLOSEUP %s' % p)
    if cfg['export']:
        glb, obj = BL.export_model(os.path.join(ROOT, cfg.get('out', 'out'),
                                                '%s_model' % cfg['tag']),
                                   cfg['prefix'], sc)
        print('EXPORTED %s\nEXPORTED %s' % (glb, obj))
    if cfg['save_blend']:
        path = os.path.join(ROOT, '%s_model.blend' % cfg['tag'])
        print('СЦЕНА СОХРАНЕНА КОПИЕЙ %s' % BL.save_blend_copy(path))
    if cfg['viewport']:
        print('вьюпорт в вид камеры: %s' % BL.viewport_camera())

    with open(os.path.join(ROOT, 'renders', '%s_report.json' % cfg['tag']),
              'w', encoding='utf-8') as fh:
        json.dump(dict(ppu=cfg['ppu'], res=cfg['res'], scene=sc.name,
                       prefix=cfg['prefix'],
                       el_deg=math.degrees(BL.EL), az_deg=math.degrees(BL.AZ),
                       sun=list(BL.SUN_DIR), palette=cfg['palette'],
                       frames=frames), fh, ensure_ascii=False, indent=1)
    print('%s_report.json записан; кадров %d, время %.1f с'
          % (cfg['tag'], len(frames), time.time() - t0))


if __name__ == '__main__':
    main()
