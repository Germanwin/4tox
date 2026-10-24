"""place_check.py — посадка основания в пятно: числа по четырём сторонам.

    $PY3 tools/place_check.py            # модель -> клетки карты
    $PY3 tools/place_check.py --json acc/place.json

Считает то, чего не видно на картинке:
  * основание (ВСЁ, что стоит на земле: цоколь, приступок, брёвна, солома) и
    его габарит по четырём сторонам в единицах модели;
  * ВИДИМЫЙ габарит — тот же, умноженный на крупность атласа `mul`: именно его
    видит игрок на карте (js/buildings.js::scaleAt);
  * зазор до каждой кромки пятна и смещение середины основания от середины
    пятна (по этому смещению игра и ставит спрайт — anchorShift);
  * выход цоколя за плоскость стен по четырём сторонам (канон дома: 0.06).

Почему отдельным инструментом, а не только гейтом: гейт приёмки (`gate.py`)
знает про пятно и зазор, но не знает про крупность `mul` — она живёт в атласе
игры.  Здесь то же самое считается в клетках карты, как это делает
`mapgen2/tools/place.js` для уже упакованных построек.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import house as HS                                                 # noqa: E402

# Канон посадки (mapgen2/js/buildings.js): пятно 2 x 3, зазор по длинной
# стороне BASE_MARGIN = 1/3 клетки, крупность siteMul(длинная сторона) =
# fitMul * MARGIN_K = 0.7778 * 0.92 = 0.7156.
SPOT = (2.0, 3.0)
MUL = 0.7156
GROUND_TOL = 0.02


def bbox(parts):
    xs = [v[0] for p in parts for v in p['verts']]
    ys = [v[1] for p in parts for v in p['verts']]
    zs = [v[2] for p in parts for v in p['verts']]
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))


def main():
    ap = argparse.ArgumentParser(description='посадка основания в пятно')
    ap.add_argument('--variant', default=None)
    ap.add_argument('--json', dest='json_out', default=None)
    args = ap.parse_args()

    parts = HS.build(args.variant)
    ground = [p for p in parts
              if min(v[2] for v in p['verts']) <= GROUND_TOL]
    (gx0, gx1), (gy0, gy1), _ = bbox(ground)
    (ax0, ax1), (ay0, ay1), _ = bbox(parts)
    walls = [p for p in parts
             if p['name'].startswith('wall_') or p['name'].startswith('gable_')]
    (wx0, wx1), (wy0, wy1), _ = bbox(walls)
    plinth = [p for p in ground if p['name'].startswith('plinth')]
    (px0, px1), (py0, py1), _ = bbox(plinth) if plinth else ((0, 0), (0, 0), (0, 0))

    base_x, base_y = gx1 - gx0, gy1 - gy0
    vis_x, vis_y = base_x * MUL, base_y * MUL
    spot_x, spot_y = SPOT
    gaps = dict(x_minus=gx0 + spot_x / 2.0, x_plus=spot_x / 2.0 - gx1,
                y_minus=gy0 + spot_y / 2.0, y_plus=spot_y / 2.0 - gy1)
    vis_gaps = {k: v * MUL for k, v in gaps.items()}
    mid = ((gx0 + gx1) / 2.0, (gy0 + gy1) / 2.0)
    over = dict(x_minus=wx0 - px0, x_plus=px1 - wx1,
                y_minus=wy0 - py0, y_plus=py1 - wy1)

    print('деталей %d, из них на земле %d' % (len(parts), len(ground)))
    print('пятно %.2f x %.2f клетки, крупность mul %.4f (siteMul(3))'
          % (spot_x, spot_y, MUL))
    print('основание (единицы модели)  %.3f x %.3f' % (base_x, base_y))
    print('   X %.3f..%.3f   Y %.3f..%.3f' % (gx0, gx1, gy0, gy1))
    print('основание на карте (x mul)  %.3f x %.3f клетки' % (vis_x, vis_y))
    print('зазор до кромок ОТ НАЧАЛА КООРДИНАТ, клетки (так модель стоит в .blend):')
    print('   X- %.3f  X+ %.3f  Y- %.3f  Y+ %.3f'
          % (gaps['x_minus'] * MUL, gaps['x_plus'] * MUL,
             gaps['y_minus'] * MUL, gaps['y_plus'] * MUL))
    # Игра ставит спрайт СЕРЕДИНОЙ наземного контура в середину пятна
    # (buildings.js::anchorShift), поэтому видимый зазор — это (пятно −
    # основание)/2, а не расстояние от начала координат модели.
    center_gap = ((spot_x - vis_x) / 2.0, (spot_y - vis_y) / 2.0)
    print('зазор ПОСЛЕ посадки по середине, клетки: X %.3f  Y %.3f'
          % center_gap)
    print('   канон по длинной стороне 0.307 (BASE_MARGIN * MARGIN_K);'
          ' у соседей по деревне 0.28 / 0.43')
    print('середина основания %.3f, %.3f (смещение %.3f)'
          % (mid[0], mid[1], max(abs(mid[0]), abs(mid[1]))))
    print('габарит модели с кровлей        %.3f x %.3f x %.3f'
          % (ax1 - ax0, ay1 - ay0, max(v[2] for p in parts for v in p['verts'])))
    print('цоколь за плоскость стен: X- %.3f  X+ %.3f  Y- %.3f  Y+ %.3f'
          % (over['x_minus'], over['x_plus'], over['y_minus'], over['y_plus']))
    print('   канон дома: выступ блока 0.06, у ратуши валуны 0.19..0.28')

    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, 'w', encoding='utf-8') as fh:
            json.dump(dict(parts=len(parts), ground=len(ground),
                           spot=list(SPOT), mul=MUL,
                           base=[round(base_x, 4), round(base_y, 4)],
                           base_box=[gx0, gx1, gy0, gy1],
                           visible=[round(vis_x, 4), round(vis_y, 4)],
                           gaps={k: round(v * MUL, 4) for k, v in gaps.items()},
                           centered_gaps=[round((spot_x - vis_x) / 2.0, 4),
                                          round((spot_y - vis_y) / 2.0, 4)],
                           center=[round(mid[0], 4), round(mid[1], 4)],
                           model=[round(ax1 - ax0, 4), round(ay1 - ay0, 4),
                                  round(max(v[2] for p in parts
                                            for v in p['verts']), 4)],
                           plinth_overhang={k: round(v, 4)
                                            for k, v in over.items()}),
                      fh, ensure_ascii=False, indent=1)
        print('-> %s' % args.json_out)


if __name__ == '__main__':
    main()
