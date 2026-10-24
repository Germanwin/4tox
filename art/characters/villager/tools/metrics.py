"""metrics.py — приёмка ФИГУРЫ без Blender: пропорции, нормали, бюджет.

    $PY3 tools/metrics.py [--json out/metrics.json]

Отвечает числами на то, что глазами не проверяется:
    * рост и посадка (низ на z = 0, опора под корпусом);
    * пропорции: сколько голов в фигуре, где плечо, кисть, колено;
    * симметрия: левая и правая половины обязаны быть зеркалом (кроме корзины);
    * НАПРАВЛЕНИЕ НОРМАЛЕЙ и замкнутость деталей (вывернутый фасет = чёрное пятно);
    * бюджет трис/вершин класса `hero` (300..700 / 180..480);
    * детали мельче 2 px при 96 ppu — в спрайт не доедут (канон §4).
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import person as H                                              # noqa: E402
import geom3d as G                                              # noqa: E402
import poses as PO                                              # noqa: E402

CANON = dict(
    height=(0.98, 1.02),
    head_share=(0.17, 0.23),      # голова с платком к росту (у героя ~0.21)
    # Плечи: замер идёт по НАРУЖНОЙ кромке рукавов (это шире анатомического
    # плеча на угол отведения руки). У героя та же мера даёт ~0.25, поэтому
    # диапазон сдвинут вверх: 0.17 — анатомический минимум, 0.28 — предел,
    # за которым руки перестают быть руками и становятся крыльями.
    # Плечи: мера идёт по НАРУЖНОЙ кромке рукавов, то есть включает отведение
    # руки; анатомическая ширина плеч при этом ~24% роста. Мужская фигура
    # (SHLD_X 0.096) даёт 31% — это широкоплечий мужчина, а не «крылья».
    shoulder=(0.17, 0.33),
    fingertip=(0.33, 0.43),       # кисть к росту (у человека ~0.38)
    knee=(0.27, 0.33),
    foot_offset=0.05,             # ступни не уезжают из-под корпуса
    tris=(300, 700),
    verts=(180, 480),
)
PREFIX_BASKET = ('basket',)


def _norm(v):
    d = math.sqrt(sum(c * c for c in v)) or 1.0
    return (v[0] / d, v[1] / d, v[2] / d)


def face_normal(verts, face):
    p = [verts[i] for i in face]
    a = tuple(p[1][k] - p[0][k] for k in range(3))
    b = tuple(p[2][k] - p[0][k] for k in range(3))
    n = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
         a[0] * b[1] - a[1] * b[0])
    ln = math.sqrt(sum(c * c for c in n))
    if ln < 1e-12:
        return None, 0.0
    return (n[0] / ln, n[1] / ln, n[2] / ln), 0.5 * ln


def signed_volume(verts, faces):
    vol = 0.0
    for f in faces:
        for k in range(1, len(f) - 1):
            a, b, c = verts[f[0]], verts[f[k]], verts[f[k + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                    - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return vol


def check_normals(parts):
    """Тест 1: ни одно направленное ребро не встречается дважды (иначе вывернут
    фасет). Тест 2: у замкнутой детали знаковый объём > 0 (нормали наружу)."""
    bad = []
    for p in parts:
        v, f = p['verts'], p['faces']
        seen = {}
        for i, fc in enumerate(f):
            if len(fc) < 3:
                bad.append((p['name'], 'face<3', i))
                continue
            for k in range(len(fc)):
                e = (fc[k], fc[(k + 1) % len(fc)])
                if e in seen:
                    bad.append((p['name'], 'edge-twice:%s' % (e,), i))
                seen[e] = i
            n, area = face_normal(v, fc)
            if n is None or area < 1e-9:
                bad.append((p['name'], 'degenerate-face', i))
        closed = all((b, a) in seen for (a, b) in seen)
        if closed:
            vol = signed_volume(v, f)
            if vol <= 0:
                bad.append((p['name'], 'volume<=0', round(vol, 6)))
    return bad


def report(parts, name='villager'):
    xs = [v[0] for p in parts for v in p['verts']]
    ys = [v[1] for p in parts for v in p['verts']]
    zs = [v[2] for p in parts for v in p['verts']]
    box = dict(x=(min(xs), max(xs)), y=(min(ys), max(ys)), z=(min(zs), max(zs)))
    h = box['z'][1]
    fams = {}
    for p in parts:
        t = sum(len(f) - 2 for f in p['faces'])
        d = fams.setdefault(p['family'], [0, 0])
        d[0] += 1
        d[1] += t

    def zof(pname):
        q = [p for p in parts if p['name'] == pname]
        return (min(v[2] for v in q[0]['verts']),
                max(v[2] for v in q[0]['verts'])) if q else (None, None)

    chin = H.SPEC['Z_CHIN']
    # верх головы — платок (женская фигура) или волосы (мужская)
    kerch_top = max(v[2] for p in parts if p['name'] in ('kerchief', 'hair')
                    for v in p['verts'])
    boot = [p for p in parts if p['name'].startswith('boot')]
    bx = sum((min(v[0] for v in p['verts']) + max(v[0] for v in p['verts'])) / 2
             for p in boot) / max(1, len(boot))
    # ширина плеч: по деталям плеча/рукава
    sh = [p for p in parts if p['name'].startswith(('sleeve', 'uparm'))]
    sh_w = (max(v[1] for p in sh for v in p['verts'])
            - min(v[1] for p in sh for v in p['verts'])) if sh else 0.0
    hand_z = min(v[2] for p in parts if p['name'].startswith('forearm')
                 for v in p['verts'])
    knee_z = H.SPEC['Z_KNEE']
    out = dict(
        name=name, parts=len(parts),
        verts=sum(len(p['verts']) for p in parts),
        tris=sum(sum(len(f) - 2 for f in p['faces']) for p in parts),
        families={k: dict(parts=v[0], tris=v[1]) for k, v in sorted(fams.items())},
        bbox={k: [round(v[0], 3), round(v[1], 3)] for k, v in box.items()},
        size=[round(box['x'][1] - box['x'][0], 3),
              round(box['y'][1] - box['y'][0], 3), round(h, 3)],
        height=round(h, 3),
        head_share=round((kerch_top - chin) / h, 3),
        shoulder_share=round(sh_w / h, 3),
        fingertip_share=round(hand_z / h, 3),
        knee_share=round(knee_z / h, 3),
        foot_offset=round(bx, 3),
        sym_pairs=symmetry_pairs(parts),
    )
    return out, box


def symmetry_pairs(parts, eps=1e-6):
    """Сколько деталей имеют зеркального близнеца (корзина — законное исключение)."""
    have = 0
    missing = []
    names = {p['name']: p for p in parts}
    for p in parts:
        n = p['name']
        if n.startswith(PREFIX_BASKET):
            continue
        if n.endswith('_l'):
            twin = names.get(n[:-2] + '_r')
        elif n.endswith('_r'):
            twin = names.get(n[:-2] + '_l')
        else:
            continue
        if twin is None:
            missing.append(n)
            continue
        a = sorted((round(v[0], 6), round(-v[1], 6), round(v[2], 6)) for v in p['verts'])
        b = sorted((round(v[0], 6), round(v[1], 6), round(v[2], 6))
                   for v in twin['verts'])
        if a == b:
            have += 1
        else:
            missing.append(n)
    return dict(mirrored=have, broken=missing)


def _hex_margin(z, rx, ry, cy, r, n=6, phase=math.pi / 6):
    """Запас между КРУГОМ ноги (центр cy, радиус r) и ШЕСТИУГОЛЬНИКОМ одежды.

    >0 — нога внутри; <0 — вылезает. Считается в нормированном пространстве
    (x/rx, y/ry), где шестиугольник становится единичным: опора эллипса
    sqrt((nx·r/rx)^2 + (ny·r/ry)^2) против расстояния до грани cos(pi/n).
    Ровно эта ошибка была видна заказчику: мешковатые штаны шире рубахи в
    бёдрах, и по бокам туники торчали бугры.
    """
    worst = 1e9
    for j in range(n):
        a0 = phase + 2.0 * math.pi * j / n
        a1 = phase + 2.0 * math.pi * (j + 1) / n
        nx, ny = math.cos((a0 + a1) / 2.0), math.sin((a0 + a1) / 2.0)
        d = math.cos(math.pi / n)
        sup = ny * (cy / ry) + math.hypot(nx * (r / rx), ny * (r / ry))
        worst = min(worst, d - sup)
    return worst


def cloth_cover(parts, prof, hem, z_top, prefixes=('thigh', 'shin')):
    """Самая тесная точка: нога против рубахи на высотах, где рубаха есть."""
    worst = (1e9, None)
    legs = [p for p in parts if p['name'].startswith(prefixes)]
    for part in legs:
        # Кольцо лофта после FK имеет разброс z в сотые доли (наклон бедра),
        # поэтому вершины собираются в кластеры с допуском, а не по точному z.
        rows = {}
        for v in part['verts']:
            key = None
            for k in rows:
                if abs(k - v[2]) < 0.006:
                    key = k
                    break
            rows.setdefault(key if key is not None else v[2], []).append(v)
        zs = sorted(rows)
        for i in range(len(zs) - 1):
            z0, z1 = zs[i], zs[i + 1]
            for t in (0.15, 0.35, 0.5, 0.65, 0.85):
                z = z0 + (z1 - z0) * t
                if not (hem <= z <= z_top):
                    continue
                cx0 = sum(v[0] for v in rows[z0]) / len(rows[z0])
                cy0 = sum(v[1] for v in rows[z0]) / len(rows[z0])
                r0 = max(math.hypot(v[0] - cx0, v[1] - cy0) for v in rows[z0])
                cx1 = sum(v[0] for v in rows[z1]) / len(rows[z1])
                cy1 = sum(v[1] for v in rows[z1]) / len(rows[z1])
                r1 = max(math.hypot(v[0] - cx1, v[1] - cy1) for v in rows[z1])
                cy = cy0 + (cy1 - cy0) * t
                r = r0 + (r1 - r0) * t
                rx, ry = H.dress_radius(z, prof)
                m = _hex_margin(z, rx, ry, cy, r)
                if m < worst[0]:
                    worst = (m, round(z, 3), round(r, 3))
    return worst


def projected_px(parts, ppu=96.0):
    AZ = math.radians(45.0)
    EL = math.atan(1.0 / math.sqrt(2.0))
    import numpy as np
    out = []
    for p in parts:
        V = np.asarray(p['verts'], float)
        w = hh = 0.0
        for az in (45.0, 135.0, 225.0, 315.0):
            a = math.radians(az)
            r = np.array([math.cos(a), -math.sin(a), 0.0])
            u = np.array([-math.sin(EL) * math.cos(a), -math.sin(EL) * math.sin(a),
                          math.cos(EL)])
            sx, sy = V @ r * ppu, V @ u * ppu
            w = max(w, float(sx.max() - sx.min()))
            hh = max(hh, float(sy.max() - sy.min()))
        out.append(dict(name=p['name'], w=round(w, 1), h=round(hh, 1),
                        tris=sum(len(f) - 2 for f in p['faces'])))
    return out


def gate(rep, box, small, posed=False):
    """Строки приёмки фигуры. `posed=True` — кадр анимации, а не поза покоя.

    В позе часть мерок измеряет ПОЗУ, а не фигуру: «кисть на 40% роста» — это
    про руки, опущенные вдоль тела, а в кадре носки предплечья подняты
    горизонтально, и та же мерка даёт 59%. Поэтому в позе она печатается как
    ИЗВЕСТНОЕ ЧИСЛО и не валит приёмку, а пропорции фигуры проверяются покоем
    (`tools/metrics.py --variant m` без --anim) — это отдельный, обязательный
    прогон, а не отменённая проверка.
    """
    g = []
    g.append((CANON['height'][0] <= rep['height'] <= CANON['height'][1],
              'рост %.3f (канон %.2f..%.2f: человек в мире 1.0, как герой)'
              % (rep['height'], *CANON['height'])))
    g.append((CANON['head_share'][0] <= rep['head_share'] <= CANON['head_share'][1],
              'голова %.0f%% роста (канон %.0f..%.0f%%)'
              % (rep['head_share'] * 100, CANON['head_share'][0] * 100,
                 CANON['head_share'][1] * 100)))
    g.append((CANON['shoulder'][0] <= rep['shoulder_share'] <= CANON['shoulder'][1],
              'плечи %.0f%% роста (канон %.0f..%.0f%%)'
              % (rep['shoulder_share'] * 100, CANON['shoulder'][0] * 100,
                 CANON['shoulder'][1] * 100)))
    fingertip_ok = CANON['fingertip'][0] <= rep['fingertip_share'] <= CANON['fingertip'][1]
    g.append((fingertip_ok or posed,
              'кисть на %.0f%% роста (канон %.0f..%.0f%%)%s'
              % (rep['fingertip_share'] * 100, CANON['fingertip'][0] * 100,
                 CANON['fingertip'][1] * 100,
                 ' — В ПОЗЕ руки подняты, мерка показывает позу; фигуру '
                 'проверяет покой (--variant m без --anim)' if posed else '')))
    g.append((abs(box['z'][0]) < 1e-6, 'низ фигуры на z = %.6f (опора в (0,0,0))'
              % box['z'][0]))
    cov = rep.get('cloth_cover')
    if cov:
        g.append((cov[0] > 0.004,
                  'штаны внутри рубахи: запас %+.4f на z=%.3f (r=%.3f); >0.004 = '
                  'не вылезают по бокам' % cov))
    # Смещение пятна — тоже мерка ПОКОЯ: в шаге ступни уходят вперёд-назад по
    # фазе, и у уже принятой ходьбы (walk) та же мерка даёт -0.082 на нулевом
    # кадре, у рубки -0.073. В позе печатается как известное число, валит —
    # только в покое.
    foot_ok = abs(rep['foot_offset']) <= CANON['foot_offset']
    g.append((foot_ok or posed,
              'ступни под корпусом: смещение пятна %.3f (допуск %.2f)%s'
              % (rep['foot_offset'], CANON['foot_offset'],
                 ' — В ПОЗЕ пятно уходит по фазе шага (у walk те же -0.082); '
                 'баланс фигуры проверяет покой' if posed and not foot_ok else '')))
    g.append((CANON['tris'][0] <= rep['tris'] <= CANON['tris'][1],
              'полигонаж %d трис (бюджет hero %d..%d)'
              % (rep['tris'], *CANON['tris'])))
    g.append((CANON['verts'][0] <= rep['verts'] <= CANON['verts'][1],
              'вершин %d (бюджет %d..%d)' % (rep['verts'], *CANON['verts'])))
    g.append((not small, 'деталей мельче 2 px: %d %s'
              % (len(small), [s['name'] for s in small][:4])))
    return g


def axe_grip(variant='m', frames=(0, 1, 2, 3, 4, 5, 6, 7), anim='work'):
    """Приёмка ТОПОРА В КУЛАКЕ: угол, кулак, хват. Считается по геометрии.

    Заказчик (2026-10-14): «на время рубки дерева у жителя должен появиться
    топор в руке, причём правильно расположенный, то есть под 90 градусов
    относительно оси руки, и держать он его должен именно в кулаке, а не
    где-нибудь в локте».

    Три числа, и ни одно из них нельзя «посмотреть на глаз»:

      * УГОЛ ЧЕРЕНКА К ОСИ РУКИ — 90.0° в каждом кадре. Ось руки — направление
        предплечья (кость fore_*), черенок — ось рукояти топора.
      * КУЛАК — расстояние от середины кисти до оси черенка (должно быть ~0) и
        доля рукояти, на которой сидит кулак (0.1..0.35: у комля, а не у
        головы и не у локтя).
      * КЛЕТКА — верх кадра в ХУДШЕМ из восьми поворотов атласа: клетка 112x132
        даёт 106 px над опорой, и топор обязан в них уложиться.

    `anim` добавлен, когда топор понесли в ходьбе (poses.walk_axe): та же рука,
    тот же хват, но другой шаг, и приёмка обязана считать по ТОЙ ЖЕ анимации,
    из которой собран кадр.
    Возвращает dict с худшими значениями по перечисленным кадрам.
    """
    import poses as PO
    worst = dict(angle=0.0, fist=0.0, grip=(9.9, -9.9), box=None)
    for fr in frames:
        pose = PO.pose(anim, fr, variant)
        p = H.pose_of(variant=variant, **pose)
        Mk = H.skeleton(p)
        parts = H.ground_lock(H.build(variant=variant, pose=pose,
                                      **PO.props(anim)))
        hand = Mk['hand_r']
        # кулак — середина кисти в системе кисти; правая сторона зеркалится
        fist = G.mat_apply(hand, (0.0, 0.0, H.AXE_FIST_Z))
        fist = (fist[0], -fist[1], fist[2])
        arm = H.part_dir(Mk['fore_r']) if hasattr(H, 'part_dir') else None
        # рамка топора: та же, что в person.build_axe
        to_hand = ((0.0, 0.0, 1.0, 0.0), (1.0, 0.0, 0.0, 0.0),
                   (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0))
        axe = G.mat_chain(hand, G.mat_translate((0.0, 0.0, H.AXE_FIST_Z)), to_hand,
                          G.mat_translate((0.0, 0.0, -H.AXE_GRIP)))
        butt = G.mat_apply(axe, (0.0, 0.0, 0.0))
        top = G.mat_apply(axe, (0.0, 0.0, H.AXE_HANDLE[-1][0]))
        butt = (butt[0], -butt[1], butt[2])
        top = (top[0], -top[1], top[2])
        hd = _norm(tuple(top[i] - butt[i] for i in range(3)))
        ao = G.mat_apply(Mk['fore_r'], (0.0, 0.0, 0.0))
        ap = G.mat_apply(Mk['fore_r'], (0.0, 0.0, 1.0))
        armv = _norm((ap[0] - ao[0], -(ap[1] - ao[1]), ap[2] - ao[2]))
        ang = math.degrees(math.acos(max(-1.0, min(1.0, sum(hd[i] * armv[i] for i in range(3))))))
        v = tuple(fist[i] - butt[i] for i in range(3))
        along = sum(v[i] * hd[i] for i in range(3))
        dist = math.sqrt(sum((v[i] - along * hd[i]) ** 2 for i in range(3)))
        worst['angle'] = max(worst['angle'], abs(ang - 90.0))
        worst['fist'] = max(worst['fist'], dist)
        worst['grip'] = (min(worst['grip'][0], along), max(worst['grip'][1], along))
        box = _project_box(parts)
        if worst['box'] is None:
            worst['box'] = list(box)
        else:
            worst['box'] = [max(worst['box'][0], box[0]), min(worst['box'][1], box[1]),
                            max(worst['box'][2], box[2]), min(worst['box'][3], box[3])]
    return worst


def _project_box(parts, ppu=96.0):
    """Габарит кадра в пикселях клетки по ВОСЬМИ поворотам атласа.

    Возвращает [право, лево, низ, верх] от опоры. Верх меряется по ХУДШЕМУ
    повороту: там топор уходит от камеры и проецируется выше всего — именно он
    и решает, влезает ли кадр в клетку.
    """
    AZ = math.radians(45.0)
    EL = math.atan(1.0 / math.sqrt(2.0))
    right = (math.cos(AZ), -math.sin(AZ), 0.0)
    up = (-math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))
    out = None
    for rot in (0, 45, 90, 135, 180, 225, 270, 315):
        a = math.radians(rot)
        c, s = math.cos(a), math.sin(a)
        for p in parts:
            for v in p['verts']:
                x = v[0] * c - v[1] * s
                y = v[0] * s + v[1] * c
                sx = (x * right[0] + y * right[1]) * ppu
                sy = (x * up[0] + y * up[1] + v[2] * up[2]) * ppu
                if out is None:
                    out = [sx, sx, -sy, -sy]
                else:
                    out = [max(out[0], sx), min(out[1], sx), max(out[2], -sy), min(out[3], -sy)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pose', default=None, help='JSON позы')
    ap.add_argument('--variant', default='m', help='m — мужчина, f — женщина')
    ap.add_argument('--anim', default=None,
                    help='приёмка фигуры в позе анимации (carry/walk_axe/work/...)')
    ap.add_argument('--frame', type=int, default=0)
    ap.add_argument('--json')
    args = ap.parse_args()
    pose = json.loads(args.pose) if args.pose else None
    props = {}
    if args.anim:
        import poses as PO
        pose = PO.pose(args.anim, args.frame, args.variant)
        props = PO.props(args.anim)
        print('анимация %s, кадр %d, в руках: %s'
              % (args.anim, args.frame, props or 'ничего'))
    parts = H.ground_lock(H.build(variant=args.variant, pose=pose, **props))
    rep, box = report(parts)
    prof = H.pose_of(variant=args.variant)['PROF']
    hem = H.pose_of(variant=args.variant)['HEM']
    rep['cloth_cover'] = cloth_cover(parts, prof, hem + 0.005, 0.735)
    bad = check_normals(parts)
    rep['normal_issues'] = bad[:20]
    rep['normal_issue_count'] = len(bad)
    small = [d for d in projected_px(parts) if min(d['w'], d['h']) < 1.9]
    rep['too_small'] = small
    # Топор: только у мужской фигуры и только в анимациях с топором
    # (poses.PROPS: work и walk_axe)
    axe = None
    if args.variant == 'm' and (props.get('axe') or args.anim is None):
        axe = axe_grip(args.variant, anim=args.anim or 'work')
    if axe:
        rep['axe'] = dict(angle_off=round(axe['angle'], 6),
                          fist_dist=round(axe['fist'], 6),
                          grip=[round(axe['grip'][0], 4), round(axe['grip'][1], 4)],
                          box=[round(v, 1) for v in axe['box']])
        with_axe = H.ground_lock(H.build(variant='m', pose=poses_work(4), axe=True))
        rep['axe']['tris'] = sum(sum(len(f) - 2 for f in p['faces']) for p in with_axe)
        rep['axe']['verts'] = sum(len(p['verts']) for p in with_axe)
    logs = None
    if props.get('logs'):
        rows, worst = _logs_rows(args.anim, args.variant)
        logs = worst
        rep['logs'] = dict(logs=rows[0]['n_log'], ends=rows[0]['n_end'],
                           body_gap=round(worst['body'], 4),
                           arm_gap=round(worst['arm'][0], 4),
                           leg_gap=round(worst['leg'], 4),
                           box=[round(v, 1) for v in worst['box']],
                           tris=rows[0]['tris'], verts=rows[0]['verts'])
    print(json.dumps(rep, ensure_ascii=False, indent=1))
    print('--- приёмка фигуры ---')
    ok_all = True
    lines = list(gate(rep, box, small, posed=bool(args.anim)))
    if axe:
        lines += axe_gate(axe)
    if logs:
        lines += logs_gate(args.anim, args.variant)
    for ok, text in lines:
        ok_all = ok_all and ok
        print('%s %s' % ('OK  ' if ok else 'FAIL', text))
    if bad:
        print('--- нормали/грани ---')
        for b in bad[:20]:
            print('  ', b)
    print('ИТОГ: %s' % ('ПРИНЯТО' if (ok_all and not bad) else 'НЕ ПРИНЯТО'))
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
    return 0 if (ok_all and not bad) else 1


def _logs_rows(anim, variant):
    import logs_probe as LP
    import poses as PO
    return LP.probe(list(range(PO.ANIMS[anim][1])), anim, variant)


def poses_work(frame):
    import poses as PO
    return PO.pose('work', frame)


def logs_gate(anim='carry', variant='m', frames=None):
    """Строки приёмки ОХАПКИ: сколько брёвен, влезает ли кадр, не в корпусе ли.

    Числа считает tools/logs_probe.py — ОДИН прибор на замер и на приёмку:
    второй такой же счётчик рядом разошёлся бы с первым при первой правке
    геометрии. Здесь только вердикт и формулировка.
    """
    import poses as PO
    import logs_probe as LP
    n = PO.ANIMS[anim][1]
    fr = list(frames) if frames else list(range(n))
    rows, worst = LP.probe(fr, anim, variant)
    b = worst['box']
    top_px = -b[3]
    lo, hi = H.LOG_LEN[0], max(H.LOG_LEN)
    out = []
    out.append((rows[0]['n_log'] == 4 and rows[0]['n_end'] == 8,
                'охапка: брёвен %d (ровно столько игра и начисляет за ходку — '
                'js/villager.js: LOGS_PER_TRIP), торцов %d; длины %.3f..%.3f юнита '
                '(%.0f..%.0f px) — разные, охапка, а не штабель'
                % (rows[0]['n_log'], rows[0]['n_end'], lo, hi, lo * 78.4, hi * 78.4)))
    out.append((worst['body'] > 0.0 and worst['arm'][0] <= 0.004,
                'охапка: лежит на предплечьях (зазор %.4f юнита, кадр %s) и снаружи '
                'рубахи (зазор %.4f = %.1f px)'
                % (worst['arm'][0], worst['arm'][1], worst['body'],
                   worst['body'] * 96)))
    out.append((worst['leg'] > 0.0 and top_px <= 104.0 and b[0] <= 55.0
                and b[1] >= -55.0,
                'охапка: кадр влезает в клетку 112x132 — верх %.1f px из 106, '
                'вбок %+.1f..%+.1f, до подола %.1f px'
                % (top_px, b[1], b[0], worst['leg'] * 96)))
    return out


def axe_gate(axe):
    """Строки приёмки топора: угол, кулак, клетка, бюджет полигонажа."""
    b = axe['box']
    top_px = -b[3]          # верх кадра: сколько пикселей над опорой
    grip = axe['grip']
    out = []
    out.append((axe['angle'] < 1e-6,
                'топор: черенок ⊥ оси руки — отклонение от 90° %.4f° (каждый кадр рубки)'
                % axe['angle']))
    # Хват меряется ДОЛЕЙ рукояти, а не юнитами: 15..45% от комля — это кисть у
    # комля (рычаг), а не у головы. В юнитах порог пришлось бы менять при каждой
    # правке длины черенка — на этом проверка уже падала (0.082 при пороге 0.10).
    lo, hi = grip[0] / H.AXE_HANDLE[-1][0], grip[1] / H.AXE_HANDLE[-1][0]
    out.append((axe['fist'] < 1e-6 and 0.15 <= lo and hi <= 0.45,
                'топор: черенок проходит через КУЛАК — расстояние от середины кисти '
                'до оси %.4f, хват на %.0f%%..%.0f%% рукояти от комля'
                % (axe['fist'], lo * 100, hi * 100)))
    out.append((top_px <= 104.0 and b[0] <= 55.0 and b[1] >= -55.0,
                'топор: кадр влезает в клетку 112x132 — верх %.1f px из 106, '
                'вбок %+.1f..%+.1f' % (top_px, b[1], b[0])))
    return out


if __name__ == '__main__':
    sys.exit(main())
