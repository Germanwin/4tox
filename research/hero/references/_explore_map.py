import json, numpy as np, sys
from PIL import Image
import os
# references → hero → research → корень 4tox (docs/STRUCTURE.md)
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
A = os.path.join(REPO, 'mapgen2', 'assets', 'hero') + os.sep
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))


def frame(n):
    f = meta['frames'][n]
    return img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(int)


CAND = [
    ('K', ['#0C100C', '#0D120D', '#0E130E', '#0B0F0B', '#0E120E', '#0F120E']),   # контур
    ('H', ['#523521', '#4E321F', '#5B3B25', '#4C311E', '#492F1D', '#503320', '#553722']),  # волос/штаны светл.
    ('h', ['#321E11', '#3E2916', '#2A1B0E', '#332111', '#2D1D0E', '#1C1108', '#3A2614']),  # тёмный низ
    ('S', ['#C99464', '#A87B52', '#745437', '#AD7F55', '#B48458', '#B38358']),  # кожа
    ('C', ['#A8701F', '#895B18', '#56360B', '#94621A', '#91601A', '#8E5F19', '#9B671C']),  # рубаха
    ('I', ['#6E767C', '#636B72', '#454B50', '#5E656C', '#626A71', '#5D656B']),  # железо
]


def hx(s):
    s = s.lstrip('#')
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], float)


cols = np.array([hx(c) for ch, cs in CAND for c in cs])
owner = [ch for ch, cs in CAND for c in cs]


def classify(px):
    d = ((px[None, :] - cols) ** 2).sum(1)
    i = int(np.argmin(d))
    return owner[i], float(np.sqrt(d[i]))


for nm in sys.argv[1:] or ['hero_idle_0_0']:
    s = frame(nm)
    print('===', nm, '   anchor x=56 y=106')
    print('    ' + ''.join(str((x // 10) % 10) for x in range(30, 82)))
    print('    ' + ''.join(str(x % 10) for x in range(30, 82)))
    for r in range(24, 120):
        line = ''
        for x in range(30, 82):
            p = s[r, x]
            a = p[3]
            if a <= 8:
                line += '.'
            elif p[:3].max() <= 8:
                line += ('#' if a > 60 else '+')
            else:
                ch, d = classify(p[:3].astype(float))
                line += ch if a == 255 else ch.lower()
        print('%3d %s' % (r, line))
