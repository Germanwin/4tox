import os, sys, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_live as B
try:
    print('шаг 1: конфиг')
    cfg = B.config(); print('  ок, палитра', list(cfg['palette'])[:3])
    print('шаг 2: сцена')
    sc = B.BL.use_scene(cfg['scene']); print('  ок', sc.name)
    print('шаг 3: материалы')
    mats = B.make_materials(cfg); print('  ок', len(mats))
    print('шаг 4: setup')
    B.BL.setup(sc, cfg['prefix'], ppu=cfg['ppu'], res=cfg['res'], samples=8)
    print('  ок')
    print('шаг 5: геометрия')
    parts = B.HS.build(None); print('  ок, деталей', len(parts))
    print('шаг 6: объекты')
    objs = B.build_objects(parts, cfg, mats, sc); print('  ок, объектов', len(objs))
    print('шаг 7: рендер')
    B.BL.render_to(os.path.join(B.ROOT, 'renders', 'diag.png'), sc)
    print('  ок')
except Exception:
    print('ОШИБКА:')
    traceback.print_exc()
