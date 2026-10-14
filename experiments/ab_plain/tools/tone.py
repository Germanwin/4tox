# -*- coding: utf-8 -*-
"""tone.py — палитра и тон фасета. ЧИСТЫЙ Python, без bpy.

Тон фасета считается по его нормали: яркость = max(0, n·sun) + доля неба,
пороги — по семейству (скилл 4tox-lowpoly-3d, references/palette.json).
Это тот же протокол, что у соседних построек (villager_house/tools/palette.py):
оба проекта красятся ОДНОЙ палитрой, поэтому деревня сходится по цвету.

base_hex() отдаёт ЦВЕТ МАТЕРИАЛА, а не цвет спрайта: сцена поднимает тон
солнцем и небом, поэтому базовые цвета посчитаны калибровкой (pal_cal.json,
снят калибровочным прогоном villager_house — та же сцена, тот же свет).
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PAL_CAL = os.path.join(HERE, 'pal_cal.json')

FAMILIES = ('trunk', 'stone', 'skin', 'leaf_autumn', 'grass', 'iron', 'leather')

# цвета СПРАЙТА (sRGB) — по ним проверяется палитра кадра
TONES = {
    'trunk':       {'light': '#523521', 'mid': '#4E321F', 'dark': '#321E11'},
    'stone':       {'light': '#798186', 'mid': '#656B70', 'dark': '#44484A'},
    'skin':        {'light': '#C99464', 'mid': '#A87B52', 'dark': '#745437'},
    'leaf_autumn': {'light': '#A8701F', 'mid': '#895B18', 'dark': '#56360B'},
    'grass':       {'light': '#447937', 'mid': '#3A682F', 'dark': '#2E5424'},
    'iron':        {'light': '#6E767C', 'mid': '#636B72', 'dark': '#454B50'},
    'leather':     {'light': '#3A2614', 'mid': '#2A1B0E', 'dark': '#1C1108'},
}

# порог (светлый, средний) по ожидаемой яркости фасета
THRESH = {
    'trunk':       (0.50, 0.30),      # key 'wood' в palette.json
    'stone':       (0.75, 0.28),
    'skin':        (0.52, 0.30),
    'leaf_autumn': (0.55, 0.32),      # key 'leaf'
    'grass':       (0.55, 0.32),
    'iron':        (0.75, 0.28),
    'leather':     (0.50, 0.30),
}

SUN = (-0.36, 0.30, 0.88)             # направление НА солнце (канон сцены)
AMBIENT_W = 0.15                      # доля неба в яркости фасета


def _norm(v):
    d = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / d for c in v)


SUN_N = _norm(SUN)


def face_normal(verts, f):
    """Единичная нормаль грани НАРУЖУ (обход в гранях — против часовой)."""
    a, b, c = verts[f[0]], verts[f[1]], verts[f[2]]
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    return _norm(n)


def brightness(normal):
    l = sum(normal[i] * SUN_N[i] for i in range(3))
    return max(0.0, l) + AMBIENT_W


def tone_of(family, normal):
    """Тон 0/1/2 для фасета семейства family с нормалью normal."""
    light, mid = THRESH[family]
    b = brightness(normal)
    return 0 if b >= light else (1 if b >= mid else 2)


def face_tones(parts):
    """[(family, tone), ...] по фасетам всех деталей (для отчёта и сборки)."""
    out = []
    for p in parts:
        for f in p['faces']:
            out.append((p['family'], tone_of(p['family'], face_normal(p['verts'], f))))
    return out


def tone_census(parts):
    """Сколько фасетов и какая площадь в каждом (семейство, тон)."""
    out = {}
    for p in parts:
        for f in p['faces']:
            fam = p['family']
            t = tone_of(fam, face_normal(p['verts'], f))
            vs = p['verts']
            a = vs[f[0]]
            area = 0.0
            for i in range(1, len(f) - 1):
                b, c = vs[f[i]], vs[f[i + 1]]
                u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
                v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
                cr = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                      u[0] * v[1] - u[1] * v[0])
                area += 0.5 * math.sqrt(sum(k * k for k in cr))
            key = '%s_%d' % (fam, t)
            d = out.setdefault(key, [0, 0.0])
            d[0] += 1
            d[1] += area
    return out


_CAL = None


def calibration():
    """Линейные базовые цвета материалов (калибровка соседнего проекта)."""
    global _CAL
    if _CAL is None:
        with open(PAL_CAL, encoding='utf-8') as f:
            _CAL = json.load(f)
    return _CAL


def base_hex(family, tone):
    """Базовый цвет материала (линейный hex) — из калибровки, иначе из палитры."""
    cal = calibration()
    try:
        return int(str(cal[family][str(tone)]).lstrip('#'), 16)
    except Exception:
        target = TONES[family]['light' if tone == 0 else ('mid' if tone == 1 else 'dark')]
        return int(target.lstrip('#'), 16)


if __name__ == '__main__':
    import sys
    sys.path.insert(0, HERE)
    import building as B
    for key in sorted(B.VARIANTS):
        parts = B.build(key)
        cen = tone_census(parts)
        tot = sum(v[0] for v in cen.values())
        print('вариант %s: фасетов %d, раскрашено %d, слотов %d'
              % (key, sum(len(p['faces']) for p in parts), tot, len(cen)))
        for k in sorted(cen):
            print('   %-14s фасетов %3d  площадь %6.3f' % (k, cen[k][0], cen[k][1]))
