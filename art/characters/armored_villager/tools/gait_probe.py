"""gait_probe.py — замер ШАГА и СТОЙКИ по скелету. Чистый Python, без Blender.

    $PY tools/gait_probe.py                        # мужская ходьба, таблица + вердикт
    $PY tools/gait_probe.py --anim carry           # носка
    $PY tools/gait_probe.py --anim work            # рубка: ступни стоят (feet lock)
    $PY tools/gait_probe.py --anim idle --feet-lock  # ту же проверку — на любую позу

Зачем отдельный прибор. Глаз на спрайте 88 px не различает «нога ушла назад на
0.25 юнита» и «на 0.15»: в изометрии 45° движение вдоль +X проецируется ВНИЗ-
ВПРАВО, а не вбок, и шаг читается не смещением, а наклоном голени. Поэтому
ходьба меряется числом — положением ступни ОТНОСИТЕЛЬНО ТАЗА, — ровно как
форма меряется `metrics.py`.

Что печатается по кадрам:
    x_ст  — смещение ступни по +X (вперёд) от таза, в юнитах;
    z_ст  — насколько ступня ниже таза; опора — та, что ниже;
    кол   — сгиб колена, град.

Вердикт (код возврата 1, если не пройден):
    1. СИММЕТРИЯ — ступня уходит назад не дальше, чем в SIDE_TOL раз вперёд.
       Для ХОДЬБЫ порог свой и жёсткий (1.05): заказчик (2026-10-16) потребовал
       «ноги равномерно делают махи вперёд и назад на одинаковое расстояние»,
       то есть 1.00. Для НОСКИ порог прежний (1.30): у неё свои константы
       (poses.CARRY_*), и общее ужесточение уронило бы проверку не по делу.
    2. ФАЗА КОЛЕНА — пик сгиба приходится на ПЕРЕНОС, то есть на фазу, где
       бедро идёт вперёд. Сгиб на отведении назад отбрасывает ступню за таз.
    3. КЛИРЕНС — переносимая ступня поднимается над опорной не меньше 0.02
       юнита (1.6 px на 78.4 px/юн): ниже — она волочится по земле.
    4. РУКИ — обе кисти проходят одинаковый путь; «качается одна рука» — это
       разница больше 20%.
    5. НАКЛОН КОРПУСА (ходьба и ходьба с топором) — ПОСТОЯННАЯ составляющая
       угла линии «таз -> шея» равна нулю, допуск LEAN_TOL. Заказчик: «корпус
       не должен наклоняться вперёд... кажется, что центр тяжести где-то
       спереди». Наклон мерится по СКЕЛЕТУ, а не по силуэту: силуэт на 88 px
       не отличает 3° от нуля, а линия таз-шея — отличает.
    6. СТУПНИ СТОЯТ (feet lock, у `work` включается сам) — низ подошвы каждой
       ступни не сходит с места: смещение по X, Y и Z от кадра 0 не больше
       FEET_TOL, а размах середины подошвы — не больше FEET_SPREAD_TOL.
    7. СКОРОСТЬ БЕЗ ПРОСКАЛЬЗЫВАНИЯ — из шага опоры считается скорость, при
       которой ступня не едет по земле, и сверяется с SPEED из js/villager.js.
       Это и есть связь «анимация <-> игра»: если шаг изменили, а SPEED нет
       (или наоборот), проверка падает.
"""
import argparse
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import geom3d as G                                              # noqa: E402
import person as H                                              # noqa: E402
import poses as PO                                              # noqa: E402

TAU = 2.0 * math.pi
SIDE_TOL = 1.30          # во сколько раз назад дальше, чем вперёд — ещё шаг
SIDE_TOL_WALK = 1.05     # ходьба: требование заказчика — махи РАВНЫЕ (1.00)
KNEE_TOL = 0.0           # пик колена обязан лежать в фазе переноса
CLEAR_MIN = 0.02         # клиренс переносимой ступни, юнита (1.6 px)
ARM_TOL = 0.20           # разница пути кистей, доля
LEAN_TOL = 1.0           # постоянная составляющая наклона корпуса, град
FEET_TOL = 0.005         # «ступни стоят»: смещение подошвы от кадра 0, юнита
FEET_SPREAD_TOL = 1.0 / 78.4   # размах середины подошвы, 1 px в юнитах
SPEED_TOL = 0.03         # расхождение «шаг <-> SPEED игры», доля

# Наклон корпуса обязан быть нулевым у ходьбы. У носки он НЕ ноль по построению
# (poses.CARRY_LEAN = -3.5: вес тянет назад), у рубки наклон — это сам удар,
# поэтому там величина печатается, но не судится.
LEAN_ZERO = ('walk', 'walk_axe')

# Циклический шаг: у этих анимаций есть симметрия, фаза колена, клиренс и руки.
CYCLIC = ('walk', 'carry', 'walk_axe')

# Чей шаг откалиброван под SPEED игры. Носка короче по построению (CARRY_HIP_F
# = 9 против WALK_HIP_F), и её проскальзывание — известное расхождение, а не
# ошибка замера: оно печатается сведением, чтобы не потерялось.
SPEED_ANIMS = ('walk', 'walk_axe')

# Перевод «юниты модели -> клетки мира». 1 юнит модели = 78.4 px атласа
# (96 ppu, вертикаль сжата косинусом подъёма: 96·cos(35.264°) = 78.4), а
# 1 клетка мира = 96 px атласа при крупности mul = 1. Значит 1 юнит =
# 78.4·mul/96 клетки атласа. В игре всё это ещё делится на SHRINK
# (js/villager.js): человечек рисуется мельче крупности мира.
PX_PER_UNIT = 96.0 * math.cos(math.atan(1.0 / math.sqrt(2.0)))
MUL = 1.35               # крупность атласа жителя (pack_atlas.py: mul=1.35)
SHRINK = 2.2             # во сколько раз человечек мельче мира (js/villager.js)
CELL_PER_UNIT = PX_PER_UNIT * MUL / 96.0


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
        sole = {}
        for s in ('l', 'r'):
            b = [q for q in parts if q['name'] == 'boot_' + s][0]
            v = b['verts']
            lo = min(v, key=lambda q: q[2])                     # низ подошвы
            boot[s] = dict(z=lo[2], x=lo[0], xmin=min(q[0] for q in v),
                           xmax=max(q[0] for q in v))
            # Подошва целиком — для проверки «ступни стоят»: низ подошвы (та
            # точка, что касается земли), её середина по X и глубина по Y.
            sole[s] = dict(lo=lo,
                           cx=0.5 * (min(q[0] for q in v) + max(q[0] for q in v)),
                           cy=0.5 * (min(q[1] for q in v) + max(q[1] for q in v)))
        pel = G.mat_apply(M['pelvis'], (0.0, 0.0, 0.0))
        # Шея — точка отсчёта наклона: она выше груди, но ниже головы, поэтому
        # её не двигает ни head_pitch, ни head_turn (это поза головы, а не
        # корпуса). Линия «таз -> шея» и есть наклон корпуса.
        neck = G.mat_apply(M['neck'], (0.0, 0.0, 0.0))
        hip = {s: G.mat_apply(M['thigh_' + s], (0.0, 0.0, 0.0)) for s in ('l', 'r')}
        hand = {s: G.mat_apply(M['hand_' + s], (0.0, 0.0, 0.0)) for s in ('l', 'r')}
        rows.append(dict(
            # Фаза — ИЗ АНИМАЦИИ (poses.cycle_deg), а не «45° на кадр»: у носки
            # весь цикл сдвинут на CARRY_PHASE, и по индексу кадра фаза врёт.
            i=i, th=PO.cycle_deg(anim, i, n),
            boot=boot, sole=sole, pel=pel, neck=neck, hip=hip, hand=hand,
            knee={s: p['knee_' + s] for s in ('l', 'r')},
            hipa={s: p['hip_' + s] for s in ('l', 'r')},
            # ступня ОТНОСИТЕЛЬНО ТАЗА: центр подошвы, а не кость
            x={s: 0.5 * (boot[s]['xmin'] + boot[s]['xmax']) - pel[0] for s in ('l', 'r')},
            z={s: boot[s]['z'] for s in ('l', 'r')},
            # НАКЛОН КОРПУСА: угол линии «таз -> шея» от вертикали, в градусах.
            # Плюс — вперёд (шея впереди таза).
            lean=math.degrees(math.atan2(neck[0] - pel[0], neck[2] - pel[2])),
        ))
    return rows, n


def hip_forward_phase(th_deg, p=None, anim='walk'):
    """Идёт ли бедро вперёд на этой фазе. Производная A·sin+D·sin^2 по фазе.

    A и D берутся у СВОЕЙ анимации (poses.leg_cycle): у носки размах другой, и
    знак производной на той же фазе может отличаться от ходьбы.
    """
    c = PO.leg_cycle(anim)
    t = math.radians(th_deg)
    d = c['f'] * math.cos(t) + 2.0 * c['d'] * math.sin(t) * math.cos(t)
    return d > 0.0


def side_tol(anim):
    """Порог симметрии СВОЕЙ анимации: у ходьбы он жёсткий, у носки прежний."""
    return SIDE_TOL_WALK if anim in ('walk', 'walk_axe') else SIDE_TOL


def game_speed():
    """Скорость из js/villager.js — чтобы «шаг <-> скорость» проверялись вместе.

    Читается ИМЕННО исходник игры, а не копия числа в приборе: смысл проверки
    в том, чтобы расхождение анимации и игры ловилось, а не подтверждалось.

    Возвращает (SPEED в клетках мира/с, путь, SPEED_BOOST). Множителей в игре
    ДВА, и это не украшение (2026-10-16): SPEED_STEP — замер шага («ступня не
    едет»), SPEED_BOOST — правило заказчика «идти на 10% быстрее, не ускоряя
    анимации». Прибор обязан видеть оба: иначе намеренные 10% он примет за
    ошибку и уронит приёмку — или, наоборот, пропустит правку шага.
    """
    path = os.path.join(PROJECT, 'mapgen2', 'js', 'villager.js')
    try:
        with open(path, encoding='utf-8') as f:
            src = f.read()
    except OSError:
        return None, None, None
    step = re.search(r'var\s+SPEED_STEP\s*=\s*([0-9.]+)\s*;', src)
    boost = re.search(r'var\s+SPEED_BOOST\s*=\s*([0-9.]+)\s*;', src)
    if step and boost:
        b = float(boost.group(1))
        return float(step.group(1)) * b / SHRINK, path, b
    # Старая форма (одно число) — чтобы прибор не падал на прежнем файле.
    m = re.search(r'var\s+SPEED\s*=\s*([0-9.]+)\s*/\s*SHRINK\s*;', src)
    if not m:
        return None, path, None
    return float(m.group(1)) / SHRINK, path, 1.0


def stance_speed(rows, anim):
    """Скорость, при которой ступня НЕ ЕДЕТ по земле. Юниты/с и клетки мира/с.

    Считается по ЗЕМЛЕ, а не по кости: пока ступня стоит на земле, тело обязано
    уезжать ровно на столько, на сколько ступня уезжает назад ОТНОСИТЕЛЬНО ТАЗА.

    Мерит ОТРЕЗОК ОПОРЫ ЦЕЛИКОМ, а не пары соседних кадров, и это не придирка:
    ступня под тазом едет НЕравномерно (сразу после постановки быстрее, перед
    отрывом медленнее), поэтому среднее по парам кадров зависит от того, какие
    пары попали в выборку, — на этой же анимации оно давало 1.24 юн/с там, где
    целый отрезок даёт 1.37. Скорость тела — интеграл, а не среднее выборки:
    берётся ПУТЬ за отрезок, делённый на его длительность.
    """
    fps = PO.ANIMS[anim][2]
    sup = support_seq(rows)
    n = len(rows)
    if n < 2 or len(set(sup)) < 2:
        return None, []
    # Начала отрезков опоры (циклично): кадр, у которого опора отличается от
    # предыдущего. Отрезок — кадры c, c+1, ..., last; кадр `end` принадлежит уже
    # СЛЕДУЮЩЕЙ опоре, и брать его положение нельзя (на нём ступня уже оторвана
    # и ушла назад — замер от этого завышался на четверть).
    cuts = [i for i in range(n) if sup[i] != sup[i - 1]]
    per = []
    for k, c in enumerate(cuts):
        end = cuts[(k + 1) % len(cuts)]
        span = (end - c) % n or n            # сколько КАДРОВ длится опора
        if span < 2:
            continue
        last = (c + span - 1) % n
        s = sup[c]
        dx = rows[last]['x'][s] - rows[c]['x'][s]
        per.append(-dx * fps / (span - 1))
    if not per:
        return None, []
    return sum(per) / len(per), per


def support_seq(rows):
    """Какая нога стоит на земле в каждом кадре (опора — та, что ниже)."""
    return ''.join('l' if r['z']['l'] < r['z']['r'] else 'r' for r in rows)


def feet_lock(rows):
    """Ступни стоят? Смещение низа подошвы от кадра 0 и размах её середины.

    Мерится в МИРОВЫХ координатах (кадры уже прошли ground_lock), а не
    относительно таза: заказчик смотрит на кадр, а не на скелет. Смещение по Y
    мерится наравне с X и Z: в изометрии глубина тоже читается движением.
    """
    out = {}
    for s in ('l', 'r'):
        lo0 = rows[0]['sole'][s]['lo']
        out[s] = dict(
            dx=max(abs(r['sole'][s]['lo'][0] - lo0[0]) for r in rows),
            dy=max(abs(r['sole'][s]['lo'][1] - lo0[1]) for r in rows),
            dz=max(abs(r['sole'][s]['lo'][2] - lo0[2]) for r in rows),
            spread=max(r['sole'][s]['cx'] for r in rows) -
                   min(r['sole'][s]['cx'] for r in rows),
        )
    return out


def report(anim, variant='m', feet=None):
    rows, n = measure(anim, variant)
    gait = anim in CYCLIC
    # У рубки ноги стоят по контракту (poses.WORK_STANCE), поэтому проверка
    # включается сама: режим, который надо не забыть включить, — не приёмка.
    if feet is None:
        feet = (anim == 'work')
    xs = [r['x'][s] for r in rows for s in ('l', 'r')]
    fwd, back = max(xs), min(xs)
    ratio = abs(back) / max(fwd, 1e-9)

    print('=== %s (%s) — %d кадров ===' % (anim, 'мужская' if variant == 'm'
                                           else 'женская', n))
    print('кадр  фаза   нога   x_ст     z_ст    hip°   кол°   опора   наклон°')
    for r in rows:
        sup = 'l' if r['z']['l'] < r['z']['r'] else 'r'
        for s in ('l', 'r'):
            print('%4d %5d    %s   %+.3f  %+.3f  %+6.1f %6.1f   %s    %+5.2f' % (
                r['i'], r['th'], s, r['x'][s], -r['z'][s], r['hipa'][s],
                r['knee'][s], '<<' if s == sup else ' ', r['lean']))
    leans = [r['lean'] for r in rows]
    lean_mean = sum(leans) / len(leans)
    print('\nнаклон корпуса (линия таз -> шея): %+.2f° .. %+.2f°, постоянная %+.2f°'
          '  (вперёд +, порог %.1f°%s)'
          % (min(leans), max(leans), lean_mean, LEAN_TOL,
             '' if anim in LEAN_ZERO else ', здесь не судится'))
    if not gait:
        # Рубка и сдача — не цикл шага: симметрии, фазы колена и клиренса у них
        # нет и быть не должно. Судится только стойка (feet lock ниже).
        print('шаг не мерится: %s — не циклическая ходьба' % anim)

    clear = []
    sup_x = []
    for r in rows:
        sup = min(r['z']['l'], r['z']['r'])
        sw = max(r['z']['l'], r['z']['r'])
        clear.append(sw - sup)
        sup_x.append(r['x']['l'] if r['z']['l'] < r['z']['r'] else r['x']['r'])
    hx = {s: [r['hand'][s][0] for r in rows] for s in ('l', 'r')}
    path = {s: max(hx[s]) - min(hx[s]) for s in ('l', 'r')}

    ok = True
    if gait:
        print('шаг: вперёд %+.3f  назад %+.3f  (назад/вперёд = %.2f)  '
              'полный %.3f юн = %.1f px при 78.4 px/юн'
              % (fwd, back, ratio, fwd - back, (fwd - back) * 78.4))
        print('клиренс переносимой ступни: %s  (макс %.3f юн = %.1f px)'
              % (' '.join('%.3f' % c for c in clear), max(clear),
                 max(clear) * 78.4))
        # Опора по кадрам и ШАГ ОПОРЫ: сколько ступня проезжает под тазом, пока
        # стоит на земле. Это и есть длина шага — то, что читается в спрайте.
        print('опора по кадрам: %s' % support_seq(rows))
        print('шаг опоры: %+.3f .. %+.3f = %.3f юн = %.1f px'
              % (max(sup_x), min(sup_x), max(sup_x) - min(sup_x),
                 (max(sup_x) - min(sup_x)) * 78.4))
        print('путь кисти: левая %.3f  правая %.3f  (разница %.0f%%)'
              % (path['l'], path['r'],
                 100.0 * abs(path['l'] - path['r'])
                 / max(path['l'], path['r'], 1e-9)))
        print('кисти в противофазе: %s'
              % ('да' if _antiphase(hx['l'], hx['r']) else 'НЕТ'))
        print('колено: пик %s° на фазе %s; бедро там идёт %s'
              % (round(max(r['knee']['l'] for r in rows)),
                 round(rows[max(range(n), key=lambda k: rows[k]['knee']['l'])]['th']),
                 'вперёд' if hip_forward_phase(
                     rows[max(range(n), key=lambda k: rows[k]['knee']['l'])]['th'],
                     anim=anim)
                 else 'НАЗАД'))

        tol = side_tol(anim)
        if ratio > tol:
            print('FAIL СИММЕТРИЯ: ступня уходит назад в %.2f раза дальше, чем '
                  'вперёд (порог %.2f)' % (ratio, tol))
            ok = False
        kpeak = rows[max(range(n), key=lambda k: rows[k]['knee']['l'])]
        if not hip_forward_phase(kpeak['th'], anim=anim):
            print('FAIL ФАЗА КОЛЕНА: пик сгиба на фазе %d°, а бедро там идёт НАЗАД — '
                  'это отброс ступни за таз' % kpeak['th'])
            ok = False
        if max(clear) < CLEAR_MIN:
            print('FAIL КЛИРЕНС: %.3f юн < %.3f — ступня волочится'
                  % (max(clear), CLEAR_MIN))
            ok = False
        if abs(path['l'] - path['r']) / max(path['l'], path['r'], 1e-9) > ARM_TOL:
            print('FAIL РУКИ: путь кистей различается больше чем на %.0f%%'
                  % (ARM_TOL * 100))
            ok = False

    if anim in LEAN_ZERO:
        if abs(lean_mean) > LEAN_TOL:
            print('FAIL НАКЛОН: постоянная составляющая %+.2f° — корпус наклонён '
                  '%s (порог %.1f°)'
                  % (lean_mean, 'вперёд' if lean_mean > 0 else 'назад', LEAN_TOL))
            ok = False
        else:
            print('наклон корпуса: постоянная %+.2f° — в пределах порога %.1f°'
                  % (lean_mean, LEAN_TOL))

    if feet:
        fl = feet_lock(rows)
        print('\nСТУПНИ СТОЯТ (смещение от кадра 0 и размах середины подошвы):')
        for s in ('l', 'r'):
            d = fl[s]
            print('  %s: dx %.4f (%.2f px)  dy %.4f  dz %.4f (%.2f px)  '
                  'размах по X %.4f (%.2f px)'
                  % (s, d['dx'], d['dx'] * 78.4, d['dy'], d['dz'],
                     d['dz'] * 78.4, d['spread'], d['spread'] * 78.4))
        worst = max(max(fl[s]['dx'], fl[s]['dy'], fl[s]['dz']) for s in ('l', 'r'))
        spread = max(fl[s]['spread'] for s in ('l', 'r'))
        print('  худшее смещение подошвы %.4f юн = %.2f px (порог %.3f юн = %.2f px);'
              ' центры подошв %.4f юн = %.2f px (порог %.2f px)'
              % (worst, worst * 78.4, FEET_TOL, FEET_TOL * 78.4,
                 spread, spread * 78.4, FEET_SPREAD_TOL * 78.4))
        if worst > FEET_TOL:
            print('FAIL FEET LOCK: подошва сходит с места на %.4f юн = %.2f px '
                  '(порог %.3f юн)' % (worst, worst * 78.4, FEET_TOL))
            ok = False
        if spread > FEET_SPREAD_TOL:
            print('FAIL FEET LOCK: центр подошвы переступает на %.2f px (порог %.1f px)'
                  % (spread * 78.4, FEET_SPREAD_TOL * 78.4))
            ok = False

    if gait:
        v, per = stance_speed(rows, anim)
        speed, path_js, boost = game_speed()
        print('\nскорость без проскальзывания: ступня проезжает под тазом '
              '%s юн/с (по %d парам кадров)' % ('%.3f' % v if v else '—', len(per)))
        if v:
            atlas = v * CELL_PER_UNIT
            print('  = %.3f клетки атласа/с = %.3f клетки мира/с при SHRINK %.1f'
                  '  (1 юнит = %.3f клетки атласа: %.1f px x mul %.2f / 96)'
                  % (atlas, atlas / SHRINK, SHRINK, CELL_PER_UNIT,
                     PX_PER_UNIT, MUL))
        if speed is None:
            print('  SPEED игры: не прочитан (%s)' % (path_js or 'нет файла'))
        else:
            print('  SPEED игры (js/villager.js): %.3f клетки мира/с%s'
                  % (speed, '' if not boost or boost == 1.0 else
                     '  (из них множитель заказчика SPEED_BOOST %.2f — «быстрее '
                     'на %.0f%%, не ускоряя анимации»)' % (boost, (boost - 1) * 100)))
        if v and speed and anim in SPEED_ANIMS:
            mine = v * CELL_PER_UNIT / SHRINK
            # Сверяется РИСУНОК: игра обязана идти ровно во столько раз быстрее
            # замера, сколько сказано в SPEED_BOOST, — и ни в какое другое.
            want = mine * (boost or 1.0)
            dev = abs(want - speed) / speed
            if dev > SPEED_TOL:
                print('FAIL СКОРОСТЬ: замер шага даёт %.3f, множитель игры %.2f, '
                      'а игра идёт %.3f (расхождение %.0f%%, порог %.0f%%) — шаг '
                      'и скорость разъехались'
                      % (mine, boost or 1.0, speed, dev * 100, SPEED_TOL * 100))
                ok = False
            else:
                slip = (1.0 - 1.0 / (boost or 1.0)) * 100 if boost else 0.0
                print('  сходится: замер %.3f x множитель %.2f = %.3f против %.3f '
                      '(%.1f%%)%s'
                      % (mine, boost or 1.0, want, speed, dev * 100,
                         '' if not boost or boost == 1.0 else
                         ' — ступня проезжает %.0f%% (цена множителя названа '
                         'в js/villager.js)' % slip))
        elif v and speed:
            print('  СВЕДЕНИЕ: у %s шаг свой (poses.CARRY_*), под тот же SPEED '
                  'он даёт %.3f — под ношей ступня проезжает %.0f%%; это '
                  'известное расхождение, записано в README'
                  % (anim, v * CELL_PER_UNIT / SHRINK,
                     (1.0 - v * CELL_PER_UNIT / SHRINK / speed) * 100))

    print('\nИТОГ: %s' % ('ПРИНЯТО' if ok else 'НЕ ПРИНЯТО'))
    return ok


def _antiphase(a, b):
    """Кисти движутся навстречу: максимум одной против минимума другой."""
    ia = a.index(max(a))
    ib = b.index(min(b))
    return abs(ia - ib) <= 1 or abs(ia - ib) >= len(a) - 1


def main():
    ap = argparse.ArgumentParser(description='замер шага и стойки по скелету')
    ap.add_argument('--anim', default='walk')
    ap.add_argument('--variant', default='m')
    ap.add_argument('--feet-lock', dest='feet_lock', action='store_true',
                    default=None, help='проверять, что ступни стоят (у work — сам)')
    ap.add_argument('--no-feet-lock', dest='feet_lock', action='store_false',
                    default=None, help='не проверять стойку')
    a = ap.parse_args()
    return 0 if report(a.anim, a.variant, a.feet_lock) else 1


if __name__ == '__main__':
    sys.exit(main())
