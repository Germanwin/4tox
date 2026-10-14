import json, numpy as np, collections, statistics as st
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


print('### B2. что за объектные пиксели справа на walk_0_0 (y=105..111, x=70..82)')
s = frame('hero_walk_0_0')
for y in range(104, 112):
    print(' y=%d' % y, [(x, tuple(int(v) for v in s[y, x])) for x in range(68, 82) if s[y, x, 3] > 8])

print()
print('### B3. bbox по анимациям (obj) — есть ли выбросы вправо')
for nm in sorted(meta['frames']):
    f = meta['frames'][nm]
    if nm.endswith('_0') or nm.endswith('_1'):
        pass
for nm in ['hero_walk_0_0', 'hero_walk_1_0', 'hero_walk_2_0', 'hero_walk_3_0',
           'hero_walk_4_0', 'hero_walk_5_0', 'hero_walk_6_0', 'hero_walk_7_0']:
    s = frame(nm)
    obj = (s[..., 3] > 8) & (s[..., :3].max(axis=2) > 8)
    c = np.where(obj.any(axis=0))[0]
    r = np.where(obj.any(axis=1))[0]
    print('  %-16s x[%d..%d] y[%d..%d]' % (nm, c.min(), c.max(), r.min(), r.max()))

print()
print('### C2. тень по анимациям: a, b, ybot, yc, xc-56')
agg = collections.defaultdict(list)
for nm in meta['frames']:
    s = frame(nm)
    blk = s[..., :3].max(axis=2) <= 8
    al = s[..., 3] * blk
    if not al.any():
        continue
    rows_w = [r for r in range(al.shape[0]) if (al[r] > 0).any()]
    wr = {r: (lambda c: (c.max() - c.min() + 1) if len(c) else 0)(np.where(al[r] > 0)[0]) for r in rows_w}
    yc0 = max(rows_w, key=lambda r: wr[r])
    a = wr[yc0] / 2.0
    ybot = rows_w[-1]
    best = None
    for b in np.arange(2.0, 9.01, 0.25):
        err, n, yc = 0.0, 0, ybot - b
        for r in rows_w:
            if r < yc:
                continue
            t = (r - yc) / b
            if abs(t) > 1:
                continue
            err += (2 * a * np.sqrt(max(0.0, 1 - t * t)) - wr[r]) ** 2
            n += 1
        if n:
            err /= n
            if best is None or err < best[0]:
                best = (err, b, yc)
    c0 = np.where(al[yc0] > 0)[0]
    f = meta['frames'][nm]
    agg[(f['anim'], f['rotation'])].append((a, best[1], yc, ybot, (c0.min() + c0.max()) / 2 - 56,
                                            al.max() / 255.0))
for k in sorted(agg):
    v = agg[k]
    med = lambda i: st.median([t[i] for t in v])   # noqa: E731
    rng = lambda i: (min(t[i] for t in v), max(t[i] for t in v))   # noqa: E731
    print('  %-6s %3d  a=%.1f %s  b=%.1f %s  yc=%.1f %s  ybot=%.0f %s  xc-56=%.1f  peak=%.2f'
          % (k[0], k[1], med(0), tuple(round(x, 1) for x in rng(0)), med(1),
             tuple(round(x, 1) for x in rng(1)), med(2),
             (round(rng(2)[0]), round(rng(2)[1])), med(3), (round(rng(3)[0]), round(rng(3)[1])),
             med(4), med(5)))
