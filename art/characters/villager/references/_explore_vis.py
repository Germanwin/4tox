import json, numpy as np
from PIL import Image
A = '/Users/hermmoment/coding/4tox/mapgen2/assets/hero/'
OUT = '/Users/hermmoment/coding/4tox/hero/references/'
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


for nm in ['hero_walk_0_0', 'hero_walk_1_0', 'hero_chop_3_0', 'hero_chop_5_0']:
    im = over(frame(nm))
    Image.fromarray(im).resize((im.shape[1] * 5, im.shape[0] * 5), Image.NEAREST) \
        .save(OUT + '_tmp_%s.png' % nm)
print('ok')
