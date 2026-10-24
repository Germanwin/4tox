"""run_gate.py — приёмка `gate.py` по СЦЕНЕ живого Blender (не по GLB).

    $PY tools/mcp.py run tools/build_live.py -- --config live_gate_build.json
    $PY tools/mcp.py run tools/run_gate.py

Почему по сцене: в сведённом в один меш объекте теряются имена деталей, и
проверки примыкания уходят в «не нашлось».  Поэтому `build_live.py` умеет
режим `gate`: деталь = объект.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = os.path.expanduser(
    '~/.dsh/skills/3d-model-acceptance/scripts/gate.py')
sys.argv = ['blender', '--', '--live',
            '--spec', os.path.join(ROOT, 'spec.json'),
            '--out', os.path.join(ROOT, 'acc', 'report-warcamp.json')]
os.makedirs(os.path.join(ROOT, 'acc'), exist_ok=True)
exec(open(GATE, encoding='utf-8').read())
