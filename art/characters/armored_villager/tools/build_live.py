"""build_live.py — сборка жительницы в УЖЕ ЗАПУЩЕННОМ Blender через MCP-сокет.

    PY=/Users/hermmoment/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
    $PY tools/blmcp.py run tools/build_live.py

Файл исполняется ВНУТРИ Blender (аддон blender-mcp, 127.0.0.1:9876), а не
запускает новый процесс:
    * работает в ОТДЕЛЬНОЙ сцене `villager` (tools/scene.py) — сцена заказчика
      остаётся нетронутой;
    * рендерит канонные кадры в renders/<тег>_<анимация>_<кадр>_<поворот>_raw.png;
    * по ходу работы переводит вьюпорт в вид камеры — фигуру видно сразу.

Настройки — live_config.json рядом с проектом:

    {"anims": "idle,walk,work", "frames": null, "rotations": [0, 90, 180, 270],
     "samples": 24, "ppu": 96, "res": [144, 192], "export": false,
     "save_blend": false, "viewport": true, "tag": "vg"}
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
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
sys.path.append(os.path.join(REPO, 'art', 'buildings', 'townhall', 'tools'))   # см. build.py: путь считается от корня репозитория

import bpy                                                      # noqa: E402

import build as B                                               # noqa: E402
import scene as SC                                              # noqa: E402
import palette as PAL                                           # noqa: E402
import poses as PO                                              # noqa: E402

CONFIG = os.path.join(ROOT, 'live_config.json')
DEFAULTS = dict(variant='k', anims='idle', frames=None, rotations=[0, 90, 180, 270],
                samples=24, ppu=96, res=[144, 192], export=False,
                save_blend=False, viewport=True, shot=None, tag='av', axe=None)


def _argv():
    """Аргументы после '--' (blmcp съедает разделитель сам)."""
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
    except Exception as e:
        print('конфиг %s не прочитан (%s) — беру умолчания' % (path, e))
    if isinstance(cfg['anims'], str):
        cfg['anims'] = [a for a in cfg['anims'].split(',') if a]
    if isinstance(cfg['rotations'], str):
        cfg['rotations'] = [int(r) for r in cfg['rotations'].split(',')]
    return cfg


def main():
    cfg = config()
    t0 = time.time()
    B.VARIANT = cfg.get('variant', 'm')
    B.PPU = float(cfg['ppu'])
    B.RES_X, B.RES_Y = [int(v) for v in cfg['res']]
    sc = SC.use_scene(fresh=bool(bpy.app.background))
    os.makedirs(B.RENDERS, exist_ok=True)
    os.makedirs(B.OUT, exist_ok=True)
    print('сцена сборки: %r (сцен в файле: %s)'
          % (sc.name, [s.name for s in bpy.data.scenes]))
    print('палитра: %d семейств, калибровка %s'
          % (len(PAL.FAMILIES),
             'есть' if B.calibration() else 'НЕТ (базовые цвета = цель)'))
    diffs = PAL.check()
    if diffs:
        print('ВНИМАНИЕ: палитра разошлась со скиллом: %s' % diffs)

    report = {'ppu': B.PPU, 'ortho': B.RES_Y / B.PPU, 'res': [B.RES_X, B.RES_Y],
              'tag': cfg['tag'], 'target_z': B.TARGET_Z,
              'el_deg': math.degrees(SC.EL), 'az_deg': math.degrees(SC.AZ),
              'sun': list(B.P.SUN_DIR), 'live': not bpy.app.background,
              'anims': {}, 'frames': {}}

    only = cfg.get('frames')
    for anim in cfg['anims']:
        fn, n, fps, loop = PO.ANIMS[anim]
        report['anims'][anim] = dict(frames=n, fps=fps, loop=loop)
        frames = only if only else list(range(n))
        for fr in frames:
            for rot in cfg['rotations']:
                name = '%s_%s_%d_%d' % (cfg['tag'], anim, fr, rot)
                raw = os.path.join(B.RENDERS, name + '_raw.png')
                info = B.render_frame(anim, fr, rot, cfg['samples'], raw,
                                      scene=sc, ppu=B.PPU, axe=cfg.get('axe'))
                report['frames'][name] = dict(info, anim=anim, frame=fr,
                                              rotation=rot)
                print('RENDERED %s  трис=%d верт=%d деталей=%d высота=%.3f (%.1f с)'
                      % (name, info['tris'], info['verts'], info['parts'],
                         info['size'], time.time() - t0))

    # ПОСЛЕ цикла кадров в сцене остаётся последний поворот (270°) — заказчик
    # видел спину. Возвращаем покой и поворот 0 ДО экспорта и сохранения копии:
    # тогда и .blend открывается лицом к камере, и вьюпорт показывает фигуру.
    if cfg.get('viewport') or cfg.get('save_blend'):
        SC.clear_own(sc)
        SC.setup(target=(0.0, 0.0, B.TARGET_Z), ppu=B.PPU, res=(B.RES_X, B.RES_Y),
                 samples=cfg['samples'])
        B.build_variant(B.VARIANT, None, name=B.OBJ_NAME)
        print('сцена оставлена в покое, поворот 0')

    if cfg['export']:
        B.export_model(os.path.join(B.OUT, 'armored_villager'), scene=sc, pose=None)
    if cfg['save_blend']:
        path = os.path.join(ROOT, 'armored_villager.blend')
        # ЧУЖОЙ ФАЙЛ НЕ СОХРАНЯЕМ: только копией
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=False,
                                    check_existing=False)
        print('СЦЕНА СОХРАНЕНА КОПИЕЙ %s' % path)
    if cfg['viewport']:
        print('вьюпорт в вид камеры: %s' % SC.viewport_camera())

    with open(os.path.join(B.RENDERS, '%s_report.json' % cfg['tag']), 'w',
              encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('%s_report.json записан; кадров %d, время %.1f с'
          % (cfg['tag'], len(report['frames']), time.time() - t0))


if __name__ == '__main__':
    main()
