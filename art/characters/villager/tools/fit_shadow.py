"""fit_shadow.py — подбор пятна тени ЗАМЕРОМ, а не на глаз.

    $PY3 tools/fit_shadow.py --tag vgtest --frame idle_0_0

Сетка параметров -> композит -> замер гейтом -> выбор ближайшего к ядру канона.
Ядро (references/palette.json, shadow): ширина пятна / ширина силуэта 0.85..1.05,
h/w 0.13..0.22, пик α 0.30..0.80, p90 α 0.11..0.63.

Гнаться за «плоскостью» самого нарисованного эллипса не нужно: гейт мерит только
его часть НИЖЕ силуэта (4tox-lowpoly-3d/references/pitfalls.md, §1).
"""
import argparse
import itertools
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILL = '/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d'
sys.path.insert(0, HERE)
import compose as C                                              # noqa: E402

AUDIT = os.path.join(SKILL, 'scripts', 'audit.py')
CORE = dict(w=(0.85, 1.05), hw=(0.13, 0.22), peak=(0.30, 0.80), p90=(0.11, 0.63))


def measure(png, anchor='56,106', tris=688, ppu=96):
    out = subprocess.run([sys.executable, AUDIT, '--mine', png, '--anchor', anchor,
                          '--kind', 'hero', '--tris', str(tris), '--ppu', str(ppu)],
                         capture_output=True, text=True).stdout
    m = re.search(r'ТЕНЬ\s+пятно ширина/силуэт ([\d.]+), h/w ([\d.]+), '
                  r'пик α ([\d.]+), p90 α ([\d.]+)', out)
    if not m:
        return None
    return dict(w=float(m.group(1)), hw=float(m.group(2)), peak=float(m.group(3)),
                p90=float(m.group(4)), raw=out)


def score(m):
    """Насколько замер внутри ядра канона: 0 — в ядре, иначе сумма промахов."""
    if not m:
        return 9e9
    s = 0.0
    for key, (lo, hi) in CORE.items():
        v = m[key]
        s += max(0.0, lo - v) * 10 + max(0.0, v - hi) * 10
    s += abs(m['w'] - 0.95) + abs(m['hw'] - 0.175) * 2
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', default='vgtest')
    ap.add_argument('--frame', default='idle_0_0')
    ap.add_argument('--out', default=os.path.join(ROOT, 'out', 'fit'))
    args = ap.parse_args()
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
        C.compose(raw, shadow=sh, save_path=png)
        m = measure(png)
        s = score(m)
        best.append((s, sh, m))
    best.sort(key=lambda x: x[0])
    print('лучшие 6 наборов (меньше — точнее в ядро канона):')
    for s, sh, m in best[:6]:
        print('  %.3f  a=%-4g b=%-4g sy=%-3g α=%.2f  ->  w/sil %.2f  h/w %.3f  '
              'пик %.2f  p90 %.2f' % (s, sh['a'], sh['b'], sh['shift'][1],
                                      sh['alpha'], m['w'], m['hw'], m['peak'],
                                      m['p90']))
    s, sh, m = best[0]
    with open(os.path.join(args.out, 'shadow_best.json'), 'w', encoding='utf-8') as f:
        json.dump(sh, f, ensure_ascii=False, indent=1)
    print('лучший: %s' % json.dumps(sh, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
