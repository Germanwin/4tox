"""gait_probe.py — замер ШАГА по скелету. Чистый Python, без Blender.

    $PY tools/gait_probe.py            # мужская ходьба, таблица + вердикт
    $PY tools/gait_probe.py --anim work

Зачем отдельный прибор. Глаз на спрайте 88 px не различает «нога ушла назад на
0.25 юнита» и «на 0.15»: в изометрии 45° движение вдоль +X проецируется ВНИЗ-
ВПРАВО, а не вбок, и шаг читается не смещением, а наклоном голени. Поэтому
ходьба меряется числом — положением ступни ОТНОСИТЕЛЬНО ТАЗА, — ровно как
форма меряется `metrics.py`.

Что печатается по кадрам:
    x_ст  — смещение ступни по +X (вперёд) от таза, в юнитах;
    z_ст  — насколько ступня ниже таза; опора — та, что ниже;
    кол    — сгиб колена, град.

Вердикт (код возврата 1, если не пройден):
    1. СИММЕТРИЯ — ступня уходит назад не дальше, чем в 1.35 раза вперёд.
       Асимметрия в 2 раза и есть «ходьба задом наперёд».
    2. ФАЗА КОЛЕНА — пик сгиба приходится на ПЕРЕНОС, то есть на фазу, где
       бедро идёт вперёд. Сгиб на отведении назад отбрасывает ступню за таз.
    3. КЛИРЕНС — переносимая ступня поднимается над опорной не меньше 0.02
       юнита (1.5 px на 96 ppu): ниже — она волочится по земле.
    4. РУКИ — обе кисти проходят одинаковый путь; «качается одна рука» — это
       разница больше 20%.
"""
import argparse
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import geom3d as G                                              # noqa: E402
import person as H                                              # noqa: E402
import poses as PO                                              # noqa: E402

TAU = 2.0 * math.pi
SIDE_TOL = 1.30          # во сколько раз назад дальше, чем вперёд — ещё шаг
KNEE_TOL = 0.0           # пик колена обязан лежать в фазе переноса
CLEAR_MIN = 0.02         # клиренс переносимой ступни, юнита
ARM_TOL = 0.20           # разница пути кистей, доля


def _front(s):
    """Вперёд у модели — +X (js/hero.js: поворот 0 смотрит в +X)."""
    return s['x']


def measure(anim, variant='m', n=None):
    """Кадры анимации -> по каждой ноге: смещение ступни, опора, сгиб колена."""
    fn, n_anim, fps, loop = PO.ANIMS[anim]
    n = n or n_anim
    rows = []
    for i in range(n):
        p = H.pose_of(variant, **PO.pose(anim, i, variant))
        M = H.skeleton(p)
        parts = H.build(variant=variant, pose=PO.pose(anim, i, variant))
        boot = {}
        for s in ('l', 'r'):
            b = [q for q in parts if q['name'] == 'boot_' + s][0]
            v = b['verts']
            lo = min(v, key=lambda q: q[2])                     # низ подошвы
            boot[s] = dict(z=lo[2], x=lo[0], xmin=min(q[0] for q in v),
                           xmax=max(q[0] for q in v))
        pel = G.mat_apply(M['pelvis'], (0.0, 0.0, 0.0))
        hip = {s: G.mat_apply(M['thigh_' + s], (0.0, 0.0, 0.0)) for s in ('l', 'r')}
        hand = {s: G.mat_apply(M['hand_' + s], (0.0, 0.0, 0.0)) for s in ('l', 'r')}
        rows.append(dict(
            i=i, th=math.degrees(TAU * i / n),
            boot=boot, pel=pel, hip=hip, hand=hand,
            knee={s: p['knee_' + s] for s in ('l', 'r')},
            hipa={s: p['hip_' + s] for s in ('l', 'r')},
            # ступня ОТНОСИТЕЛЬНО ТАЗА: центр подошвы, а не кость
            x={s: 0.5 * (boot[s]['xmin'] + boot[s]['xmax']) - pel[0] for s in ('l', 'r')},
            z={s: boot[s]['z'] for s in ('l', 'r')},
        ))
    return rows, n


def hip_forward_phase(th_deg, p=None):
    """Идёт ли бедро вперёд на этой фазе. Производная A·sin+D·sin^2 по фазе."""
    t = math.radians(th_deg)
    d = PO.WALK_HIP_F * math.cos(t) + 2.0 * PO.WALK_HIP_D * math.sin(t) * math.cos(t)
    return d > 0.0


def report(anim, variant='m'):
    rows, n = measure(anim, variant)
    xs = [r['x'][s] for r in rows for s in ('l', 'r')]
    fwd, back = max(xs), min(xs)
    ratio = abs(back) / max(fwd, 1e-9)

    print('=== %s (%s) — %d кадров ===' % (anim, 'мужская' if variant == 'm'
                                           else 'женская', n))
    print('кадр  фаза   нога   x_ст     z_ст    hip°   кол°   опора')
    for r in rows:
        sup = 'l' if r['z']['l'] < r['z']['r'] else 'r'
        for s in ('l', 'r'):
            print('%4d %5d    %s   %+.3f  %+.3f  %+6.1f %6.1f   %s' % (
                r['i'], r['th'], s, r['x'][s], -r['z'][s], r['hipa'][s],
                r['knee'][s], '<<' if s == sup else ''))
    print('\nшаг: вперёд %+.3f  назад %+.3f  (назад/вперёд = %.2f)  '
          'полный %.3f юн = %.1f px при 78.4 px/юн'
          % (fwd, back, ratio, fwd - back, (fwd - back) * 78.4))

    clear = []
    for r in rows:
        sup = min(r['z']['l'], r['z']['r'])
        sw = max(r['z']['l'], r['z']['r'])
        clear.append(sw - sup)
    print('клиренс переносимой ступни: %s  (макс %.3f юн = %.1f px)'
          % (' '.join('%.3f' % c for c in clear), max(clear), max(clear) * 78.4))

    # Опора по кадрам и ШАГ ОПОРЫ: сколько ступня проезжает под тазом, пока
    # стоит на земле. Это и есть длина шага — то, что читается в спрайте.
    sup_seq = ''
    sup_x = []
    for r in rows:
        s = 'l' if r['z']['l'] < r['z']['r'] else 'r'
        sup_seq += s
        sup_x.append(r['x'][s])
    print('опора по кадрам: %s' % sup_seq)
    print('шаг опоры: %+.3f .. %+.3f = %.3f юн = %.1f px'
          % (max(sup_x), min(sup_x), max(sup_x) - min(sup_x),
             (max(sup_x) - min(sup_x)) * 78.4))

    hx = {s: [r['hand'][s][0] for r in rows] for s in ('l', 'r')}
    path = {s: max(hx[s]) - min(hx[s]) for s in ('l', 'r')}
    print('путь кисти: левая %.3f  правая %.3f  (разница %.0f%%)'
          % (path['l'], path['r'],
             100.0 * abs(path['l'] - path['r']) / max(path['l'], path['r'], 1e-9)))
    print('кисти в противофазе: %s' % ('да' if _antiphase(hx['l'], hx['r']) else 'НЕТ'))
    print('колено: пик %s° на фазе %s; бедро там идёт %s'
          % (round(max(r['knee']['l'] for r in rows)),
             round(rows[max(range(n), key=lambda k: rows[k]['knee']['l'])]['th']),
             'вперёд' if hip_forward_phase(
                 rows[max(range(n), key=lambda k: rows[k]['knee']['l'])]['th'])
             else 'НАЗАД'))

    ok = True
    if ratio > SIDE_TOL:
        print('FAIL СИММЕТРИЯ: ступня уходит назад в %.2f раза дальше, чем вперёд '
              '(порог %.2f)' % (ratio, SIDE_TOL))
        ok = False
    kpeak = rows[max(range(n), key=lambda k: rows[k]['knee']['l'])]
    if not hip_forward_phase(kpeak['th']):
        print('FAIL ФАЗА КОЛЕНА: пик сгиба на фазе %d°, а бедро там идёт НАЗАД — '
              'это отброс ступни за таз' % kpeak['th'])
        ok = False
    if max(clear) < CLEAR_MIN:
        print('FAIL КЛИРЕНС: %.3f юн < %.3f — ступня волочится' % (max(clear), CLEAR_MIN))
        ok = False
    if abs(path['l'] - path['r']) / max(path['l'], path['r'], 1e-9) > ARM_TOL:
        print('FAIL РУКИ: путь кистей различается больше чем на %.0f%%'
              % (ARM_TOL * 100))
        ok = False
    print('\nИТОГ: %s' % ('ПРИНЯТО' if ok else 'НЕ ПРИНЯТО'))
    return ok


def _antiphase(a, b):
    """Кисти движутся навстречу: максимум одной против минимума другой."""
    ia = a.index(max(a))
    ib = b.index(min(b))
    return abs(ia - ib) <= 1 or abs(ia - ib) >= len(a) - 1


def main():
    ap = argparse.ArgumentParser(description='замер шага по скелету')
    ap.add_argument('--anim', default='walk')
    ap.add_argument('--variant', default='m')
    a = ap.parse_args()
    return 0 if report(a.anim, a.variant) else 1


if __name__ == '__main__':
    sys.exit(main())
