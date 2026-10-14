"""build_live.py — сборка дома в УЖЕ ЗАПУЩЕННОМ Blender через MCP-сокет.

    PY=/Users/hermmoment/.dsh/profiles/desktop/node_modules/dsh-blender/.venv/bin/python
    $PY tools/blmcp.py run tools/build_live.py

Файл исполняется ВНУТРИ Blender (аддон blender-mcp, 127.0.0.1:9876), а не
запускает новый процесс:
    * работает в ОТДЕЛЬНОЙ сцене `villager_house` (tools/scene.py), сцена
      заказчика остаётся нетронутой;
    * рендерит канонные кадры 512 x 640 в renders/vh_<вар>_<поворот>_raw.png;
    * по ходу работы переводит вьюпорт в вид камеры — модель видно сразу.

Настройки — live_config.json рядом с проектом:

    {"variants": "a", "rotations": [0, 90, 180, 270], "samples": 32,
     "ppu": 80, "export": false, "save_blend": false, "viewport": true,
     "shot": "renders/live_iso.png", "views": false}
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
sys.path.append(os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy                                                      # noqa: E402

import build as B                                               # noqa: E402
import scene as SC                                              # noqa: E402
import house as H                                               # noqa: E402
import palette as PAL                                           # noqa: E402

CONFIG = os.path.join(ROOT, 'live_config.json')
DEFAULTS = dict(variants='a', rotations=[0, 90, 180, 270], samples=32,
                ppu=80, res=[512, 640], export=False, save_blend=False,
                viewport=True, shot=None, views=False, tag='vh')


def _argv():
    """Аргументы после '--'. blmcp съедает сам разделитель, поэтому если его
    нет — берём всё после имени файла (иначе --config молча игнорируется)."""
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
    if isinstance(cfg['variants'], str):
        cfg['variants'] = [v for v in cfg['variants'].split(',') if v]
    return cfg


def main():
    cfg = config()
    t0 = time.time()
    B.PPU = float(cfg['ppu'])
    B.RES_X, B.RES_Y = [int(v) for v in cfg['res']]
    sc = SC.use_scene(fresh=False)
    os.makedirs(B.RENDERS, exist_ok=True)
    os.makedirs(B.OUT, exist_ok=True)
    print('сцена сборки: %r (сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    print('палитра: %d семейств, калибровка %s'
          % (len(PAL.FAMILIES),
             'есть' if B.calibration() else 'НЕТ (базовые цвета = цель/LIFT)'))
    diffs = PAL.check()
    if diffs:
        print('ВНИМАНИЕ: палитра разошлась со скиллом: %s' % diffs)

    report = {'ppu': B.PPU, 'ortho': B.RES_Y / B.PPU, 'res': [B.RES_X, B.RES_Y],
              'tag': cfg['tag'],
              'el_deg': math.degrees(B.P.EL), 'az_deg': math.degrees(B.P.AZ),
              'sun': list(B.P.SUN_DIR), 'sun_energy': B.P.SUN_ENERGY,
              'live': not bpy.app.background, 'frames': {}}

    for var in cfg['variants']:
        for rot in cfg['rotations']:
            name = '%s_%s_%d' % (cfg['tag'], var, rot)
            raw = os.path.join(B.RENDERS, name + '_raw.png')
            info = B.render_frame(var, rot, cfg['samples'], raw, scene=sc,
                                  ppu=B.PPU)
            report['frames'][name] = dict(info, variant=var, rotation=rot)
            print('RENDERED %s  трис=%d верт=%d деталей=%d высота=%.2f '
                  'пятно=%s (%.2f с)'
                  % (name, info['tris'], info['verts'], info['parts'],
                     info['size'], info['footprint'],
                     time.time() - t0))

    if cfg['save_blend'] or cfg['export'] or cfg['shot']:
        SC.clear_own(sc)
        SC.setup(samples=cfg['samples'])
        B.build_variant(B.MAIN, sc)
    if cfg['export']:
        B.export_model(os.path.join(B.OUT, 'house_%s' % B.MAIN), scene=sc)
    if cfg['save_blend']:
        path = os.path.join(ROOT, 'house_%s.blend' % B.MAIN)
        # ЧУЖОЙ ФАЙЛ НЕ СОХРАНЯЕМ: только копией
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=False,
                                    check_existing=False)
        print('СЦЕНА СОХРАНЕНА КОПИЕЙ %s' % path)
    if cfg['viewport']:
        print('вьюпорт в вид камеры: %s' % SC.viewport_camera())
    # ВНИМАНИЕ: скриншот вьюпорта снимается ОТДЕЛЬНОЙ командой клиента
    # (`blmcp.py shot`), а не отсюда: аддон исполняет наш код в главном потоке
    # через таймер, и вложенное соединение к тому же сокету встало бы намертво.

    with open(os.path.join(B.RENDERS, '%s_report.json' % cfg['tag']), 'w',
              encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('%s_report.json записан; кадров %d, время %.1f с'
          % (cfg['tag'], len(report['frames']), time.time() - t0))


if __name__ == '__main__':
    main()
