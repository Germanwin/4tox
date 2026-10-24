"""build_live.py — КАЗАРМА: точка входа, исполняется ВНУТРИ живого Blender.

    $PY tools/mcp.py run tools/build_live.py                 # по live_config.json
    $PY tools/mcp.py run tools/build_live.py -- --config live_4x.json
    $PY tools/mcp.py shot renders/live.png                   # вьюпорт (отдельной командой!)

Настройки — `live_config.json` рядом с корнем проекта:

    {"scene": "forge_building", "prefix": "fb_", "variants": [null],
     "rotations": [0, 90, 180, 270], "ppu": 80, "res": [512, 640],
     "samples": 64, "export": false, "save_blend": false, "viewport": true,
     "tag": "fb", "closeups": false}

ЧТО ЗДЕСЬ ВАЖНО (иначе сборка тихо испортит чужой файл):
    * работаем в СВОЕЙ сцене и со своим префиксом имён, чистим только свои
      объекты; `read_factory_settings` не зовём никогда;
    * `.blend` отдаём КОПИЕЙ;
    * выделение перед экспортом — через `select_set`, не через `bpy.ops`;
    * скриншот вьюпорта снимается ОТДЕЛЬНОЙ командой клиента: вложенное
      соединение к тому же сокету из исполняемого кода встанет намертво.
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

import bpy                                                      # noqa: E402

def _pin(name, path):
    """Загрузить модуль проекта ПО ПУТИ и закрепить его под именем в sys.modules.

    Живой Blender — ОДИН процесс на всех: у заказчика, у нас и у любого другого
    агента общие `sys.path` и `sys.modules`.  Импорт по имени в такой компании
    может отдать ЧУЖОЙ модуль: у соседнего проекта есть свой `forge.py` или
    `building.py`, и тогда сборка молча идёт чужим кодом (или падает на
    несовпадении версий — например, `part() got an unexpected keyword`).

    Пиннинг закрывает дыру: модуль читается из СВОЕГО файла и кладётся в
    `sys.modules` ДО исполнения тела — поэтому и `import forge` внутри
    `blender_live` получит именно наш `forge`.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


F = _pin('forge', os.path.join(HERE, 'forge.py'))
V = _pin('paint', os.path.join(HERE, 'paint.py'))
BL = _pin('blender_live', os.path.join(HERE, 'blender_live.py'))
BLD = _pin('barracks', os.path.join(HERE, 'barracks.py'))

CONFIG = os.path.join(ROOT, 'live_config.json')
DEFAULTS = dict(scene='forge_building', prefix='fb_', variants=[None],
                rotations=[0, 90, 180, 270], ppu=80, res=[512, 640],
                samples=64, export=False, save_blend=False, viewport=True,
                tag='fb', closeups=False, cal=None, out='out')


def _argv():
    """Аргументы после '--'.  Клиент съедает сам разделитель, поэтому если его
    нет — берём всё после имени файла (иначе --config молча теряется)."""
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
        # относительный путь считается от корня проекта: cwd процесса Blender
        # не имеет ничего общего с проектом (грабли: --config молча терялся)
        path = os.path.join(ROOT, path)
    try:
        with open(path, encoding='utf-8') as f:
            cfg.update(json.load(f))
        print('конфиг: %s' % path)
    except Exception as e:
        print('конфиг %s не прочитан (%s) — беру умолчания' % (path, e))
    return cfg


def build_parts_separately(scene, prefix, parts):
    """Один объект на деталь — чтобы приёмка видела имена.

    Материалы общие по зонам: 12 красок на всю постройку, как у ратуши.
    """
    mats = {}
    out = []
    seen = {}
    for p in parts:
        zone = p['family']
        if zone not in mats:
            hex_lin, rough, spec = V.paint(zone)
            mats[zone] = BL.make_material(prefix + zone, hex_lin, rough=rough,
                                          spec=spec)
        base = prefix + p['name']
        n = seen.get(base, 0)
        seen[base] = n + 1
        name = base if n == 0 else '%s#%d' % (base, n)
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
    cfg = config()
    t0 = time.time()
    sc = BL.use_scene(cfg['scene'])
    print('сцена сборки: %r (сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    # ПАЛИТРА ДЕРЕВНИ: зоны берутся у ратуши (`village.py`), тоновый автомат и
    # калибровка атласа природы здесь больше не участвуют — см. `village.py`.
    print('палитра: деревня, зон %d (%s)'
          % (len(V.ZONES), ', '.join(sorted(V.ZONES))))
    for zone in sorted(V.ZONES):
        print('   %-8s <- ратуша %-8s #%06X' % (zone, V.paint_name(zone),
                                                 V.paint(zone)[0]))
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
            parts = BLD.build(var)
            # Один материал на зону, как у ратуши.  Тона ПО НОРМАЛИ здесь не
            # пересчитываются после поворота: краска от поворота не зависит, а
            # затенение даёт сцена — ровно как у ратуши на её четырёх кадрах.
            ob, slots, fams = BL.build_object_zones(parts,
                                                    cfg['prefix'] + 'building',
                                                    cfg['prefix'], sc)
            if rot:
                BL.rotate_meshes(rot, cfg['prefix'], sc)
            BL.render_to(raw, sc)
            size = BL.world_size([ob])
            frames[name] = dict(variant=var, rotation=rot, raw=raw,
                                tris=sum(len(p.vertices) - 2
                                         for p in ob.data.polygons),
                                verts=len(ob.data.vertices),
                                parts=len(parts), size=size,
                                footprint=list(BL.footprint([ob])))
            print('RENDERED %s трис=%d верт=%d деталей=%d габарит=%s (%.1f с)'
                  % (name, frames[name]['tris'], frames[name]['verts'],
                     frames[name]['parts'], size, time.time() - t0))

    if cfg['save_blend'] or cfg['export'] or cfg['viewport'] or cfg['closeups']:
        BL.clear_own(sc, cfg['prefix'], keep=('cam', 'sun'))
        parts = BLD.build(cfg['variants'][0])
        ob, slots, fams = BL.build_object_zones(parts,
                                                cfg['prefix'] + 'building',
                                                cfg['prefix'], sc)
    if cfg['closeups']:
        shots = cfg.get('shots') or [
            ('cu_%s' % cfg['tag'], (2.6, 2.2, 1.9), (0.0, 0.0, 0.9), 50.0)]
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

    # СЦЕНА ДЛЯ ПРИЁМКИ: деталь = объект.  Гейт `3d-model-acceptance` ищет
    # двери, стены и цоколь ПО ИМЕНАМ, а сведённый в один меш экспорт имён не
    # имеет: проверки проёма и цоколя уходят в «не нашлось». Поэтому в режиме
    # `gate` модель собирается по деталям, с тем же материалом зоны на каждой.
    if cfg.get('gate'):
        BL.clear_own(sc, cfg['prefix'], keep=('cam', 'sun'))
        parts = BLD.build(cfg['variants'][0] if cfg['variants'] else None)
        objs = build_parts_separately(sc, cfg['prefix'], parts)
        print('СЦЕНА ДЛЯ ПРИЁМКИ: объектов %d, деталей %d' % (len(objs), len(parts)))

    with open(os.path.join(ROOT, 'renders', '%s_report.json' % cfg['tag']),
              'w', encoding='utf-8') as f:
        json.dump(dict(ppu=cfg['ppu'], res=cfg['res'], scene=sc.name,
                       prefix=cfg['prefix'],
                       el_deg=math.degrees(BL.EL), az_deg=math.degrees(BL.AZ),
                       sun=list(BL.SUN_DIR), frames=frames), f,
                  ensure_ascii=False, indent=1)
    print('%s_report.json записан; кадров %d, время %.1f с'
          % (cfg['tag'], len(frames), time.time() - t0))


if __name__ == '__main__':
    main()
