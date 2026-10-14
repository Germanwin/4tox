import json, sys, numpy as np
from PIL import Image
sys.path.insert(0, '/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/scripts')
import canon as C
import os
# references → villager → characters → art → корень 4tox (docs/STRUCTURE.md)
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
A = os.path.join(REPO, 'mapgen2', 'assets', 'hero') + os.sep
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))
TONES = C.canon_tones()
TRGB = np.array([t[2] for t in TONES], float)
TFAM = [t[0] for t in TONES]
ORGB = np.array([C.hex_rgb(h) for h in C.palette()['outline']], float)

for nm in ['hero_idle_0_0', 'hero_idle_0_2']:
    f = meta['frames'][nm]
    a = img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(int)
    rgb = a[..., :3]
    d = np.sqrt(((rgb.astype(float)[..., None, :] - TRGB[None, None]) ** 2).sum(-1))
    fi = np.argmin(d, -1)
    fam = np.array(TFAM)[fi]
    do = np.sqrt(((rgb.astype(float)[..., None, :] - ORGB[None, None]) ** 2).sum(-1)).min(-1)
    blk = rgb.max(axis=2) <= 8
    obj = (a[..., 3] > 8) & ~blk
    print('===', nm)
    for r in range(84, 102):
        idx = np.where((fam == 'leather') & obj)[r]
        print(' %3d nL=%d  %s' % (r, len(idx),
                                  [(int(x), tuple(int(v) for v in a[r, x])) for x in idx][:6]))
