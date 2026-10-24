"""style_gate.py — стиль-гейт по ВСЕМ кадрам руин, с записью вывода.

    $PY3 tools/style_gate.py                 # 1x, 20 кадров
    $PY3 tools/style_gate.py --scale 4       # @4x, те кадры, что есть

Гоняет `4tox-lowpoly-3d/scripts/audit.py` на каждый кадр с его опорой из
`mapgen2/assets/ruins/atlas.json` и палитрой руин.  Пишет полный вывод в
`acc/style-gate-<scale>x.txt` (не усечённый) и печатает сводку.

Строка ТЕНЬ падает НАМЕРЕННО: у зданий этой игры тени нет с 2026-10-17, а гейт
её по-прежнему требует.  Поэтому «гейт пройден» здесь означает «нет FAIL кроме
ТЕНИ»; это записывается в сводку, а не прячется.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))
GAME = os.path.join(REPO, 'mapgen2')
AUDIT = os.path.expanduser(
    '~/.dsh/skills/4tox-lowpoly-3d/scripts/audit.py')
PY3 = sys.executable
ROTATIONS = (0, 90, 180, 270)
TYPES = ('townhall', 'house', 'lumbercamp', 'barracks', 'warcamp')


def tris_of(t):
    with open(os.path.join(ROOT, 'renders', 'rn_report.json'),
              encoding='utf-8') as f:
        rep = json.load(f)
    for k, v in rep['frames'].items():
        if k.startswith(t + '_'):
            return v['tris']
    return 500


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scale', type=int, default=1)
    ap.add_argument('--type', default=None)
    args = ap.parse_args()
    suffix = '@4x' if args.scale > 1 else ''
    ppu = 96 * args.scale
    with open(os.path.join(GAME, 'assets', 'ruins', 'atlas.json'),
              encoding='utf-8') as f:
        meta = json.load(f)
    acc = os.path.join(ROOT, 'acc')
    os.makedirs(acc, exist_ok=True)
    path = os.path.join(acc, 'style-gate-%dx.txt' % args.scale)
    types = [args.type] if args.type else list(TYPES)
    blocks, summary, fails, warns = [], [], 0, 0
    for t in types:
        for rot in ROTATIONS:
            name = '%s_%d' % (t, rot)
            png = os.path.join(ROOT, 'out', 'rn_%s%s.png' % (name, suffix))
            if not os.path.exists(png):
                continue
            fr = meta['frames'][name]
            ax = fr['anchorX'] * args.scale
            ay = fr['anchorY'] * args.scale
            cmd = [PY3, AUDIT, '--mine', png, '--kind', 'building',
                   '--ppu', str(ppu), '--palette',
                   os.path.join(HERE, 'ruin_palette.json'),
                   '--anchor', '%d,%d' % (ax, ay),
                   '--tris', str(tris_of(t))]
            r = subprocess.run(cmd, capture_output=True, text=True)
            out = r.stdout + r.stderr
            blocks.append('=== %s, %dx ===\n%s' % (name, args.scale, out))
            headline = [ln for ln in out.splitlines()
                        if ln.strip().startswith('ИТОГ')]
            head = headline[0].strip() if headline else 'ИТОГ: ?'
            fails += head.count('FAIL')
            warns += head.count('WARN')
            summary.append('%-16s %s' % (name, head))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(blocks) + '\n\n== СВОДКА ==\n'
                + '\n'.join(summary) + '\n')
    print('\n'.join(summary))
    print('\nвывод целиком: %s' % path)
    print('кадров %d; FAIL-строк в ИТОГах %d, WARN %d'
          % (len(summary), fails, warns))
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
