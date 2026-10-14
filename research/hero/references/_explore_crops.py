import json, os, numpy as np, sys
from PIL import Image

# references → hero → research → корень 4tox (docs/STRUCTURE.md)
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
A = os.path.join(REPO, 'mapgen2', 'assets', 'hero') + os.sep
OUT = HERE + os.sep
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))


def frame(n):
    f = meta['frames'][n]
    return img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']]


def over(sub, bg=(190, 190, 190)):
    rgb = sub[..., :3].astype(np.float32)
    a = sub[..., 3:4].astype(np.float32) / 255.0
    b = np.zeros_like(rgb) + np.array(bg, dtype=np.float32)
    return (rgb * a + b * (1 - a)).astype(np.uint8)


K = 6
for i in range(4):
    nm = 'hero_idle_0_%d' % i
    im = over(frame(nm))
    head = im[24:80, 34:80]
    legs = im[82:120, 34:80]
    Image.fromarray(head).resize((head.shape[1] * K, head.shape[0] * K), Image.NEAREST) \
        .save(OUT + '_tmp_head_%d.png' % i)
    Image.fromarray(legs).resize((legs.shape[1] * K, legs.shape[0] * K), Image.NEAREST) \
        .save(OUT + '_tmp_legs_%d.png' % i)
print('ok')
