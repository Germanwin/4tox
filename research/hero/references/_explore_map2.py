import json, numpy as np, sys
from PIL import Image
import os
# references → hero → research → корень 4tox (docs/STRUCTURE.md)
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
A = os.path.join(REPO, 'mapgen2', 'assets', 'hero') + os.sep
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))
sys.path.insert(0, '/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/scripts')
import canon as C

TONES = C.canon_tones()
TRGB = np.array([t[2] for t in TONES], float)
TFAM = [t[0] for t in TONES]
ORGB = np.array([C.hex_rgb(h) for h in C.palette()['outline']], float)
LET = {'trunk': 'T', 'skin': 'S', 'leaf_autumn': 'A', 'iron': 'I', 'leather': 'L',
       'stone': 'G', 'ore_iron': 'O', 'leaf_oak': 'E', 'grass': 'R', 'bush': 'U',
       'leaf_birch': 'B', 'leaf_pine': 'P', 'reeds': 'D', 'salt': 'H', 'flower_white': 'W',
       'flower_yellow': 'Y', 'flower_pink': 'Z'}


def fmap(nm):
    f = meta['frames'][nm]
    s = img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(int)
    rgb = s[..., :3].astype(float)
    d = np.sqrt(((rgb[..., None, :] - TRGB[None, None]) ** 2).sum(-1))
    fi = np.argmin(d, -1)
    do = np.sqrt(((rgb[..., None, :] - ORGB[None, None]) ** 2).sum(-1)).min(-1)
    blk = s[..., :3].max(axis=2) <= 8
    obj = (s[..., 3] > 8) & ~blk
    out = np.full(s.shape[:2], '.', dtype='<U1')
    out[blk & (s[..., 3] > 8)] = '#'
    for y in range(s.shape[0]):
        for x in range(s.shape[1]):
            if not obj[y, x]:
                continue
            out[y, x] = 'K' if do[y, x] <= 16 else LET.get(TFAM[fi[y, x]], '?')
    return out, s


for nm in sys.argv[1:] or ['hero_idle_0_0']:
    out, s = fmap(nm)
    print('===', nm, '   T=trunk(волосы/штаны/пояс/рукоять) S=skin A=leaf_autumn(рубаха) '
          'I=iron(лезвие) L=leather(обувь) K=контур #=тень')
    print('    ' + ''.join(str(x % 10) for x in range(32, 80)))
    for r in range(24, 120):
        print('%3d %s' % (r, ''.join(out[r, 32:80])))
