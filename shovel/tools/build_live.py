"""Сборка лопаты в УЖЕ ЗАПУЩЕННОМ Blender — через MCP-сокет (tools/blmcp.py).

    python3 tools/blmcp.py run tools/build_live.py

Этот файл исполняется ВНУТРИ Blender, а не запускает новый процесс:
  * работает в отдельной сцене `shovel` (tools/scene.py), сцена пользователя
    остаётся нетронутой;
  * рендерит те же кадры, что headless-сборка `build_shovel.py`
    (renders/shovel_<вар>_<поворот>_raw.png) — одни и те же конвенции камеры,
    света и кадра, поэтому результат сходится с headless-прогоном;
  * по ходу работы показывает в вьюпорте вид камеры, то есть модель видно
    глазами сразу, а не только по PNG.

Настройки читаются из live_config.json (лежит рядом с проектом), чтобы не
перезапускать Blender ради смены списка вариантов:

    {"variants": "a,b,c", "rotations": [0, 90, 180, 270], "samples": 64,
     "export": false, "save_blend": false, "viewport": true}

Печатает отчёт по кадрам; пути — от корня проекта.
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
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy

import build_shovel as B
import scene as SC
import shovel as S

CONFIG = os.path.join(ROOT, 'live_config.json')

DEFAULTS = dict(variants='a,b,c', rotations=[0, 90, 180, 270], samples=64,
                export=False, save_blend=False, viewport=True)


def config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG) as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    if isinstance(cfg['variants'], str):
        cfg['variants'] = [v for v in cfg['variants'].split(',') if v]
    return cfg


def main():
    cfg = config()
    t0 = time.time()
    sc = SC.use_scene(fresh=False)
    os.makedirs(B.RENDERS, exist_ok=True)
    os.makedirs(B.OUT, exist_ok=True)
    print('сцена сборки: %r (всего сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))

    report = {'ortho': B.P.ORTHO, 'res': [B.P.RES_X, B.P.RES_Y], 'ppu': B.PPU,
              'el_deg': math.degrees(B.P.EL), 'az_deg': math.degrees(B.P.AZ),
              'sun': list(B.P.SUN_DIR), 'sun_energy': B.P.SUN_ENERGY,
              'lift': S.LIFT, 'live': True, 'frames': {}}

    for var in cfg['variants']:
        for rot in cfg['rotations']:
            name = 'shovel_%s_%d' % (var, rot)
            raw = os.path.join(B.RENDERS, name + '_raw.png')
            info = B.render_frame(var, rot, cfg['samples'], raw, scene=sc)
            report['frames'][name] = dict(info, variant=var, rotation=rot)
            print('RENDERED %s  объектов=%d треугольников=%d вершин=%d (%.3f юнита)'
                  % (name, info['objects'], info['tris'], info['verts'], info['size']))

    if cfg['export']:
        # выгружаем главный вариант (он же идёт в игру) и оставляем его в сцене
        SC.clear_own(sc)
        SC.setup(samples=16)
        S.build(B.MAIN)
        B.export_model(os.path.join(B.OUT, 'shovel_%s' % B.MAIN))
    if cfg['viewport']:
        ok = SC.viewport_camera()
        print('вьюпорт переведён в вид камеры: %s' % ok)

    with open(os.path.join(B.RENDERS, 'shovel_report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('shovel_report.json записан; кадров %d, время %.1f с'
          % (len(report['frames']), time.time() - t0))


if __name__ == '__main__':
    main()
