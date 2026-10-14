# -*- coding: utf-8 -*-
"""checks.py — сводный журнал проверок кузницы -> out/checks.txt.

Гоняет три независимых набора проверок и записывает, ЧЕМ проверял и ЧТО
получилось:

  1. геометрия (без Blender): трис, габарит, уклон, свесы, замкнутость,
     нормали наружу, вырожденные грани, минимальная деталь  — tools/report.py;
  2. изнанки и дыры: свой софт-рендер с z-буфером по пяти видам — сколько
     пикселей закрыто ТЫЛЬНОЙ гранью (tools/softrender.py);
  3. стиль-гейт проекта: палитра, детализация, контур, тень, полигонаж —
     скилловый scripts/audit.py на 1x (все варианты x 4 поворота) и на @4x.

    python3 tools/checks.py
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import building as B                                              # noqa: E402
import report as R                                                # noqa: E402
import softrender as S                                            # noqa: E402

PY = sys.executable
AUDIT = ('/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/scripts/audit.py')
OUT = os.path.join(ROOT, 'out', 'checks.txt')
TRIS = {}
VIEWS = ('iso', 'front', 'back', 'left', 'right')


def full_report():
    lines = ['=' * 74,
             '1. ГЕОМЕТРИЯ (tools/report.py, чистый Python, без Blender)',
             '=' * 74]
    for key in sorted(B.VARIANTS):
        rows, ok = R.variant_report(key)
        lines += rows + ['']
        TRIS[key] = B.stats(B.build(key))['tris']
    return lines


def xray():
    lines = ['=' * 74,
             '2. ИЗНАНКИ И ДЫРЫ (tools/softrender.py, софт-рендер с z-буфером)',
             '=' * 74,
             '   «изнанка» — пиксель, до которого дошла ТЫЛЬНАЯ грань: снаружи',
             '   видно нутро детали (дыра в меше или вывернутая нормаль).',
             '']
    bad = 0
    for key in sorted(B.VARIANTS):
        parts = B.build(key)
        row = []
        for view in VIEWS:
            f = S.render(parts, view, 96.0)
            row.append('%s %d/%d' % (view, f['back_px'], f['covered']))
            bad += f['back_px']
        lines.append('   %s: %s' % (key, ';  '.join(row)))
    lines.append('')
    lines.append('   ИТОГ: изнанок %d пикселей на 15 кадрах -> %s'
                 % (bad, 'ОК' if bad == 0 else 'ПРОВАЛ'))
    lines.append('')
    return lines, bad


def gate():
    lines = ['=' * 74,
             '3. СТИЛЬ-ГЕЙТ (скилл 4tox-lowpoly-3d/scripts/audit.py)',
             '=' * 74]
    fails = warns = oks = 0
    jobs = []
    for key in sorted(B.VARIANTS):
        for rot in (0, 90, 180, 270):
            jobs.append((os.path.join(ROOT, 'renders', 'abp_%s_%d.png' % (key, rot)),
                         ['--ppu', '96', '--anchor', '256,320',
                          '--tris', str(TRIS[key])],
                         'abp_%s_%d' % (key, rot)))
    jobs.append((os.path.join(ROOT, 'renders', 'abp_a_0@4x.png'),
                 ['--ppu', '384', '--anchor', '1024,1280', '--tris', str(TRIS['a'])],
                 'abp_a_0@4x'))
    for path, extra, name in jobs:
        if not os.path.exists(path):
            lines.append('   %-14s НЕТ КАДРА %s' % (name, path))
            fails += 1
            continue
        cmd = [PY, AUDIT, '--mine', path, '--kind', 'building'] + extra
        r = subprocess.run(cmd, capture_output=True, text=True)
        out = (r.stdout or '') + (r.stderr or '')
        # статусы читаем ПО СТРОКАМ: слово FAIL встречается и в самой сводке
        # «ИТОГ: ОК (0 FAIL, 0 WARN)», по подстроке счётчик врёт
        nf = sum(1 for l in out.splitlines() if l.strip().startswith('FAIL'))
        nw = sum(1 for l in out.splitlines() if l.strip().startswith('WARN'))
        tail = [l.strip() for l in out.splitlines() if 'ИТОГ' in l]
        lines.append('   %-14s код %d  FAIL %d  WARN %d  %s'
                     % (name, r.returncode, nf, nw, tail[0] if tail else out.strip()[:70]))
        fails += (r.returncode != 0)
        fails += nf
        warns += nw
        oks += (r.returncode == 0)
    lines.append('')
    lines.append('   ИТОГ: кадров ОК %d, FAIL %d, WARN %d' % (oks, fails, warns))
    lines.append('')
    return lines, fails


def main():
    lines = ['КУЗНИЦА 2 x 2 (mapgen2): журнал проверок',
             'генератор: tools/building.py (чистый Python, без bpy)',
             'кадры: renders/abp_*.png, метаданные: out/sprites.json',
             '']
    lines += full_report()
    xr, bad_x = xray()
    lines += xr
    gt, bad_g = gate()
    lines += gt
    lines.append('ИТОГОВЫЙ ВЕРДИКТ: %s'
                 % ('все проверки пройдены' if not (bad_x or bad_g)
                    else 'есть провалы: изнанок %d, провалов гейта %d' % (bad_x, bad_g)))
    text = '\n'.join(lines)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(text + '\n')
    print(text)
    print('\nchecks -> %s' % OUT)
    return 0 if not (bad_x or bad_g) else 1


if __name__ == '__main__':
    sys.exit(main())
