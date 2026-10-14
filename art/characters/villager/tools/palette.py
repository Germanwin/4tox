"""palette.py — палитра жительницы: зона -> семейство тонов АТЛАСА. Без Blender.

Правило скилла `4tox-lowpoly-3d` (references/palette.md): цвета берутся из
палитры атласа игры, а не подбираются на глаз. Тона читаются из машинной
палитры скилла (references/palette.json) — если канон поменяется, фигура поедет
за ним, а не разойдётся с ним молча.

Зона -> семейство (и почему так):

    лицо, шея, руки, голени   skin         единственное выведенное семейство
                                           атласа; людей в атласе нет, тона
                                           skin приняты протоколом остальных
    платье, рукава            stone        холодная сине-серая масса: герой
                                           одет в тёплую охру (leaf_autumn), и
                                           второй человек обязан от него
                                           отличаться в кадре
    фартук, платок            leaf_autumn  тёплый акцент; у платка светлый тон
                                           ловит небо (купол смотрит вверх) —
                                           голова читается светлым пятном
    пояс, сапоги              leather      самое тёмное семейство атласа: пояс
                                           отделяет платье от фартука
    пряжка                    iron         железо темнее камня на ступень
    корзина, обруч            trunk        тёмное дерево атласа
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_PALETTE = ('/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/references/'
                 'palette.json')

# Зона -> семейство атласа. Порядок = порядок слотов материалов в Blender.
ZONE = ('skin', 'stone', 'leaf_autumn', 'leather', 'iron', 'trunk', 'salt')
# Семейство -> ключ порогов тонов в palette.json['tone_thresholds'].
THRESH_KEY = {'skin': 'skin', 'stone': 'stone', 'leaf_autumn': 'leaf',
              'leather': 'leather', 'iron': 'iron', 'trunk': 'wood', 'salt': 'stone'}
# Копия тонов на случай, если файла скилла нет рядом (значения оттуда).
FALLBACK_TONES = {
    'skin':        ('#C99464', '#A87B52', '#745437'),
    'stone':       ('#798186', '#656B70', '#44484A'),
    'leaf_autumn': ('#A8701F', '#895B18', '#56360B'),
    'leather':     ('#3A2614', '#2A1B0E', '#1C1108'),
    'iron':        ('#6E767C', '#636B72', '#454B50'),
    'trunk':       ('#523521', '#4E321F', '#321E11'),
    'salt':        ('#9DA3A6', '#898E91', '#4A4E4D'),
}
FALLBACK_THRESH = dict(skin=(0.52, 0.30), stone=(0.75, 0.28), leaf=(0.55, 0.32),
                       leather=(0.50, 0.30), iron=(0.75, 0.28), wood=(0.50, 0.30))
FAMILIES = ZONE
_pal = None


def _skill():
    global _pal
    if _pal is None:
        try:
            with open(SKILL_PALETTE, encoding='utf-8') as f:
                _pal = json.load(f)
        except Exception:
            _pal = {}
    return _pal


def tones(family=None):
    """Семейство -> (свет, средний, тень) в sRGB hex. Без аргумента — все."""
    src = _skill().get('tones', {})
    out = {}
    for fam in FAMILIES:
        t = src.get(fam)
        if t and all(k in t for k in ('light', 'mid', 'dark')):
            out[fam] = (t['light'].upper(), t['mid'].upper(), t['dark'].upper())
        else:
            out[fam] = FALLBACK_TONES[fam]
    return out if family is None else out[family]


def thresholds(family):
    th = _skill().get('tone_thresholds', {})
    key = THRESH_KEY[family]
    val = th.get(key) or FALLBACK_THRESH[key]
    return float(val[0]), float(val[1])


def hex_rgb(s):
    s = s.lstrip('#')
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def check():
    """Сверка встроенной копии с палитрой скилла — чтобы не разойтись молча."""
    diffs = []
    for fam, fb in FALLBACK_TONES.items():
        live = tones(fam)
        if tuple(x.upper() for x in fb) != tuple(x.upper() for x in live):
            diffs.append((fam, fb, live))
    return diffs


if __name__ == '__main__':
    for fam in FAMILIES:
        print('%-12s %s   порог(свет,сред) %s' % (fam, ' '.join(tones(fam)),
                                                  thresholds(fam)))
    d = check()
    print('расхождений со скиллом: %d' % len(d))
    for x in d:
        print('  ', x)


# НАПРАВЛЕНИЕ СВЕТА — ЗЕРКАЛО КАНОНА ПО X.
# В каноне (thpipe.SUN_DIR) свет летит из -X, а камера игры стоит в квадранте
# +X+Y: js/render.js рисует ниже тот узел, у которого больше x+y, значит ближе
# к камере — сторона +X+Y. Тогда ОСВЕЩЁННАЯ сторона (-X) — это та, которую
# камера не видит, и у жителя лицо (нормаль +X) получало b = 0.15, то есть
# самый тёмный тон: голова читалась грязным комком. У атласа героя лицо светлое
# именно потому, что его свет совпадает с его камерой.
# В экранных координатах направление света НЕ меняется (right·sun ~ 0.04, свет
# сверху), поэтому тон граней остаётся канонным, а тёмная сторона уходит на
# спину — как у героя.
SUN_DIR = (0.36, 0.30, 0.88)
