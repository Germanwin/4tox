"""gate.py — стиль-гейт по ВСЕМ кадрам атласа, одной командой.

    $PY tools/gate.py                 # 336 кадров 1x + 336 кадров @4x = 672
    $PY tools/gate.py --anims walk    # только ходьба
    $PY tools/gate.py --tag vg --ppu 96

В README приёмка записана как «672 из 672 кадров: 0 FAIL, 0 WARN», но запускался
гейт по одному кадру руками (`4tox-lowpoly-3d/scripts/audit.py --mine ...`), и
повторить эту строку было нечем. Здесь то же самое циклом: кадр за кадром, с
итогом и кодом возврата 1, если хоть один кадр не прошёл.

В СПИСКЕ АНИМАЦИЙ ПО УМОЛЧАНИЮ — ВСЕ ШЕСТЬ. Было пять: `carry_put` (4 кадра x 8
поворотов = 32 кадра на масштаб) в список не попал, и «672 из 672» из README
получалось только руками — умолчание давало 608. Кадры, которых нет, цикл и так
пропускает (сдача короче остальных), поэтому цена включения — ноль.

Класс объекта — `hero`: житель того же роста и той же клетки атласа, что
персонаж-лесоруб, и бюджет полигонажа у них общий (300..700 трис).
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKILL = '/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d'
AUDIT = os.path.join(SKILL, 'scripts', 'audit.py')

ROTS = (0, 45, 90, 135, 180, 225, 270, 315)   # повороты атласа: восемь, через 45°
CELL = (112.0, 132.0)
ANCHOR = (56.0, 106.0)


def run_one(png, ppu, anchor, tris, kind='hero'):
    p = subprocess.run([sys.executable, AUDIT, '--mine', png, '--anchor', anchor,
                        '--kind', kind, '--tris', str(tris), '--ppu', str(ppu)],
                       capture_output=True, text=True)
    return p.stdout, p.returncode


def verdict(out):
    """Строки FAIL/WARN и итоговый вердикт гейта."""
    fails = re.findall(r'^\s*FAIL\s+(.*)$', out, re.M)
    warns = re.findall(r'^\s*WARN\s+(.*)$', out, re.M)
    ok = bool(re.search(r'ИТОГ:\s*(OK|ПРИНЯТО)', out)) or not fails
    return fails, warns, ok


def tris_of(anim):
    """Трис кадра — ПО ГЕОМЕТРИИ этой анимации, а не одной цифрой на все.

    Было `--tris 670` на весь прогон: 598 в покое/ходьбе и 670 в рубке, и гейт
    проверял бюджет по числу, которое ему назвали. С появлением анимаций с
    охапкой (678 трис) и с топором на ходу (670) одна цифра на все кадры — это
    уже враньё в отчёте: кадр с охапкой уходил бы в бюджет как 670.
    """
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import person as H
    import poses as PO
    parts = H.build(variant='m', pose=PO.pose(anim, 0), **PO.props(anim))
    return sum(sum(len(f) - 2 for f in p['faces']) for p in parts)


def main():
    ap = argparse.ArgumentParser(description='стиль-гейт по всем кадрам')
    ap.add_argument('--anims',
                    default='idle,walk,work,carry,walk_axe,carry_put')
    # Трис в кадре: 598 в покое и ходу, 670 в рубке и с топором на ходу, 678 с
    # охапкой. По умолчанию число берётся ИЗ ГЕОМЕТРИИ (tris_of): бюджет класса
    # проверяется по худшему кадру, а не по среднему, и не по подсказке.
    ap.add_argument('--tris', type=int, default=None)
    ap.add_argument('--json', default=os.path.join(ROOT, 'out', 'gate.json'))
    a = ap.parse_args()

    total = ok_n = 0
    bad, warned = [], []
    report = {}
    for tag, out_dir, ppu in (('vg', 'out', 96.0), ('vg4', 'out4', 384.0)):
        k = ppu / 96.0
        anchor = '%.0f,%.0f' % (ANCHOR[0] * k, ANCHOR[1] * k)
        for anim in a.anims.split(','):
            tris = a.tris if a.tris else tris_of(anim)
            for fr in range(8):
                for rot in ROTS:
                    png = os.path.join(ROOT, out_dir,
                                       '%s_%s_%d_%d.png' % (tag, anim, fr, rot))
                    if not os.path.exists(png):
                        continue
                    out, code = run_one(png, ppu, anchor, tris)
                    total += 1
                    fails, warns, ok = verdict(out)
                    report[os.path.basename(png)] = dict(
                        fails=fails, warns=warns, code=code, ok=ok, tris=tris)
                    if fails or code != 0:
                        bad.append((png, fails))
                        print('FAIL %-28s %s' % (os.path.basename(png), '; '.join(fails)))
                    elif warns:
                        warned.append((png, warns))
                        print('WARN %-28s %s' % (os.path.basename(png), '; '.join(warns)))
                    else:
                        ok_n += 1
        print('--- %s: пройдено %d из %d ---' % (tag, ok_n, total))

    with open(a.json, 'w', encoding='utf-8') as f:
        json.dump(dict(total=total, clean=ok_n, failed=len(bad),
                       warned=len(warned), frames=report),
                  f, ensure_ascii=False, indent=1)
    print('\nИТОГ ГЕЙТА: %d из %d кадров без FAIL и WARN, FAIL %d, WARN %d'
          % (ok_n, total, len(bad), len(warned)))
    print('отчёт: %s' % a.json)
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
