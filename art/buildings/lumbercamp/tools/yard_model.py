"""yard_model.py — ГДЕ У ЛАГЕРЯ РАБОЧИЙ ДВОР, замером по модели.

    $PY3 tools/yard_model.py            # посчитать и показать
    $PY3 tools/yard_model.py --write    # посчитать и записать out/yard.json

Зачем отдельный замер. Двор лагеря — это не «клетка рядом с постройкой», а
КОНКРЕТНОЕ МЕСТО НА ЗЕМЛЕ, и оно задано моделью: слева козлы с бревном,
по центру два пня и брёвна, справа колода с топором и кадка, а по краю
частокол. Человек, вставший «где-то у лагеря», встанет либо в костёр, либо в
пень. Поэтому двор считается здесь, по геометрии `building.py`, одной командой,
и уезжает в атлас игры полем `yard` (пишет `tools/pack_lumbercamp.py`).

ЧТО СЧИТАЕТСЯ ДВОРОМ. Заказчик (2026-10-17): рабочий «должен прийти в сам
лагерь, заступив к нему на одну треть клетки — там есть свободное
пространство, где они могут стоять, взять топор или сложить брёвна». Значит
двор — это ПОЛОСА СВОБОДНОГО МЕСТА У ПЕРЕДНЕЙ КРОМКИ ПЯТНА, и мера у неё две:

    * ЛИНИЯ СТАНОВКИ: одна треть клетки внутрь от кромки пятна. Число
      названо заказчиком и здесь только превращается в координату
      (`STEP_IN = 1/3`) — оно же уезжает в атлас полем `step_in`, чтобы игра
      не помнила его сама;
    * МЕСТА СТАНОВКИ: свободные участки этой линии. «Свободно» — значит
      в радиусе `FOOT_R` от точки нет ни одной детали двора: ни ствола козел,
      ни пня, ни кадки, ни колоды, ни частокола. Радиус — это ступни
      человека, а не его спрайт: спрайт рисуется ПОВЕРХ лагеря (ключ глубины
      у рабочего больше, чем центр пятна), и мешать человеку может только то,
      во что он встал бы ногами.

КАК ЭТО МЕРЯЕТСЯ, А НЕ «НА ГЛАЗ». Каждая деталь модели проецируется на землю
и растрируется в сетке 0.02 клетки; точка линии становки свободна, если ни
одна деталь не ближе к ней, чем `FOOT_R`. Детали берутся по СВОЕМУ ПЯТНУ
КОНТАКТА С ЗЕМЛЁЙ, а не по всему габариту: у высокого колышка частокола на
земле стоит только его низ, и брать весь колышек значило бы запретить место
под его верхушкой.

ЧТО ЭТО ДАЛО НА САМОМ ДЕЛЕ (числа — из `--write`, они же в README):

    * линия становки — ровно 2.667 клетки от задней кромки пятна, то есть
      0.333 от передней (перед — `+Y` модели, см. `SPEC` и шапку `building.py`);
    * свободных мест на ней — три: слева от козел (у `x ~ 0.85`), между
      козлами и пнями (`x ~ 1.50`) и между пнями и колодой (`x ~ 2.20`).
      Между пнями и колодой стоят ещё и брёвна, поэтому третье место
      подвинуто вправо, к кадке.

ЧЕГО ЗДЕСЬ НЕТ. Здесь нет ни поиска пути, ни правил ходьбы, ни «магической
клетки»: это чистый замер геометрии. Поворот постройки учитывает игра
(`js/buildings.js`, `yardSpots`) — двор поворачивается вместе с лагерем.
"""
import argparse
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # сам проект
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))

SIDE = 3.0                # пятно 3 x 3: местные координаты идут 0..3
GRID = 0.02               # шаг сетки замера, клетки
GROUND_LOW = 0.30         # ниже этого деталь стоит «по колено и ниже» —
                          # берётся всё её пятно, а не только контакт
FOOT_R = 0.10             # радиус ступней: ближе этого деталь мешает встать
STEP_IN = 1.0 / 3.0       # на сколько заступить внутрь от кромки пятна
# Глубины, на которых ищутся свободные полосы у четырёх кромок. Треть клетки —
# рабочая: ровно на неё заступает рабочий. Остальные нужны, потому что замер
# идёт в осях модели, а поворот переносит их на карту, и «треть от кромки
# модели» — это не треть от кромки карты (разбор — в шапке sides()).
DEPTHS = (1.0 / 3.0, 0.5, 2.0 / 3.0, 0.95)
CELL_MARGIN = 0.06        # столько места оставляем до кромки клетки: рабочему
                          # нужна не точка, а место в клетке
N_SLOTS = 3               # столько рабочих мест в лагере (Buildings.workSlots)


def load_generator():
    """Модуль геометрии по пути: в живом Blender у соседей свои `building`."""
    path = os.path.join(HERE, 'building.py')
    spec = importlib.util.spec_from_file_location('lc_yard_building', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['lc_yard_building'] = mod
    spec.loader.exec_module(mod)
    return mod


# --------------------------------------------------------------------------
# Геометрия: что стоит на земле
# --------------------------------------------------------------------------
def convex_hull(pts):
    pts = sorted(set((round(a, 4), round(b, 4)) for a, b in pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def part_footprint(part):
    """Пятно детали на земле в местных координатах пятна (0..3).

    У детали, стоящей на земле (низ ниже GROUND_LOW), берётся ВСЁ её пятно:
    пень, кадка и поленница мешают ногам на всей своей площади. У высокой
    детали (столб, колышек частокола, нога козел) — только пятно контакта:
    её верхушка места не занимает.
    """
    verts = part['verts']
    lo = min(v[2] for v in verts)
    if lo <= GROUND_LOW:
        pts = [(v[0], v[1]) for v in verts]
    else:
        pts = [(v[0], v[1]) for v in verts if v[2] <= lo + 0.05]
    if not pts:
        return None
    return convex_hull(pts), lo


def triangles(poly):
    """Веер треугольников выпуклого контура — для точечной проверки «внутри»."""
    return [(poly[0], poly[i], poly[i + 1]) for i in range(1, len(poly) - 1)]


def inside_poly(poly, x, y):
    if len(poly) < 3:
        return False
    for a, b, c in triangles(poly):
        d1 = (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1])
        d2 = (x - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (y - c[1])
        d3 = (x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])
        neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        if not (neg and pos):
            return True
    return False


def dist_to_poly(poly, x, y):
    if inside_poly(poly, x, y):
        return 0.0
    best = 1e9
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best


def ground_polys(parts):
    """Пятна всех деталей на земле, уже в местных координатах пятна (0..3)."""
    out = []
    for p in parts:
        got = part_footprint(p)
        if not got:
            continue
        poly, lo = got
        if len(poly) < 3:
            continue
        moved = [(a + SIDE / 2.0, b + SIDE / 2.0) for a, b in poly]
        out.append((p['name'], moved, lo))
    return out


# --------------------------------------------------------------------------
# Линия становки и свободные места на ней
# --------------------------------------------------------------------------
def clearance(polys, x, y):
    """Расстояние до ближайшей детали двора (0 — точка внутри детали)."""
    return min(dist_to_poly(poly, x, y) for _, poly, _ in polys)


def free_intervals(polys, y, r, x0=0.0, x1=SIDE, step=GRID):
    """Свободные участки линии `y`: где расстояние до деталей больше `r`.

    Начало участка хранится числом, а не «истиной»: участок, начинающийся
    ровно с нуля, — такой же участок, и терять его нельзя (крайние места
    двора как раз и начинаются от кромки)."""
    out = []
    start = None
    n = int(round((x1 - x0) / step))
    for i in range(n + 1):
        x = x0 + i * step
        ok = clearance(polys, x, y) > r
        if ok:
            if start is None:
                start = x
        elif start is not None:
            out.append((round(start, 3), round(x - step, 3)))
            start = None
    if start is not None:
        out.append((round(start, 3), round(x1, 3)))
    # Участок короче шага сетки — это не место, а погрешность замера.
    return [(a, b) for a, b in out if b - a >= step - 1e-9]


def best_point(polys, a, b, y):
    """Самая просторная точка участка: середина, сдвинутая к его простору."""
    best, bx = -1.0, (a + b) / 2.0
    n = max(2, int(round((b - a) / GRID)))
    for i in range(n + 1):
        x = a + (b - a) * i / n
        c = clearance(polys, x, y)
        if c > best:
            best, bx = c, x
    return round(bx, 3), round(best, 3)


def yard(parts, n_slots=N_SLOTS, foot_r=FOOT_R, step_in=STEP_IN):
    """Двор лагеря: места становки — ПО ОДНОМУ НА КЛЕТКУ передней полосы.

    Возвращает словарь, который уезжает в атлас полем `yard`:

        step_in — на сколько заступить внутрь от кромки пятна (клетки);
        slots   — места становки в местных координатах пятна: `u` вдоль
                  передней кромки (0..3), `v` — глубина от ЗАДНЕЙ кромки,
                  то есть `v = SIDE - step_in` для всех мест;
        clear   — простор до ближайшей детали двора в каждом месте, клетки.

    ПОЧЕМУ ПО ОДНОМУ НА КЛЕТКУ, а не «сколько влезет на линии». Место двора —
    это КЛЕТКА карты: трое рабочих должны стоять в трёх РАЗНЫХ клетках (это
    правило заказчика и прямая проверка приёмки). А свободная полоса у кромки
    бывает шире клетки — у лагеря она идёт и через левую клетку, и через
    среднюю, — и «два места в одной клетке» поставили бы двоих в одну клетку.
    Поэтому клетка передней полосы либо даёт одно место, либо не даёт его
    вовсе; место ставится в САМУЮ ПРОСТОРНУЮ точку своей клетки.
    """
    polys = ground_polys(parts)
    v = SIDE - step_in
    ivs = free_intervals(polys, v, foot_r)

    slots, clr = [], []
    for k in range(int(round(SIDE))):
        lo, hi = k + CELL_MARGIN, k + 1 - CELL_MARGIN
        seg = []
        for a, b in ivs:                      # свободные участки В ЭТОЙ клетке
            if b < lo or a > hi:
                continue
            seg.append((max(a, lo), min(b, hi)))
        if not seg:
            continue                          # клетка занята: места нет
        cand = []
        for a, b in seg:
            x, c = best_point(polys, a, b, v)
            cand.append((c, x))
        c, x = max(cand)
        slots.append({'u': round(x, 3), 'v': round(v, 4)})
        clr.append(round(c, 3))
    if len(slots) > n_slots:                  # мест больше, чем рабочих
        order = sorted(range(len(slots)), key=lambda i: -clr[i])[:n_slots]
        order.sort()
        slots = [slots[i] for i in order]
        clr = [clr[i] for i in order]
    return {
        'step_in': round(step_in, 4),
        'foot_r': foot_r,
        'side': SIDE,
        'slots': [{'u': s['u'], 'v': s['v']} for s in slots],
        'clear': clr,
        'line_y': round(v, 4),
        'free': [[round(a, 3), round(b, 3)] for a, b in ivs],
        'sides': sides(polys, step_in, foot_r),
        'want_slots': n_slots,
    }


# Четыре кромки пятна и как из «вдоль кромки + глубина» получить местные
# координаты (u — по X модели, v — по Y от ЗАДНЕЙ кромки):
#
#     front: u = t,         v = SIDE - s     (перед, там же колода с топором)
#     right: u = SIDE - s,  v = t
#     back:  u = SIDE - t,  v = s            (там поленница и навес)
#     left:  u = s,         v = SIDE - t
#
# Глубина s везде меряется ОТ СВОЕЙ кромки, поэтому «заступить на треть клетки»
# — это s = step_in на любой из четырёх сторон.
SIDES = ('front', 'right', 'back', 'left')


def side_uv(side, t, s):
    if side == 'front':
        return t, SIDE - s
    if side == 'right':
        return SIDE - s, t
    if side == 'back':
        return SIDE - t, s
    return s, SIDE - t


def side_ts(side, u, v):
    if side == 'front':
        return u, SIDE - v
    if side == 'right':
        return v, SIDE - u
    if side == 'back':
        return SIDE - u, v
    return SIDE - v, u


def sides(polys, step_in=STEP_IN, foot_r=FOOT_R):
    # Свободные места у ВСЕХ ЧЕТЫРЁХ кромок пятна, на НЕСКОЛЬКИХ глубинах.
    #
    # Заказчик (2026-10-16): жители идут к БЛИЖАЙШЕЙ границе площади лагеря, а
    # не к передней. Значит недостаточно померить одну полосу у одной кромки:
    # рабочему, срубившему дерево у задней стены, два шага до задней кромки, и
    # класть брёвна он должен там.
    #
    # Почему несколько глубин, а не одна `step_in`. Замер ведётся в осях МОДЕЛИ,
    # а поворот переносит их на карту: у повёрнутого лагеря «перед» модели
    # смотрит вправо, и точка, отмеренная на треть клетки от ПЕРЕДНЕЙ кромки
    # модели, оказывается в 0.06 клетки от ПРАВОЙ кромки карты. Игре же нужна
    # точка ровно в трети клетки от ТОЙ кромки карты, у которой рабочий стоит.
    #
    # Поэтому замер отдаёт СВОБОДНЫЕ ПОЛОСЫ у всех четырёх сторон на четырёх
    # глубинах, а движок выбирает точку у нужной кромки и сам ставит её на
    # `step_in` от неё (js/buildings.js: yardPoints). Свобода при этом не
    # выдумывается: она померена, и глубина берётся из померенных.
    out = []
    for side in SIDES:
        pts = []
        for k in range(int(round(SIDE))):
            lo, hi = k + CELL_MARGIN, k + 1 - CELL_MARGIN
            for s in DEPTHS:
                ivs = free_intervals_side(polys, side, s, foot_r)
                seg = []
                for a, b in ivs:
                    if b < lo or a > hi:
                        continue
                    seg.append((max(a, lo), min(b, hi)))
                if not seg:
                    continue
                cand = []
                for a, b in seg:
                    t, c = best_point_side(polys, side, a, b, s)
                    cand.append((c, t))
                c, t = max(cand)
                u, v = side_uv(side, t, s)
                pts.append({'u': round(u, 3), 'v': round(v, 4),
                            'depth': round(s, 3), 'clear': round(c, 3),
                            't': round(t, 3)})
        out.append({'side': side, 'points': pts})
    return out


def free_intervals_side(polys, side, s, r, step=GRID):
    # Свободные промежутки ВДОЛЬ кромки side на глубине s от неё.
    cells = int(round(SIDE / step))
    ivs, run = [], None
    for i in range(cells + 1):
        t = min(SIDE, i * step)
        u, v = side_uv(side, t, s)
        free = clearance(polys, u, v) >= r
        if free and run is None:
            run = t
        elif not free and run is not None:
            ivs.append((run, t))
            run = None
    if run is not None:
        ivs.append((run, SIDE))
    if not ivs:
        return []
    merged = [list(ivs[0])]
    for a, b in ivs[1:]:
        if a - merged[-1][1] <= step + 1e-9:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def best_point_side(polys, side, a, b, s):
    # Самая просторная точка промежутка вдоль кромки side.
    best, bx = -1.0, (a + b) / 2.0
    n = max(2, int(round((b - a) / GRID)))
    for i in range(n + 1):
        t = a + (b - a) * i / n
        u, v = side_uv(side, t, s)
        c = clearance(polys, u, v)
        if c > best:
            best, bx = c, t
    return bx, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true',
                    help='записать out/yard.json (его читает pack_lumbercamp.py)')
    ap.add_argument('--foot-r', type=float, default=FOOT_R)
    ap.add_argument('--slots', type=int, default=N_SLOTS)
    args = ap.parse_args()

    gen = load_generator()
    parts = gen.build()
    y = yard(parts, n_slots=args.slots, foot_r=args.foot_r)

    print('двор лагеря лесоруба, замер по модели (building.py)')
    print('  пятно %.0f x %.0f, шаг сетки %.2f, радиус ступней %.2f'
          % (SIDE, SIDE, GRID, args.foot_r))
    print('  линия становки: v = %.3f (%.3f клетки от передней кромки)'
          % (y['line_y'], y['step_in']))
    print('  свободные участки линии: %s' % (y['free'] or 'нет'))
    print('  места становки (u — вдоль кромки, простор до деталей):')
    for s, c in zip(y['slots'], y['clear']):
        print('    u = %.3f  простор %.3f клетки%s'
              % (s['u'], c, '' if c > args.foot_r else '  ← теснее радиуса ступней'))
    if len(y['slots']) < args.slots:
        print('  ВНИМАНИЕ: свободных мест %d, а рабочих в лагере %d'
              % (len(y['slots']), args.slots))
    if args.write:
        dst = os.path.join(ROOT, 'out', 'yard.json')
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8') as fh:
            json.dump(y, fh, ensure_ascii=False, indent=1)
        print('  записано: %s' % os.path.relpath(dst, REPO))
    return 0


if __name__ == '__main__':
    sys.exit(main())
