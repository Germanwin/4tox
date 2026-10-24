"""make_specs.py — заморозить спеки `gate.py` для пяти руин.

    $PY3 tools/make_specs.py

`gate.py` (скилл `3d-model-acceptance`) принимает spec.json с порогами.  Здесь
пороги берутся из проекта, а не из результата:

    * cells     — пятно типа в клетках (4x3, 2x3, 3x3, 4x3, 5x5-площадка);
    * palette   — 12 красок ратуши + два угольных тона (ruin_palette.py);
    * plinth_overhang = null — печатать числа, порог не выдумывать (у ратуши
      валуны выходят за стены по канону);
    * class     — building для дома/ратуши/казармы, yard для лагеря лесоруба и
      военного лагеря (у них нет стен и цоколя — правила класса другие).

Порогов «под результат» здесь нет: если проверка падает — правится модель или
это записывается в отчёт как решение заказчика, а не как новый порог.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import ruin_palette as R                                       # noqa: E402

# тип -> (класс, пятно клеток, размер клетки в юнитах, комментарий)
RUINS = {
    'house': ('building', (2, 3), 1.0,
              'дом жителя: 2 x 3 клетки, стены и двускатная кровля обрушены'),
    'townhall': ('building', (4, 3), 1.0,
                 'ратуша: 4 x 3, щипец -X до 2.10, колокол упал'),
    'barracks': ('building', (4, 3), 1.0,
                 'казарма: 4 x 3, щипец -X до 2.04, знамя и стойка сломаны'),
    'lumbercamp': ('yard', (3, 3), 1.0,
                   'лагерь лесоруба: навес упал, столбы и двор сломаны'),
    'warcamp': ('yard', (5, 5), 1.2542,
                'военный лагерь: площадка 5 x 5, модель 2 x 2 (площадка = '
                'пятну, поэтому cells = 5 x 5, а модель внутри 2 x 2)'),
}


def main():
    palette = ['#%06X' % R.PAINT[z][0] for z in R.PAINT]
    for t, (cls, cells, cell_size, note) in RUINS.items():
        spec = {
            '_': 'СПЕК РУИНЫ «%s» для gate.py (3d-model-acceptance). Пороги '
                 'из проекта: пятно типа, палитра руин, класс. Провал не '
                 'перетолковывается — правится модель или пишется в отчёт.'
                 % t,
            '_model': note,
            'class': cls,
            'ground_z': 0.0,
            'ground_tol': 0.02,
            # margin = 0: модель меряется в СВОИХ юнитах, а зазор до кромки
            # делает игра множителем `mul` (rule 2026-10-13: спрайт поджимается
            # к опоре).  Ставить сюда 1/3 значило бы требовать, чтобы модель
            # была уже сжата, и C11 валил бы любую целую постройку.
            'cells': {'count': list(cells), 'size': cell_size,
                      'margin': 0.0},
            'palette': palette,
            'palette_space': 'raw',
            'palette_tol': 26,
            '_palette_note': '12 красок ратуши дословно + char/ash '
                             '(ruin_palette.py): единственные новые цвета, '
                             'оба тёмные.',
            'plinth_overhang': None,
            'max_coplanar_pairs': 0,
            'wall_re': '(wall|стен|gable|щипец|timber|каркас)',
            'door_re': '(door|gate|win|окн|двер|ворот|ставн)',
            'ignore_re': '^(rn_cam|rn_sun|light|camera|sun|key|fill|rim|'
                         'ground_plane)',
            '_budget_tris': [300, 1500],
        }
        path = os.path.join(ROOT, 'spec_%s.json' % t)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(spec, f, ensure_ascii=False, indent=1)
        print('записан %s' % path)


if __name__ == '__main__':
    main()
