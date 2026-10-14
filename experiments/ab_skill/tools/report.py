"""report.py — out/report.txt: числа постройки без Blender.

    $PY3 tools/report.py            # -> out/report.txt

Считает по генератору (`tools/building.py`) и его SPEC: трис, габарит по осям,
ярусы, уклон по двум точкам ОДНОЙ поверхности ската, свесы, бюджет по классу.
Плюс подшивает к отчёту результаты проверок, если они уже лежат рядом
(`out/probe.txt`, `out/canon.txt`, `out/gate.txt`).
"""
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import forge as F                                                    # noqa: E402

GEN = os.path.join(HERE, 'building.py')


def load():
    spec = importlib.util.spec_from_file_location('smithy_gen', GEN)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['smithy_gen'] = mod
    spec.loader.exec_module(mod)
    return mod


def section(title):
    return ['', '== %s ==' % title]


def main():
    m = load()
    parts = m.build()
    spec = m.SPEC
    xs = [v[0] for p in parts for v in p['verts']]
    ys = [v[1] for p in parts for v in p['verts']]
    zs = [v[2] for p in parts for v in p['verts']]
    tris = sum(sum(len(f) - 2 for f in p['faces']) for p in parts)
    pal = F.Palette()
    lo, hi = pal.budget(spec.get('class_', 'building'))
    HX, HY = m.HX, m.HY
    # уклон — по двум точкам ВЕРХА одной поверхности ската (z_nom)
    y0, y1 = 0.0, m.EAVE_Y
    pitch = math.degrees(math.atan((m.z_nom(y0) - m.z_nom(y1)) / (y1 - y0)))
    ridge_top = max(v[2] for p in parts if p['name'] == 'roof_thatch'
                    for v in p['verts'])
    fams = {}
    for p in parts:
        d = fams.setdefault(p['family'], [0, 0])
        d[0] += 1
        d[1] += sum(len(f) - 2 for f in p['faces'])
    lines = []
    lines.append('КУЗНИЦА 2 x 2 (4tox / mapgen2) — отчёт генератора tools/building.py')
    lines.append('чистый Python, без bpy; палитра атласа: %s' % ', '.join(sorted(fams)))
    lines += section('ПОЛИГОНАЖ')
    lines.append('деталей %d, вершин %d, ТРИС %d (бюджет класса %s: %d..%d)'
                 % (len(parts), sum(len(p['verts']) for p in parts), tris,
                    spec.get('class_', 'building'), lo, hi))
    for k, v in sorted(fams.items(), key=lambda kv: -kv[1][1]):
        lines.append('  %-12s деталей %3d  трис %4d' % (k, v[0], v[1]))
    lines += section('ГАБАРИТ (юниты, 1 юнит = 1 клетка карты)')
    lines.append('X %.3f..%.3f  размер %.3f' % (min(xs), max(xs), max(xs) - min(xs)))
    lines.append('Y %.3f..%.3f  размер %.3f' % (min(ys), max(ys), max(ys) - min(ys)))
    lines.append('Z %.3f..%.3f  ВЫСОТА %.3f' % (min(zs), max(zs), max(zs) - min(zs)))
    fx, fy = spec['footprint']
    over = max(abs(min(xs)) - fx / 2.0, abs(max(xs)) - fx / 2.0,
               abs(min(ys)) - fy / 2.0, abs(max(ys)) - fy / 2.0)
    lines.append('пятно застройки %dx%d: вылет за пятно %.3f (допуск 0.03)'
                 % (fx, fy, max(0.0, over)))
    lines.append('при повороте 90/270 габарит меняет оси: %.3f x %.3f'
                 % (max(ys) - min(ys), max(xs) - min(xs)))
    lines += section('ЯРУСЫ (снизу вверх)')
    lines.append('цоколь      0.000 .. %.3f (полка ядра), блоки-шов 0.028' % m.Z0)
    lines.append('стены       %.3f .. %.3f  (высота %.3f, наклон 1.0 град)'
                 % (m.Z0, m.Z1, m.WALL_H))
    lines.append('обвязки     нижняя %.3f..%.3f, верхняя %.3f..%.3f, брус %.2f x %.2f'
                 % (m.ZB0, m.ZB1, m.ZT0, m.ZT1, m.FRAME_T, m.FRAME_OUT))
    lines.append('воротца     ширина %.2f, высота %.2f (%.3f..%.3f), две створки'
                 % (m.GATE_W, m.GATE_H, m.Z0, m.GATE_TOP))
    lines.append('окно        %.2f x %.2f, центр z %.2f (торец -X)'
                 % (m.WIN_SIZE, m.WIN_SIZE, m.WIN_Z))
    lines.append('кровля      низ ската у стены %.3f, конёк (номинал) %.3f, '
                 'верх пластов %.3f' % (m.z_under(m.ROOF_Y0), m.RIDGE_Z, ridge_top))
    lines.append('труба горна смещена от конька: x %.2f, y %.2f, верх %.3f'
                 % (m.CHX, m.CHY, max(zs)))
    lines += section('УКЛОН И СВЕСЫ')
    lines.append('уклон ската %.1f град (канон 32..55): по двум точкам ОДНОЙ '
                 'поверхности — y=%.2f -> z=%.3f, y=%.2f -> z=%.3f'
                 % (pitch, y0, m.z_nom(y0), y1, m.z_nom(y1)))
    lines.append('толщина кровли %.3f, пластов на скат %d'
                 % (m.ROOF_T, m.N_PLAST))
    lines.append('свес по скату  %.3f = %.1f%% ширины стены (канон 11..31%%)'
                 % (m.EAVE_Y - HY, 100.0 * (m.EAVE_Y - HY) / spec['wall_y']))
    lines.append('свес по торцу  %.3f = %.1f%% длины стены (канон 4..13%%)'
                 % (m.ROOF_X - HX, 100.0 * (m.ROOF_X - HX) / spec['wall_x']))
    lines.append('кровля/стены %.2f (канон 0.45..1.35)'
                 % ((m.RIDGE_Z - m.Z1) / m.WALL_H))
    # --- подшиваем то, что уже померяли инструменты скилла
    for name, title in (('canon.txt', 'ПРИЁМКА ПО КАНОНУ (tools/canon.py)'),
                        ('probe.txt', 'ДЕФЕКТЫ (tools/xray.py probe --full)'),
                        ('gate.txt', 'СТИЛЬ-ГЕЙТ (4tox-lowpoly-3d audit.py)')):
        p = os.path.join(ROOT, 'out', name)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                lines += section(title)
                lines.append(f.read().rstrip())
    lines.append('')
    out = os.path.join(ROOT, 'out', 'report.txt')
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(lines[:40]))
    print('... -> %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
