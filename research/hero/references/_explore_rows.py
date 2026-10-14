import json, numpy as np, collections, sys
from PIL import Image
A = '/Users/hermmoment/coding/4tox/mapgen2/assets/hero/'
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))


def frame(n):
    f = meta['frames'][n]
    return img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(int)


CAND = {
    'out':  ['#0C100C', '#0D120D', '#0E130E', '#0B0F0B', '#0E120E', '#0F120E'],
    'hair': ['#523521', '#4E321F', '#321E11', '#5B3B25'],
    'skin': ['#C99464', '#A87B52', '#745437', '#AD7F55'],
    'shir': ['#A8701F', '#895B18', '#56360B', '#94621A'],
    'dark': ['#3A2614', '#2A1B0E', '#1C1108', '#2D1D0E'],
    'iron': ['#6E767C', '#636B72', '#454B50', '#5E656C'],
}


def hx(s):
    s = s.lstrip('#')
    return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], float)


names = list(CAND)
cols = np.array([hx(c) for n in names for c in CAND[n]])
owner = [n for n in names for c in CAND[n]]


def classify(px):
    d = ((px[None, :] - cols) ** 2).sum(1)
    return owner[int(np.argmin(d))], float(np.sqrt(d.min()))


for nm in sys.argv[1:] or ['hero_idle_0_0']:
    s = frame(nm)
    print('===', nm)
    for r in range(20, 120):
        row = s[r]
        m = row[:, 3] == 255
        idx = np.where(m)[0]
        if len(idx) == 0:
            continue
        cnt = collections.Counter()
        for x in idx:
            cl, d = classify(row[x, :3].astype(float))
            cnt[cl] += 1
        allm = (row[:, 3] > 8) & (row[:, :3].max(axis=1) > 8)
        ai = np.where(allm)[0]
        top = ' '.join('%s%d' % (k, v) for k, v in cnt.most_common(5))
        print('%3d z=%+6.3f flat=%3d all=%3d x[%3d..%3d] w=%2d  %s'
              % (r, (106 - r) / 96, len(idx), len(ai), ai.min(), ai.max(), ai.max() - ai.min() + 1, top))
