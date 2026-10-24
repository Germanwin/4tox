"""logs_probe.py — замер ОХАПКИ БРЁВЕН и посадки кадра в клетку. Без Blender.

    $PY tools/logs_probe.py                      # carry, все 8 кадров
    $PY tools/logs_probe.py --anim carry --frames 0,3
    $PY tools/logs_probe.py --phase              # чем обоснована фаза нулевого кадра
    $PY tools/logs_probe.py --anim walk_axe      # топор в руке на ходу

Что здесь меряется, а не рассматривается:

  1. ОХАПКА НЕ В КОРПУСЕ. Для каждого бревна считается ЗНАКОВЫЙ зазор до
     шестиугольника рубахи (person.build_dress: N_DRESS = 6) на его высоте:
     плюс — снаружи, минус — провалилось внутрь. Тем же способом, что
     metrics.cloth_cover считает штаны против рубахи: «на глаз» бугор в 1 px не
     виден, а в спрайте это чёрная кромка.

  2. ОХАПКА НЕ В ВОЗДУХЕ. Зазор от низа нижних брёвен до ОСИ предплечья минус
     радиус предплечья: должен быть 0..0.004 — бревно ЛЕЖИТ на руке. Больше —
     висит, меньше — утоплено в руку.

  3. ОХАПКА НЕ В НОГАХ И НЕ В ПОДОЛЕ. Низ охапки против подола рубахи
     (person.SPEC HEM = 0.430) и против осей бедра/голени.

  4. КАДР ВЛЕЗАЕТ В КЛЕТКУ 112 x 132: над опорой 106 px, вбок по 56 px.
     Меряется по ВОСЬМИ поворотам атласа: охапка идёт поперёк корпуса, и на
     повороте 45/315 её дальний конец проецируется вбок сильнее всего.

  5. БРЁВЕН ЧЕТЫРЕ и они разной длины — число обязано совпадать с игрой
     (mapgen2/js/villager.js: LOGS_PER_TRIP = 4): охапка врёт про награду.

Плюс `--phase`: перебор фазы цикла для обоснования CARRY_PHASE. Игра
замораживает НУЛЕВОЙ кадр carry, когда житель сдаёт брёвна, поэтому кадр 0
обязан быть стойкой — обе подошвы на земле. Печатается max(z_л, z_п): у какой
фазы он минимален, та и есть двугогая опора.
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

CELL = (112.0, 132.0)
ANCHOR = (56.0, 106.0)
ROTS = (0, 45, 90, 135, 180, 225, 270, 315)


def _hex_pts(z, prof, sway=True):
    """Сечение рубахи на высоте z — те же точки, что строит person.build_dress."""
    rx, ry = H.dress_radius(z, prof)
    if sway:
        t = max(0.0, (H.SPEC['Z_WAIST'] - z) / (H.SPEC['Z_WAIST'] - H.SPEC['HEM']))
        cx, cy = SWAY[0] * t, SWAY[1] * t
    else:
        cx = cy = 0.0
    return G.ring(H.SPEC['N_DRESS'], z, rx, ry, cx=cx, cy=cy)


SWAY = (0.0, 0.0)           # подол в кадрах носки не уезжает (poses.carry: ±0.006)


def poly_margin(p, poly):
    """Знаковый зазор точки до выпуклого многоугольника: плюс — снаружи.

    Для выпуклого многоугольника расстояние до него есть max по рёбрам от
    (n_j · (p − a_j)): точка снаружи нарушает хотя бы одно полуплоскостное
    условие. Нормаль ребра для обхода против часовой — (e_y, −e_x).
    """
    best = -1e9
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i][0], poly[i][1]
        bx, by = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        ex, ey = bx - ax, by - ay
        L = math.hypot(ex, ey) or 1.0
        d = (ey * (p[0] - ax) - ex * (p[1] - ay)) / L
        if d > best:
            best = d
    return best


def _samples(part, extra=0.35):
    """Точки на поверхности детали: вершины, рёбра и СЕРЕДИНА фасетов.

    Середина обязательна. Бревно — длинная призма, и её боковина это один
    четырёхугольник на всю длину: по вершинам и рёбрам выборка стоит только на
    торцах, а середина (та, что ближе всего к руке) не измеряется вовсе. На
    этом замер уже один раз соврал: «предплечье 0.049» вместо касания.
    """
    out = [tuple(v) for v in part['verts']]
    for f in part['faces']:
        n = len(f)
        for k in range(n):
            a, b = part['verts'][f[k]], part['verts'][f[(k + 1) % n]]
            out.append(tuple(a[i] + (b[i] - a[i]) * extra for i in range(3)))
        if n == 4:
            a, b, c, d = (part['verts'][f[i]] for i in range(4))
            for u in (0.2, 0.4, 0.6, 0.8):
                for v in (0.2, 0.4, 0.6, 0.8):
                    p = [a[i] + (b[i] - a[i]) * u for i in range(3)]
                    q = [d[i] + (c[i] - d[i]) * u for i in range(3)]
                    out.append(tuple(p[i] + (q[i] - p[i]) * v for i in range(3)))
    return out


def _axis_gap(pts, Mx, r, length=None):
    """Зазор точек до поверхности трубы радиуса r вдоль кости Mx (локальный Z).

    Мерить по БЕСКОНЕЧНОЙ прямой нельзя, и это не придирка: продолжение голени
    вверх проходит ровно там, где лежит охапка, и замер выдавал «бревно в
    голени» (−0.024) на кадре, где охапка от колена в 0.25 юнита. Поэтому
    расстояние берётся до ОТРЕЗКА кости: параметр вдоль оси зажимается в
    [0, length] (длина берётся у самой кости, если не задана).
    """
    o = G.mat_apply(Mx, (0.0, 0.0, 0.0))
    d = G.mat_apply(Mx, (0.0, 0.0, 1.0))
    d = [d[i] - o[i] for i in range(3)]
    L = math.sqrt(sum(c * c for c in d)) or 1.0
    d = [c / L for c in d]
    if length is None:
        length = L
    worst = 1e9
    for p in pts:
        v = [p[i] - o[i] for i in range(3)]
        t = max(0.0, min(length, sum(v[i] * d[i] for i in range(3))))
        dist = math.sqrt(sum((v[i] - t * d[i]) ** 2 for i in range(3)))
        worst = min(worst, dist - r)
    return worst


# Длины костей для замера по отрезку (person.SPEC): продолжение кости за сустав
# к охапке отношения не имеет.
BONE_LEN = {'fore_': 0.202, 'uparm_': 0.155, 'thigh_': 0.230, 'shin_': 0.205}


def mat_inv_rigid(Mx):
    """Обратная к жёсткой матрице: поворот транспонируется, перенос — −Rᵗt."""
    R = [[Mx[i][j] for j in range(3)] for i in range(3)]
    t = [Mx[i][3] for i in range(3)]
    Rt = [[R[j][i] for j in range(3)] for i in range(3)]
    tt = [-sum(Rt[i][j] * t[j] for j in range(3)) for i in range(3)]
    return tuple(tuple(Rt[i]) + (tt[i],) for i in range(3)) + \
        ((0.0, 0.0, 0.0, 1.0),)


# Профиль предплечья из person.build_arm: (t вдоль кости, rx, ry). Радиус нужен
# свой на каждой длине: у запястья рука тоньше, у ладони шире, и «лежит ли
# бревно на руке» решается на КОНКРЕТНОМ t, а не «где-то у руки».
def fore_radius(p, t):
    L = p['FORE_L'] + p['HAND_L']
    prof = [(-0.030 / L, 0.025), (p['FORE_L'] / L * 0.55, 0.018),
            (p['FORE_L'] / L, 0.016), (p['FORE_L'] / L + 0.030 / L, 0.020),
            (1.0, 0.016)]
    b = p['BULK']
    if t <= prof[0][0]:
        return prof[0][1] * b
    for i in range(len(prof) - 1):
        t0, r0 = prof[i]
        t1, r1 = prof[i + 1]
        if t0 <= t <= t1:
            return (r0 + (r1 - r0) * (t - t0) / (t1 - t0)) * b
    return prof[-1][1] * b


def rest_gap(pts, Mx, p):
    """Зазор точек до ПОВЕРХНОСТИ предплечья в его собственной системе.

    Мерить расстояние до бесконечной оси мало: охапка сдвинута вдоль руки (к
    кисти), и «до оси» оно выходит большим даже когда бревно лежит на руке.
    Поэтому точки переводятся в систему предплечья, и зазор считается
    РАДИАЛЬНО, против радиуса трубы на этой длине: 0 — касание.
    """
    Mi = mat_inv_rigid(Mx)
    L = p['FORE_L'] + p['HAND_L']
    worst = 1e9
    for q in pts:
        v = G.mat_apply(Mi, q)
        t = v[2] / L
        if t < -0.15 or t > 1.05:
            continue                      # это уже за пределами руки
        r = fore_radius(p, max(0.0, min(1.0, t)))
        worst = min(worst, math.hypot(v[0], v[1]) - r)
    return worst


def probe(frames, anim='carry', variant='m'):
    prof = H.pose_of(variant=variant)['PROF']
    rows = []
    worst = dict(body=9.9, arm=(9.9, None), leg=9.9, box=None, low=9.9)
    for fr in frames:
        pose = PO.pose(anim, fr, variant)
        p = H.pose_of(variant=variant, **pose)
        Mk = H.skeleton(p)
        parts = H.ground_lock(H.build(variant=variant, pose=pose,
                                      **PO.props(anim)))
        logs = [q for q in parts if q['name'].startswith('log')]
        bark = [q for q in logs if q['family'] == H.LOG_FAMILY_BARK]
        ends = [q for q in logs if q['family'] == H.LOG_FAMILY_END]
        pts = [q for q in logs]
        # ground_lock сдвигает ВСЮ фигуру вниз-вверх, а скелет (Mk) остаётся в
        # своих координатах. Поэтому точки возвращаются в систему скелета тем же
        # сдвигом: иначе зазор до руки считается с ошибкой в этот сдвиг (та же
        # поправка в tools/axe_probe.py для кромки топора).
        gl = min(v[2] for q in parts if q['name'].startswith('boot')
                 for v in q['verts'])
        allp = [(v[0], v[1], v[2] - gl) for q in pts for v in _samples(q)]

        # 1. корпус: зазор до шестиугольника рубахи на своей высоте
        body = 9e9
        for v in allp:
            z = v[2]
            if not (H.SPEC['HEM'] <= z <= 0.775):
                continue
            body = min(body, poly_margin((v[0], v[1]), _hex_pts(z, prof)))
        # 2. руки: ЛЕЖИТ ли бревно на предплечье (радиальный зазор в системе
        # руки) и не задет ли локоть/плечо
        fore_gap = 9e9
        for s in ('l', 'r'):
            Mx = Mk['fore_' + s]
            if s == 'r':
                Mx = _mirror(Mx)
            fore_gap = min(fore_gap, rest_gap(allp, Mx, p))
        up_gap = 9e9
        for s in ('l', 'r'):
            Mx = Mk['uparm_' + s]
            if s == 'r':
                Mx = _mirror(Mx)
            up_gap = min(up_gap, _axis_gap(allp, Mx, 0.028 * p['BULK'],
                                           BONE_LEN['uparm_']))
        # 3. ноги: низ охапки против подола и против осей бедра/голени
        low = min(v[2] for v in allp) if allp else 9e9
        leg = min(abs(low - H.SPEC['HEM']),
                  min(min(_axis_gap(allp, Mk['thigh_' + s], 0.040 * p['BULK'],
                                    BONE_LEN['thigh_']),
                          _axis_gap(allp, Mk['shin_' + s], 0.032 * p['BULK'],
                                    BONE_LEN['shin_']))
                      for s in ('l', 'r'))) if allp else 9e9
        # 4. габарит кадра по восьми поворотам
        box = M._project_box(parts)
        rows.append(dict(frame=fr, body=body, fore=fore_gap, up=up_gap, leg=leg,
                         low=low, box=box,
                         tris=sum(sum(len(f) - 2 for f in q['faces']) for q in parts),
                         verts=sum(len(q['verts']) for q in parts),
                         lens=[round(G.size(q)[1], 3) if q['family'] == H.LOG_FAMILY_BARK
                               else None for q in bark],
                         n_log=len(bark), n_end=len(ends)))
        worst['body'] = min(worst['body'], body)
        worst['arm'] = min(worst['arm'], (fore_gap, fr))
        worst['leg'] = min(worst['leg'], leg)
        worst['low'] = min(worst['low'], low)
        b = box
        if worst['box'] is None:
            worst['box'] = list(b)
        else:
            worst['box'] = [max(worst['box'][0], b[0]), min(worst['box'][1], b[1]),
                            max(worst['box'][2], b[2]), min(worst['box'][3], b[3])]
    return rows, worst


def _mirror(Mx):
    """Правая сторона строится зеркалом (person.build: G.mirror_y)."""
    S = G.mat_scale((1.0, -1.0, 1.0))
    return G.mat_mul(G.mat_mul(S, Mx), S)


def phase_sweep(anim='carry', variant='m', step=15):
    """Перебор фазы цикла: где кадр 0 стоит на ДВУХ ногах."""
    out = []
    for ph in range(0, 360, step):
        old = PO.CARRY_PHASE
        PO.CARRY_PHASE = float(ph)
        try:
            pose = PO.pose(anim, 0, variant)
        finally:
            PO.CARRY_PHASE = old
        p = H.pose_of(variant=variant, **pose)
        parts = H.build(variant=variant, pose=pose, **PO.props(anim))
        z = {}
        for s in ('l', 'r'):
            b = [q for q in parts if q['name'] == 'boot_' + s][0]
            z[s] = min(v[2] for v in b['verts'])
        out.append((max(z['l'], z['r']), ph, z['l'], z['r']))
    out.sort()
    print('фаза  max(z_л,z_п)   z_л      z_п     (юниты; 0 = подошва на земле)')
    for mx, ph, zl, zr in out[:6]:
        print('%4d  %10.4f  %8.4f %8.4f' % (ph, mx, zl, zr))
    print('...')
    for mx, ph, zl, zr in out[-3:]:
        print('%4d  %10.4f  %8.4f %8.4f' % (ph, mx, zl, zr))
    print('лучшая фаза: %d (max %.4f юнита = %.1f px)'
          % (out[0][1], out[0][0], out[0][0] * 78.4))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--anim', default='carry')
    ap.add_argument('--frames', default=None)
    ap.add_argument('--variant', default='m')
    ap.add_argument('--phase', action='store_true')
    a = ap.parse_args()

    if a.phase:
        phase_sweep(a.anim, a.variant)
        return 0

    n = PO.ANIMS[a.anim][1]
    frames = [int(v) for v in a.frames.split(',')] if a.frames else list(range(n))
    rows, worst = probe(frames, a.anim, a.variant)
    props = PO.props(a.anim)

    if props.get('logs'):
        print('=== %s: охапка на месте? (%s) ===' % (a.anim, a.variant))
        print('кадр  бревён  корпус   предплечье  плечо    низ     зазор-низ  '
              'кадр: право лево верх низ')
        for r in rows:
            b = r['box']
            print('%4d %6d %9.4f %11.4f %8.4f %7.3f %9.4f   '
                  '%+6.1f %+6.1f %+6.1f %+6.1f'
                  % (r['frame'], r['n_log'], r['body'], r['fore'], r['up'], r['low'],
                     r['low'] - H.SPEC['HEM'], b[0], b[1], b[2], b[3]))
        r0 = rows[0]
        print('\nбревно: радиус %.3f юнита = %.1f px, длины %s'
              % (H.LOG_R, H.LOG_R * 2 * 96, r0['lens']))
        print('деталей охапки: %d брёвен + %d торцов; трис %d, вершин %d'
              % (r0['n_log'], r0['n_end'], r0['tris'], r0['verts']))
        print('корпус: худший зазор %.4f юнита = %.1f px (>0 — снаружи рубахи)'
              % (worst['body'], worst['body'] * 96))
        print('предплечье: худший зазор %.4f (кадр %s; 0..0.004 — лежит на руке)'
              % (worst['arm'][0], worst['arm'][1]))
        print('ноги/подол: худший зазор %.4f юнита = %.1f px'
              % (worst['leg'], worst['leg'] * 96))
    else:
        print('=== %s: кадр в клетке (%s) ===' % (a.anim, a.variant))
        print('кадр   трис  верт   кадр: право лево верх низ')
        for r in rows:
            b = r['box']
            print('%4d %6d %5d   %+6.1f %+6.1f %+6.1f %+6.1f'
                  % (r['frame'], r['tris'], r['verts'], b[0], b[1], b[2], b[3]))

    b = worst['box']
    print('\nклетка 112x132: верх %.1f px из %.0f, право %+.1f, лево %+.1f, низ %+.1f'
          % (b[3], ANCHOR[1], b[0], b[1], b[2]))
    print('  запас: вверх %.1f, вбок %.1f, вниз %.1f'
          % (ANCHOR[1] + b[3], ANCHOR[0] - max(b[0], -b[1]),
             CELL[1] - ANCHOR[1] + b[2]))

    if props.get('axe'):
        ax = M.axe_grip(a.variant, frames=tuple(frames), anim=a.anim)
        lo, hi = ax['grip'][0] / H.AXE_HANDLE[-1][0], ax['grip'][1] / H.AXE_HANDLE[-1][0]
        print('\nтопор в правой руке (та же приёмка, что у рубки):')
        print('  черенок ⊥ оси руки: отклонение от 90° %.4f°' % ax['angle'])
        print('  черенок в кулаке: расстояние %.4f, хват %.0f%%..%.0f%% рукояти'
              % (ax['fist'], lo * 100, hi * 100))
        print('  габарит с топором: верх %.1f px из %.0f, вбок %+.1f..%+.1f'
              % (-ax['box'][3], ANCHOR[1], ax['box'][1], ax['box'][0]))

    bad = M.check_normals(H.build(variant=a.variant, pose=PO.pose(a.anim, frames[0]),
                                  **PO.props(a.anim)))
    print('нормали (кадр %d): %s' % (frames[0], 'ок' if not bad else bad))
    return 0


if __name__ == '__main__':
    sys.exit(main())
