import json, numpy as np
from PIL import Image
import os
# references → villager → characters → art → корень 4tox (docs/STRUCTURE.md)
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
A = os.path.join(REPO, 'mapgen2', 'assets', 'hero') + os.sep
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))


def frame(n):
    f = meta['frames'][n]
    return img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(int)


for nm in ['hero_chop_1_1', 'hero_chop_4_1', 'hero_chop_5_1']:
    s = frame(nm)
    blk = s[..., :3].max(axis=2) <= 8
    al = s[..., 3] * blk
    obj = (s[..., 3] > 8) & ~blk
    rows = np.where(al.any(axis=1))[0]
    print('===', nm, 'shadow rows', rows.min(), rows.max())
    for r in range(max(0, rows.min() - 6), min(al.shape[0], rows.max() + 2)):
        a_s = ''.join('%4d' % al[r, x] if al[r, x] else '   .' for x in range(20, 92, 2))
        print('%4d %s' % (r, a_s))
    orows = np.where(obj.any(axis=1))[0]
    print('   obj rows', orows.min(), orows.max())
