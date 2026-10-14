"""palette.py — палитра дома: зона -> семейство тонов АТЛАСА. Без Blender.

Правило скилла `4tox-lowpoly-3d` (references/palette.md): цвета берутся из
палитры атласа игры, а не с эталонных рендеров. Тона читаются из машинной
палитры скилла (references/palette.json), а не переписываются руками — если
канон поменяется, дом поедет за ним, а не разойдётся с ним молча.

Зона дома -> семейство (обоснование выбора — house/README.md, «Палитра»):

    цоколь, подоконник, обкладка   stone        серый камень атласа
    каркас, доски, двери, поленница trunk       самое тёмное дерево
    обмазка стен                   skin         тёплый тан; у ратуши обмазка
                                                замерена ровно между тонами skin
                                                (light d=26, dark d=22)
    солома кровли                  leaf_autumn  канон: «солома жёлтая»
    мох на цоколе                  grass        зелёный акцент атласа
    стекло                         iron         тёмное стекло (канон §5)
    проёмы, тени, дым              leather      почти чёрный проём

Пороги тонов — из palette.json (`tone_thresholds`): у дерева и камня они
разные, потому что у камня самая светлая видимая грань ловит 0.75 солнца,
а у дерева — 0.50. Общий порог выжег бы камень в светлый тон.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_PALETTE = ('/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/references/'
                 'palette.json')

# --- палитра на случай, если файла скилла нет рядом (значения оттуда) --------
FALLBACK_TONES = {
    'trunk':       ('#523521', '#4E321F', '#321E11'),
    'stone':       ('#798186', '#656B70', '#44484A'),
    'skin':        ('#C99464', '#A87B52', '#745437'),
    'leaf_autumn': ('#A8701F', '#895B18', '#56360B'),
    'grass':       ('#447937', '#3A682F', '#2E5424'),
    'iron':        ('#6E767C', '#636B72', '#454B50'),
    'leather':     ('#3A2614', '#2A1B0E', '#1C1108'),
}
FALLBACK_THRESH = dict(wood=(0.50, 0.30), stone=(0.75, 0.28), leaf=(0.55, 0.32),
                       skin=(0.52, 0.30), iron=(0.75, 0.28), leather=(0.50, 0.30))

# --- зона дома -> семейство атласа ------------------------------------------
ZONE = {
    'trunk': 'trunk',
    'stone': 'stone',
    'skin': 'skin',
    'leaf_autumn': 'leaf_autumn',
    'grass': 'grass',
    'iron': 'iron',
    'leather': 'leather',
}
# --- семейство -> порог тонов (ключ в palette.json['tone_thresholds']) -------
THRESH_KEY = {
    'trunk': 'wood', 'stone': 'stone', 'skin': 'skin', 'leaf_autumn': 'leaf',
    'grass': 'leaf', 'iron': 'iron', 'leather': 'leather',
}

FAMILIES = tuple(ZONE)

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
        if family and fam != family:
            continue
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
        print('%-12s %s   порог %s' % (fam, ' '.join(tones(fam)), thresholds(fam)))
    d = check()
    print('расхождений со скиллом: %d' % len(d))
    for x in d:
        print('  ', x)
