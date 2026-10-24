"""run_gate.py — приёмка `gate.py` по СЦЕНЕ живого Blender, для одной руины.

    $PY tools/mcp.py run tools/build_live.py -- --types house --gate
    $PY tools/mcp.py run tools/run_gate.py -- --type house

Почему по сцене: `build_live.py --gate` собирает ДЕТАЛЬ = ОБЪЕКТ, и гейт
видит имена (`plinth_bx`, `wall_left_0`, `door_jamb_l`), а не один безымянный
меш.  По GLB проверки двери/стены уходят в «не нашлось».

Почему по одному типу: у типов разные пятна и разные классы (`building` /
`yard`), один spec на всех дал бы ложный C11.  Спеки — `spec_<тип>.json`
(`tools/make_specs.py`).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = os.path.expanduser(
    '~/.dsh/skills/3d-model-acceptance/scripts/gate.py')


def opt(name, default=None):
    a = sys.argv
    if name in a:
        i = a.index(name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


t = opt('--type', 'house')
spec = os.path.join(ROOT, 'spec_%s.json' % t)
if not os.path.exists(spec):
    raise SystemExit('нет %s — сначала tools/make_specs.py' % spec)
acc = os.path.join(ROOT, 'acc')
os.makedirs(acc, exist_ok=True)
out = os.path.join(acc, 'report-%s.json' % t)
sys.argv = ['blender', '--', '--live', '--spec', spec, '--out', out]
print('gate: тип %r, спек %s' % (t, os.path.basename(spec)))
exec(open(GATE, encoding='utf-8').read())
