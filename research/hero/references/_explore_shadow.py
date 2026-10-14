import json, numpy as np
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


for nm in ['hero_idle_0_0', 'hero_idle_0_1']:
    s = frame(nm)
    black = s[..., :3].max(axis=2) <= 8
    al = s[..., 3] * black
    print('===', nm, ' shadow alpha grid (rows 104..120, cols 38..80)')
    print('     ' + ''.join('%4d' % x for x in range(38, 80, 2)))
    for r in range(104, 121):
        vals = [al[r, x] for x in range(38, 80)]
        if max(vals) == 0:
            continue
        print('%4d ' % r + ''.join(('%4d' % al[r, x]) if al[r, x] else '   .' for x in range(38, 80, 2)))
    # профиль по строке центра
    rows = np.where(al.any(axis=1))[0]
    print('rows', rows.min(), rows.max())
    for r in range(rows.min(), rows.max() + 1):
        c = np.where(al[r] > 0)[0]
        print('  row %d  x %d..%d  w=%d  peak=%d  mean=%d' %
              (r, c.min(), c.max(), c.max() - c.min() + 1, al[r].max(), al[r][al[r] > 0].mean()))
    # горизонтальный профиль через строку максимума
    rmax = max(rows, key=lambda r: al[r].max())
    print(' widest-alpha row', rmax, [(x, al[rmax, x]) for x in range(38, 80) if al[rmax, x]])
