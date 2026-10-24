"""preview_live.py — показать КАДР АНИМАЦИИ во вьюпорте заказчика. Без рендера.

    $PY tools/blmcp.py run tools/preview_live.py --anim carry --frame 0 --rot 45

Зачем отдельно от build_live.py: тот рендерит кадры в файлы (это долго и
засоряет renders/), а посмотреть глазами надо быстро и часто — «а как охапка
села на повороте 45?». Здесь фигура собирается в сцене `villager`, вьюпорт
переводится в вид камеры, и НИ ОДИН файл не пишется: сцену заказчика скрипт не
трогает (scene.use_scene), свои объекты чистит по префиксу `vg_`.

Предметы в руках берутся из poses.PROPS по имени анимации — то же место, что у
сборки кадров: иначе в preview топор был бы там, где в атласе его нет.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
sys.path.append(os.path.join(REPO, 'art', 'buildings', 'townhall', 'tools'))   # см. build.py: путь считается от корня репозитория

import bpy                                                      # noqa: E402

import build as B                                               # noqa: E402
import scene as SC                                              # noqa: E402
import poses as PO                                              # noqa: E402


def _argv():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else (a[1:] if a else [])


def opt(name, default=None):
    a = _argv()
    if name in a:
        i = a.index(name)
        if i + 1 < len(a) and not a[i + 1].startswith('--'):
            return a[i + 1]
        return True
    return default


def main():
    anim = opt('--anim', 'carry')
    frame = int(opt('--frame', 0))
    rot = float(opt('--rot', 0))
    variant = opt('--variant', 'm')
    sc = SC.use_scene()
    SC.clear_own(sc)
    SC.setup(target=(0.0, 0.0, B.TARGET_Z), ppu=B.PPU, res=(B.RES_X, B.RES_Y),
             samples=16)
    pose = PO.pose(anim, frame, variant)
    name = 'vg_%s_%d_%d' % (anim, frame, int(rot))
    objs, parts = B.build_variant(variant, pose, name=name,
                                  **PO.props(anim))
    if rot:
        B.rotate_meshes(rot, sc)
        for o in objs:
            B.assign_tones(o)
    tris, verts = B.tris_verts(objs)
    print('во вьюпорте: %s — трис %d, вершин %d, деталей %d, рост %.3f'
          % (name, tris, verts, len(parts), B.world_size(objs)[2]))
    print('вьюпорт в вид камеры: %s' % SC.viewport_camera())
    return 0


if __name__ == '__main__':
    sys.exit(main())
