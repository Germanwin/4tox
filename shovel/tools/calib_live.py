"""Калибровка палитры в ЖИВОЙ сессии Blender (MCP-сокет 9876).

    python3 tools/blmcp.py run tools/calib_live.py

Шаги те же, что у headless `tools/calib_render.py`, но:
  * работа идёт в отдельной сцене `shovel` (tools/scene.py) — сцена
    пользователя цела;
  * перед пробами палитра ПЕРЕСОБИРАЕТСЯ из свежего tools/palette_cal.json:
    калибровка итеративная, и второй проход должен видеть результат первого
    (иначе он решал бы ту же систему и не сходился).

После этого `python3 tools/calib_solve.py` считает новые базовые цвета.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import calib_render as CR
import scene as SC
import shovel as S

CONFIG = os.path.join(ROOT, 'live_config.json')
DEFAULTS = dict(variants=['a'], rotations=[0, 90, 180, 270], samples=16,
                reload=True)


def config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG) as f:
            data = json.load(f)
        cal = data.get('calib', {})
        cfg.update(cal)
    except Exception:
        pass
    if isinstance(cfg['variants'], str):
        cfg['variants'] = [v for v in cfg['variants'].split(',') if v]
    return cfg


def main():
    cfg = config()
    sc = SC.use_scene(fresh=False)
    # палитра — из свежего palette_cal.json: материалы и кэш модуля сносим
    SC.clear_own(sc)
    S.reset_palette()
    SC.drop_materials()
    if cfg['reload']:
        S.reload_calibration()
        print('палитра пересобрана из palette_cal.json')

    best = CR.collect_normals(tuple(cfg['variants']), tuple(cfg['rotations']),
                              scene=sc, samples=cfg['samples'])
    SC.clear_own(sc)
    SC.setup(samples=cfg['samples'])
    for var in cfg['variants']:
        for ob in S.build(var):
            print('%-16s (%s) тона: %s' % (ob.name, var, S.tone_census([ob])))
    probes = CR.render_probes(best, samples=cfg['samples'], scene=sc)
    CR.write_probes(probes, cfg['variants'])


if __name__ == '__main__':
    main()
