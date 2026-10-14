import json, numpy as np, statistics as st
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


def fit_shadow(nm):
    s = frame(nm)
    blk = s[..., :3].max(axis=2) <= 8
    al = s[..., 3] * blk
    if not al.any():
        return None
    wr = {}
    for r in range(al.shape[0]):
        c = np.where(al[r] > 0)[0]
        wr[r] = (c.max() - c.min() + 1) if len(c) else 0
    rows_w = [r for r in wr if wr[r] > 0]
    yc0 = max(rows_w, key=lambda r: wr[r])
    a = wr[yc0] / 2.0
    ybot = rows_w[-1]
    best = None
    for b in np.arange(2.0, 10.01, 0.25):
        yc = ybot - b
        err, n = 0.0, 0
        for r in rows_w:
            if r < yc:
                continue
            t = (r - yc) / b
            if t > 1:
                continue
            err += (2 * a * np.sqrt(max(0.0, 1 - t * t)) - wr[r]) ** 2
            n += 1
        if n:
            err /= n
            if best is None or err < best[0]:
                best = (err, b, yc)
    return dict(yc0=yc0, a=a, b=best[1], yc=best[2], ybot=ybot, err=best[0],
                peak=al.max() / 255.0, rows=(rows_w[0], ybot),
                wr=[wr[r] for r in range(rows_w[0], ybot + 1)])


print('### idle, поворот 0 — по кадрам')
for i in range(6):
    f = fit_shadow('hero_idle_%d_0' % i)
    print('  idle_%d_0: a=%.1f b=%.1f yc=%.1f ybot=%d rows=%s widths=%s peak=%.2f'
          % (i, f['a'], f['b'], f['yc'], f['ybot'], f['rows'], f['wr'], f['peak']))
print('### idle, поворот 90')
for i in range(6):
    f = fit_shadow('hero_idle_%d_1' % i)
    print('  idle_%d_1: a=%.1f b=%.1f yc=%.1f ybot=%d widths=%s' % (i, f['a'], f['b'], f['yc'], f['ybot'], f['wr']))
print()
print('### альфа-профиль вдоль вертикали через центр, idle rot0 (все 6 кадров)')
for i in range(6):
    s = frame('hero_idle_%d_0' % i)
    blk = s[..., :3].max(axis=2) <= 8
    al = s[..., 3] * blk
    print('  idle_%d_0:' % i, ' '.join('%d:%d' % (r, al[r, 58]) for r in range(104, 121) if al[r, 58]))
print()
print('### какие кадры дают максимум/минимум a')
allfit = []
for nm in meta['frames']:
    f = fit_shadow(nm)
    if f:
        allfit.append((f['a'], f['b'], f['yc'], f['ybot'], nm))
allfit.sort()
print('  min a:', [(round(t[0], 1), round(t[1], 1), round(t[2], 1), t[4]) for t in allfit[:5]])
print('  max a:', [(round(t[0], 1), round(t[1], 1), round(t[2], 1), t[4]) for t in allfit[-5:]])
print('  медиана a=%.2f b=%.2f yc=%.2f ybot=%.1f' % (st.median([t[0] for t in allfit]),
                                                     st.median([t[1] for t in allfit]),
                                                     st.median([t[2] for t in allfit]),
                                                     st.median([t[3] for t in allfit])))
