"""build_live.py — сборка стартового дома в УЖЕ ЗАПУЩЕННОМ Blender через MCP.

    PY=/Users/hermmoment/.dsh/profiles/desktop/node_modules/dsh-blender/.venv/bin/python
    $PY tools/blmcp.py run tools/build_live.py

Файл исполняется ВНУТРИ Blender (аддон blender-mcp, 127.0.0.1:9876), а не
запускает новый процесс:
    * работает в ОТДЕЛЬНОЙ сцене `starter_house` (tools/scene.py), сцена
      заказчика остаётся нетронутой;
    * рендерит канонные кадры 512 x 640 в renders/sh_<поворот>_raw.png;
    * по ходу работы переводит вьюпорт в вид камеры — модель видно сразу.

ВАЖНО (грабли живого Blender): модули проекта перед сборкой выкидываются из
`sys.modules`.  Blender — долгоживущий процесс, и без этого правка `hut.py`
не подхватывается: сборка молча идёт СТАРЫМ кодом.

Настройки — live_config.json рядом с проектом.
"""
import importlib
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

# --- сброс кэша модулей проекта -------------------------------------------
for _m in ('building', 'hut', 'build', 'scene', 'palette', 'thpipe', 'thpal'):
    sys.modules.pop(_m, None)

import bpy                                                       # noqa: E402

import build as B                                                # noqa: E402
import scene as SC                                               # noqa: E402
import palette as PAL                                            # noqa: E402

CONFIG = os.path.join(ROOT, 'live_config.json')
DEFAULTS = dict(rotations=[0, 90, 180, 270], samples=64, ppu=80,
                res=[512, 640], export=False, save_blend=False,
                viewport=True, tag='sh')


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
    if not os.path.isabs(path):
        path = os.path.join(ROOT, path)
    try:
        with open(path, encoding='utf-8') as f:
            cfg.update(json.load(f))
        print('конфиг: %s' % path)
    except Exception as e:                                       # noqa: BLE001
        print('конфиг %s не прочитан (%s) — беру умолчания' % (path, e))
    return cfg


def main():
    cfg = config()
    t0 = time.time()
    B.PPU = float(cfg['ppu'])
    B.RES_X, B.RES_Y = [int(v) for v in cfg['res']]
    sc = SC.use_scene(fresh=False)
    # КАМЕРА И СВЕТ — ДО ПЕРВОГО РЕНДЕРА.  Раньше они ставились только в ветке
    # save_blend/export, и обычный прогон падал «Cannot render, no camera».
    SC.setup(samples=cfg['samples'], res=(B.RES_X, B.RES_Y))
    os.makedirs(B.RENDERS, exist_ok=True)
    os.makedirs(B.OUT, exist_ok=True)
    print('сцена сборки: %r (сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    print('палитра РАТУШИ: %d материалов — %s'
          % (len(PAL.NAMES), ', '.join(PAL.NAMES)))
    # Сверка с палитрой РАТУШИ: дом и ратуша обязаны быть из одной бочки краски.
    try:
        sys.path.append(os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))
        import thpal
        diffs = PAL.check(thpal.HEX)
        if diffs:
            print('ВНИМАНИЕ: палитра разошлась с ратушей: %s' % diffs)
        else:
            print('палитра совпадает с ратушей: 12 из 12 цветов')
    except Exception as e:                                       # noqa: BLE001
        print('сверка с палитрой ратуши не прошла: %s' % e)

    report = {'ppu': B.PPU, 'ortho': B.RES_Y / B.PPU, 'res': [B.RES_X, B.RES_Y],
              'tag': cfg['tag'], 'el_deg': math.degrees(B.P.EL),
              'az_deg': math.degrees(B.P.AZ), 'frames': {}}
    for rot in cfg['rotations']:
        name = '%s_%d' % (cfg['tag'], rot)
        raw = os.path.join(B.RENDERS, name + '_raw.png')
        info = B.render_frame(None, rot, cfg['samples'], raw, scene=sc,
                              ppu=B.PPU)
        report['frames'][name] = dict(info, rotation=rot)
        print('RENDERED %s  трис=%d верт=%d деталей=%d высота=%.2f пятно=%s '
              '(%.1f с)' % (name, info['tris'], info['verts'], info['parts'],
                            info['size'], info['footprint'], time.time() - t0))

    if cfg['save_blend'] or cfg['export']:
        SC.clear_own(sc)
        SC.setup(samples=cfg['samples'], res=(B.RES_X, B.RES_Y))
        B.build_variant(None, sc)
    if cfg['export']:
        B.export_model(os.path.join(B.OUT, 'starter_house'), scene=sc)
    if cfg['save_blend']:
        path = os.path.join(ROOT, 'starter_house.blend')
        # ЧУЖОЙ ФАЙЛ НЕ СОХРАНЯЕМ: только копией
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=False,
                                    check_existing=False)
        print('СЦЕНА СОХРАНЕНА КОПИЕЙ %s' % path)
    if cfg['viewport']:
        print(SC.viewport_camera())

    with open(os.path.join(B.RENDERS, '%s_report.json' % cfg['tag']), 'w',
              encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('%s_report.json записан; кадров %d, время %.1f с'
          % (cfg['tag'], len(report['frames']), time.time() - t0))


if __name__ == '__main__':
    main()
