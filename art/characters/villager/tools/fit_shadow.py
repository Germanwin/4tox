"""fit_shadow.py — подбор пятна тени ЗАМЕРОМ, а не на глаз.

    $PY3 tools/fit_shadow.py --anim carry
    $PY3 tools/fit_shadow.py --anim walk_axe --frames 0,2,3,6,7
    $PY3 tools/fit_shadow.py --tag vgtest --frame idle_0_0     # один кадр

Сетка параметров -> композит -> замер гейтом -> выбор ближайшего к ядру канона.
Ядро (references/palette.json, shadow): ширина пятна / ширина силуэта 0.85..1.05,
h/w 0.13..0.22, пик α 0.30..0.80, p90 α 0.11..0.63. Пределы гейта шире:
0.70..2.00 и 0.04..0.40 — за них выходить нельзя вовсе.

ПОЧЕМУ ПО АНИМАЦИИ, А НЕ ПО КАДРУ. Пятно в атласе одно на анимацию
(compose.shadow_by_anim), а силуэт в разных кадрах и поворотах разной ширины:
у ходьбы с топором голова топора уходит вбок на 40 px, и пятно, подобранное по
одному кадру, на соседнем вылезает из канона (17 WARN из 256 — ровно этот
случай). Поэтому замер идёт по ВСЕМ кадрам и поворотам анимации, а выбирается
набор, у которого ХУДШИЙ кадр ближе всего к ядру.

Гнаться за «плоскостью» самого нарисованного эллипса не нужно: гейт мерит только
его часть НИЖЕ силуэта (4tox-lowpoly-3d/references/pitfalls.md, §1).
"""
import argparse
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILL = '/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d'
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(SKILL, 'scripts'))
import compose as C                                              # noqa: E402
import measure as SM                                             # noqa: E402

CORE = dict(w=(0.85, 1.05), hw=(0.13, 0.22), peak=(0.30, 0.80), p90=(0.11, 0.63))
LIMIT = dict(w=(0.70, 2.00), hw=(0.04, 0.40), peak=(0.25, 0.90), p90=(0.08, 0.70))
ROTS = (0, 45, 90, 135, 180, 225, 270, 315)
ANCHOR = (56, 106)


def measure(img):
    """Замер кадра тем же прибором, что и гейт (measure.report из скилла)."""
    r = SM.report(np.array(img.convert('RGBA')), ANCHOR, 'fit')
    return r.get('shadow')


def score(sh):
    """Насколько набор внутри канона: 0 — в ядре, дальше — сумма промахов.

    Ключи короткие, как в CORE/LIMIT (w = ширина пятна / ширина силуэта,
    hw = h/w), а замер measure.report отдаёт их же полными именами —
    переходник ниже, чтобы прибор и пороги не разошлись в названиях.
    """
    if not sh:
        return 9e9
    sh = dict(w=sh.get('w', sh.get('w_over_sil')),
              hw=sh.get('hw', sh.get('h_over_w')),
              peak=sh.get('peak', sh.get('max_alpha')),
              p90=sh.get('p90', sh.get('p90_alpha')))
    s = 0.0
    for key, (lo, hi) in CORE.items():
        v = sh[key]
        s += max(0.0, lo - v) * 20 + max(0.0, v - hi) * 20
    for key, (lo, hi) in LIMIT.items():
        v = sh[key]
        if v < lo or v > hi:
            # Выход за ПРЕДЕЛ гейта — не «чуть хуже ядра», а FAIL кадра: штраф
            # на два порядка больше. Иначе подбор советовал набор, который гейт
            # отвергает (для carry_put он выбрал a=16 при ширине/силуэте 0.69 —
            # ровно под порогом 0.70, и это стоило бы WARN на каждом кадре).
            s += (lo - v if v < lo else v - hi) * 10000
    s += abs(sh['w'] - 0.95)
    s += abs(sh['hw'] - 0.175) * 2
    return s


def frames_of(anim, only=None):
    import poses as PO
    n = PO.ANIMS[anim][1]
    return [int(v) for v in only.split(',')] if only else list(range(n))


def fit_anim(anim, only=None, grid=None, quiet=False):
    frames = frames_of(anim, only)
    best = []
    a_vals = grid[0] if grid else (14.0, 16.0, 18.0, 20.0, 22.0, 24.0, 26.0,
                                   28.0, 30.0, 34.0, 38.0, 44.0)
    for a, b, sy, alpha in itertools.product(a_vals, (4.5, 5.0, 5.5),
                                             (7.5,), (0.55,)):
        sh = dict(a=a, b=b, angle_deg=0.0, alpha=alpha, blur=1.6, shift=(2.0, sy))
        ratios, hws = [], []
        for fr in frames:
            for rot in ROTS:
                raw = os.path.join(C.ROOT, 'renders',
                                   'vg_%s_%d_%d_raw.png' % (anim, fr, rot))
                if not os.path.exists(raw):
                    continue
                img, _, _ = C.compose(raw, shadow=sh)
                m = measure(img)
                if not m:
                    ratios.append(0.0)
                    continue
                ratios.append(m['w_over_sil'])
                hws.append(m['h_over_w'])
        if not ratios:
            continue
        worst_lo, worst_hi = min(ratios), max(ratios)
        # худший кадр по КАЖДОМУ полю, а не средний: пятно одно на анимацию, и
        # вылезти из канона оно может ровно на одном повороте из восьми.
        s = max(score(dict(w=worst_lo, hw=min(hws), peak=alpha, p90=alpha * 0.98)),
                score(dict(w=worst_hi, hw=max(hws), peak=alpha, p90=alpha * 0.98)))
        best.append((s, sh, worst_lo, worst_hi, min(hws), max(hws)))
    best.sort(key=lambda x: x[0])
    if not quiet:
        print('анимация %s: кадров %d x поворотов %d'
              % (anim, len(frames), len(ROTS)))
        print('  счёт   a     b    α     ширина/силуэт      h/w')
        for s, sh, lo, hi, h0, h1 in best[:8]:
            print('  %6.3f %5.1f %4.1f %.2f   %.2f..%.2f   %.2f..%.2f'
                  % (s, sh['a'], sh['b'], sh['alpha'], lo, hi, h0, h1))
        s, sh, lo, hi, h0, h1 = best[0]
        print('  ЛУЧШИЙ: a=%g b=%g α=%.2f -> ширина/силуэт %.2f..%.2f (ядро 0.85..1.05), '
              'h/w %.2f..%.2f (ядро 0.13..0.22)' % (sh['a'], sh['b'], sh['alpha'],
                                                    lo, hi, h0, h1))
    return best[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--anim', default=None, help='fit_shadow по всем кадрам анимации')
    ap.add_argument('--frames', default=None)
    ap.add_argument('--tag', default='vgtest', help='режим одного кадра')
    ap.add_argument('--frame', default='idle_0_0')
    ap.add_argument('--out', default=os.path.join(ROOT, 'out', 'fit'))
    ap.add_argument('--json', default=None)
    args = ap.parse_args()

    if args.anim:
        best = fit_anim(args.anim, args.frames)
        if args.json:
            with open(args.json, 'w', encoding='utf-8') as f:
                json.dump(best[1], f, ensure_ascii=False, indent=1)
        return 0

    raw = os.path.join(C.ROOT, 'renders', '%s_%s_raw.png' % (args.tag, args.frame))
    if not os.path.exists(raw):
        print('нет рендера %s' % raw)
        return 1
    os.makedirs(args.out, exist_ok=True)
    best = []
    for a, b, sy, alpha in itertools.product((11.0, 13.0, 15.0, 17.0, 19.0),
                                             (3.5, 4.5, 5.5, 7.0),
                                             (0.0, 2.0, 4.0),
                                             (0.42, 0.55)):
        sh = dict(a=a, b=b, angle_deg=-30.0, alpha=alpha, blur=2.5, shift=(3.0, sy))
        png = os.path.join(args.out, 'sh_%g_%g_%g_%g.png' % (a, b, sy, alpha))
        img, _, _ = C.compose(raw, shadow=sh, save_path=png)
        m = measure(img)
        best.append((score(m), sh, m))
    best.sort(key=lambda x: x[0])
    print('лучшие 6 наборов (меньше — точнее в ядро канона):')
    for s, sh, m in best[:6]:
        print('  %.3f  a=%-4g b=%-4g sy=%-3g α=%.2f  ->  w/sil %.2f  h/w %.3f  '
              'пик %.2f  p90 %.2f' % (s, sh['a'], sh['b'], sh['shift'][1],
                                      sh['alpha'], m['w_over_sil'], m['h_over_w'],
                                      m['max_alpha'], m['p90_alpha']))
    s, sh, m = best[0]
    with open(os.path.join(args.out, 'shadow_best.json'), 'w', encoding='utf-8') as f:
        json.dump(sh, f, ensure_ascii=False, indent=1)
    print('лучший: %s' % json.dumps(sh, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
