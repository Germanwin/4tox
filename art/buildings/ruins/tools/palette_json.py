"""palette_json.py — записать `ruin_palette.json` для стиль-гейта.

    $PY3 tools/palette_json.py

Таблица тонов считается из `ruin_palette.py` (а не пишется руками): гейт
меряет кадр, и единственный способ не разойтись — генерировать палитру тем же
кодом, которым красятся материалы.  Формат — как у `village_palette.json`
соседних проектов, поэтому `audit.py --palette tools/ruin_palette.json`
работает без правок инструмента.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ruin_palette as R                                      # noqa: E402


def main():
    data = {
        '_': ('ПАЛИТРА РУИН: краски ратуши + два угольных тона. Тона посчитаны '
              'той же формулой, что village_probe.py: sRGB(base * (SUN_K*c + '
              'SKY_K)), c = 0.9/0.6/0.3 (грань в небо / на солнце / в тень). '
              'Тень у зданий снята правилом 2026-10-17, поэтому строка ТЕНЬ '
              'стиль-гейта падает намеренно.'),
        'version': 1,
        'source': ('art/buildings/ruins/tools/ruin_palette.py '
                   '(краски: townhall/tools/townhall.py::palette(); '
                   'char/ash — новые тёмные)'),
        'probe': {
            'sun': [-0.36, 0.3, 0.88], 'sun_energy': 2.05,
            'ambient': [0.62, 0.66, 0.72], 'ambient_strength': 0.42,
            'ppu': 96.0, 'res': [512, 640], 'c': [0.3, 0.45, 0.6, 0.75, 0.9],
        },
        'outline': ['#0C100C', '#0D120D', '#0E130E', '#0B0F0B'],
        'shadow': {'w_over_sil': [0.7, 2.0], 'h_over_w': [0.04, 0.4],
                   'max_alpha': [0.25, 0.9], 'p90_alpha': [0.08, 0.7],
                   'rgb': '#000000'},
        'tones': {z: R.tones(z) for z in sorted(R.ZONES)},
        'budget': {'building': {'tris': [300, 1500], 'verts': [200, 800]}},
        'zones': {z: R.paint_name(z) for z in sorted(R.ZONES)},
    }
    path = os.path.join(HERE, 'ruin_palette.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    print('записан %s: зон %d' % (path, len(data['tones'])))
    for z in sorted(data['tones']):
        print('  %-8s -> %-8s %s' % (z, data['zones'][z], data['tones'][z]['mid']))


if __name__ == '__main__':
    main()
