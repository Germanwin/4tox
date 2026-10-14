"""axe_probe.py — замер ТОПОРА В КУЛАКЕ и посадки кадра в клетку. Без Blender.

    $PY tools/axe_probe.py                 # все 8 кадров рубки, 8 поворотов
    $PY tools/axe_probe.py --frames 3,4

Что здесь меряется, а не рассматривается:

  1. УГОЛ ЧЕРЕНКА К ОСИ РУКИ. Заказчик: «правильно расположенный, то есть под
     90 градусов относительно оси руки». Ось руки — направление предплечья
     (косточка fore_*), черенок — ось рукояти топора. Угол обязан быть 90.0° в
     КАЖДОМ кадре: топор жёстко посажен в систему кисти, и если поза начнёт
     крутить кисть (poses.work: hand_r), угол поедет.

  2. ЧЕРЁНОК ПРОХОДИТ ЧЕРЕЗ КУЛАК. Место хвата — кулак, а не локоть и не
     «где-то у руки»: расстояние от середины кулака до оси черенка и доля
     рукояти, на которой сидит кулак (0.1..0.35 — у комля, а не у головы).

  3. КАДР ВЛЕЗАЕТ В КЛЕТКУ 112 x 132. Клетка и опора общие с лесорубом, и
     вылезти из неё топором нельзя: у клетки 106 px над опорой. Проверяются все
     восемь поворотов атласа: рука с топором уходит вбок, и на повороте 315°
     она уходит вбок сильнее всего.

  4. ДОКУДА ДОСТАЁТ КРОМКА. Число нужно игре: житель встаёт на соседнюю с
     деревом клетку (1.0 юнита до ствола) и обязан ДОТЯНУТЬСЯ до ствола, а не
     махать топором в воздухе. Отсюда же берётся сдвиг stand-off в js/villager.js.
"""
import argparse
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import geom3d as G          # noqa: E402
import person as H          # noqa: E402
import poses as PO          # noqa: E402
import metrics as M         # noqa: E402

# Канонная камера игры (compose.py / scene.py): азимут 45°, подъём 35.2644°.
AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))
RIGHT = (math.cos(AZ), -math.sin(AZ), 0.0)
UP = (-math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))
CELL = (112.0, 132.0)
ANCHOR = (56.0, 106.0)
ROTS = (0, 45, 90, 135, 180, 225, 270, 315)
PPU = 96.0


def project(p, rot_deg):
    """Точка модели -> пиксели клетки (как compose.project, но с поворотом модели)."""
    a = math.radians(rot_deg)
    c, s = math.cos(a), math.sin(a)
    x = p[0] * c - p[1] * s
    y = p[0] * s + p[1] * c
    z = p[2]
    sx = x * RIGHT[0] + y * RIGHT[1]
    sy = x * UP[0] + y * UP[1] + z * UP[2]
    return sx * PPU + ANCHOR[0], ANCHOR[1] - sy * PPU


def part_dir(Mx, v=(0.0, 0.0, 1.0)):
    o = G.mat_apply(Mx, (0.0, 0.0, 0.0))
    p = G.mat_apply(Mx, v)
    d = [p[i] - o[i] for i in range(3)]
    n = math.sqrt(sum(c * c for c in d)) or 1.0
    return [c / n for c in d]


def angle(a, b):
    d = max(-1.0, min(1.0, sum(a[i] * b[i] for i in range(3))))
    return math.degrees(math.acos(d))


def point_line(p, o, d):
    """Расстояние от точки до прямой (o, d)."""
    v = [p[i] - o[i] for i in range(3)]
    t = sum(v[i] * d[i] for i in range(3))
    return math.sqrt(sum((v[i] - t * d[i]) ** 2 for i in range(3))), t


def probe(frames, variant='m'):
    rows = []
    worst = dict(angle=0.0, fist=0.0, grip=(9.9, -9.9), box=None, reach=0.0)
    for fr in frames:
        pose = PO.pose('work', fr, variant)
        p = H.pose_of(variant=variant, **pose)
        Mk = H.skeleton(p)
        parts = H.build(variant=variant, pose=pose, axe=True)
        parts = H.ground_lock(parts)
        dz = min(v[2] for q in parts if q['name'].startswith('boot')
                 for v in q['verts'])
        hand = Mk['hand_r']
        # кулак: середина кисти в системе кисти (person.AXE_FIST_Z)
        fist = G.mat_apply(hand, (0.0, 0.0, H.AXE_FIST_Z))
        fist = (fist[0], -fist[1], fist[2])          # правая сторона — зеркало
        arm_axis = part_dir(Mk['fore_r'])
        arm_axis = [arm_axis[0], -arm_axis[1], arm_axis[2]]
        # ось черенка в мире: рамка топора -> +Z топора это +X кисти
        axe = G.mat_chain(hand, G.mat_translate((0.0, 0.0, H.AXE_FIST_Z)),
                          ((0.0, 0.0, 1.0, 0.0), (1.0, 0.0, 0.0, 0.0),
                           (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0)),
                          G.mat_translate((0.0, 0.0, -H.AXE_GRIP)))
        butt = G.mat_apply(axe, (0.0, 0.0, 0.0))
        tip = G.mat_apply(axe, (0.0, 0.0, H.AXE_HANDLE[-1][0]))
        butt = (butt[0], -butt[1], butt[2])
        tip = (tip[0], -tip[1], tip[2])
        hd = [tip[i] - butt[i] for i in range(3)]
        L = math.sqrt(sum(c * c for c in hd))
        hd = [c / L for c in hd]
        dist, t = point_line(fist, butt, hd)
        a_deg = angle(hd, arm_axis)

        # кромка: станция головы с наибольшим y — передняя точка лезвия
        blade = G.mat_apply(axe, (0.0, H.AXE_HEAD[-1][0], H.AXE_HEAD[-1][3]))
        blade = (blade[0], -blade[1], blade[2] - dz)
        head_top = max((v[2] for q in parts for v in q['verts']), default=0.0)

        # габарит кадра по всем поворотам атласа
        box = None
        for rot in ROTS:
            pts = [project(v, rot) for q in parts for v in q['verts']]
            x0 = min(q[0] for q in pts) - ANCHOR[0]
            x1 = max(q[0] for q in pts) - ANCHOR[0]
            y0 = min(q[1] for q in pts) - ANCHOR[1]
            y1 = max(q[1] for q in pts) - ANCHOR[1]
            if box is None:
                box = [x1, x0, y1, y0, rot]
            else:
                box = [max(box[0], x1), min(box[1], x0),
                       max(box[2], y1), min(box[3], y0), box[4]]
        rows.append(dict(frame=fr, angle=a_deg, fist=dist, grip=t,
                         reach=blade[0], tip_z=blade[2], head_top=head_top,
                         box=box, parts=len(parts),
                         tris=sum(sum(len(f) - 2 for f in q['faces']) for q in parts),
                         verts=sum(len(q['verts']) for q in parts)))
        worst['angle'] = max(worst['angle'], abs(a_deg - 90.0))
        worst['fist'] = max(worst['fist'], dist)
        worst['grip'] = (min(worst['grip'][0], t), max(worst['grip'][1], t))
        worst['reach'] = max(worst['reach'], blade[0])
        if worst['box'] is None:
            worst['box'] = list(box)
        else:
            worst['box'] = [max(worst['box'][0], box[0]), min(worst['box'][1], box[1]),
                            max(worst['box'][2], box[2]), min(worst['box'][3], box[3]),
                            box[4]]
    return rows, worst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', default='0,1,2,3,4,5,6,7')
    ap.add_argument('--variant', default='m')
    a = ap.parse_args()
    frames = [int(v) for v in a.frames.split(',')]
    rows, worst = probe(frames, a.variant)

    print('кадр  угол(черенок,рука)  кулак: d  доля   кромка x   верх z   кадр: право лево верх низ')
    for r in rows:
        b = r['box']
        print('%4d %14.1f° %10.4f %5.2f %10.3f %8.3f   %+6.1f %+6.1f %+6.1f %+6.1f'
              % (r['frame'], r['angle'], r['fist'], r['grip'], r['reach'],
                 r['head_top'], b[0], b[1], b[2], b[3]))
    b = worst['box']
    print('\nтрис %d, вершин %d, деталей %d'
          % (rows[-1]['tris'], rows[-1]['verts'], rows[-1]['parts']))
    print('угол: худшее отклонение от 90° = %.4f°' % worst['angle'])
    print('кулак: худшее расстояние до оси черенка = %.4f юнита' % worst['fist'])
    print('хват: доля рукояти %.3f..%.3f (комель 0, голова %.3f)'
          % (worst['grip'][0], worst['grip'][1], H.AXE_HANDLE[-1][0]))
    print('клетка: право %+.1f лево %+.1f (до кромки %+.1f), верх %+.1f низ %+.1f'
          % (b[0], b[1], CELL[0] - ANCHOR[0] - b[0], b[2], b[3]))
    print('кромка впереди: до %.3f юнита от опоры (поворот %d)'
          % (worst['reach'], b[4]))
    bad = M.check_normals(H.build(variant=a.variant, pose=PO.pose('work', 4), axe=True))
    print('нормали (кадр удара): %s' % ('ок' if not bad else bad))
    return 0


if __name__ == '__main__':
    sys.exit(main())
