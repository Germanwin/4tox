"""run_gate.py — приёмка `gate.py` по СЦЕНЕ живого Blender (не по GLB).

    $PY tools/mcp.py run tools/build_live.py -- --config live_gate_build.json
    $PY tools/mcp.py run tools/run_gate.py

Почему по сцене: в сведённом в один меш экспорте теряются имена деталей, и
проверки «дверь в проёме», «цоколь против стен» уходят в WARN — на этом уже
сгорел прошлый прогон дома жителя (README утверждал «12 из 12», а дверь никто
не мерил).  Поэтому `build_live.py` умеет режим `gate`: деталь = объект.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = '/Users/hermmoment/.dsh/skills/3d-model-acceptance/scripts/gate.py'
sys.argv = ['blender', '--', '--live',
            '--spec', os.path.join(ROOT, 'spec.json'),
            '--out', os.path.join(ROOT, 'acc', 'report-barracks.json')]
os.makedirs(os.path.join(ROOT, 'acc'), exist_ok=True)
exec(open(GATE, encoding='utf-8').read())
