import json, numpy as np, collections
from PIL import Image
A = '/Users/hermmoment/coding/4tox/mapgen2/assets/hero/'
meta = json.load(open(A + 'atlas.json'))
img = np.asarray(Image.open(A + 'atlas.png').convert('RGBA'))


def frame(n):
    f = meta['frames'][n]
    return img[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(int)


print('### A. рукоять топора: пиксели ROI x44..52, y76..94 на hero_idle_*_1 (180deg)')
cnt = collections.Counter()
for i in range(6):
    s = frame('hero_idle_%d_2' % i)
    for y in range(76, 95):
        for x in range(44, 53):
            p = s[y, x]
            if p[3] >= 200 and p[:3].max() > 8:
                cnt[tuple(p[:3])] += 1
for c, n in cnt.most_common(12):
    print('   #%02X%02X%02X' % c, n)

print()
print('### B. низ силуэта на walk: какие строки ниже 106 и что там')
for nm in ['hero_walk_0_0', 'hero_walk_4_0', 'hero_walk_0_2']:
    s = frame(nm)
    obj = (s[..., 3] > 8) & (s[..., :3].max(axis=2) > 8)
    rr = np.where(obj.any(axis=1))[0]
    print(' --', nm, 'obj rows', rr.min(), rr.max())
    for y in range(105, rr.max() + 2):
        c = np.where(obj[y])[0]
        if len(c):
            print('   y=%d n=%d x[%d..%d]' % (y, len(c), c.min(), c.max()))

print()
print('### C. тень: фит эллипса по нижней половине, 88 кадров')
FIT = []
for nm in meta['frames']:
    s = frame(nm)
    blk = s[..., :3].max(axis=2) <= 8
    al = s[..., 3] * blk
    if not al.any():
        continue
    rows = np.where(al.any(axis=1))[0]
    w = np.array([int((al[r] > 0).sum()) for r in range(al.shape[0])])
    wr = np.array([(lambda c: (c.max() - c.min() + 1) if len(c) else 0)(np.where(al[r] > 0)[0])
                   for r in range(al.shape[0])])
    rows_w = [r for r in rows if wr[r] > 0]
    # самая широкая строка = центр
    yc0 = max(rows_w, key=lambda r: wr[r])
    a = wr[yc0] / 2.0
    ybot = rows_w[-1]
    # подгонка b: центр yc = ybot - b, ширина w(y) = 2a*sqrt(1-((y-yc)/b)^2)
    best = None
    for b in np.arange(2.0, 9.01, 0.25):
        err = 0.0
        n = 0
        yc = ybot - b
        for r in rows_w:
            if r < yc:
                continue
            t = (r - yc) / b
            if abs(t) > 1:
                continue
            pred = 2 * a * np.sqrt(max(0.0, 1 - t * t))
            err += (pred - wr[r]) ** 2
            n += 1
        if n:
            err /= n
            if best is None or err < best[0]:
                best = (err, b, yc)
    xc = np.mean([(lambda c: (c.min() + c.max()) / 2)(np.where(al[yc0] > 0)[0])])
    # профиль альфы вдоль большой оси от центра
    prof = []
    row = al[yc0]
    for dx in range(0, int(a) + 1):
        x = int(round(xc)) + dx
        if 0 <= x < al.shape[1] and row[x] > 0:
            prof.append((dx / a, row[x] / 255.0))
    FIT.append(dict(name=nm, a=a, b=best[1], yc=best[2], ybot=ybot, xc=xc,
                    peak=al.max() / 255.0, err=best[0],
                    top_est=best[2] - best[1], prof=prof))
import statistics as st
print('  a  медиана %.2f  разброс %.2f..%.2f' % (st.median([f['a'] for f in FIT]),
                                                 min(f['a'] for f in FIT), max(f['a'] for f in FIT)))
print('  b  медиана %.2f  разброс %.2f..%.2f' % (st.median([f['b'] for f in FIT]),
                                                 min(f['b'] for f in FIT), max(f['b'] for f in FIT)))
print('  yc медиана %.1f (якорь 106)  разброс %.0f..%.0f' % (st.median([f['yc'] for f in FIT]),
                                                            min(f['yc'] for f in FIT), max(f['yc'] for f in FIT)))
print('  xc-56 медиана %.2f  разброс %.1f..%.1f' % (st.median([f['xc'] - 56 for f in FIT]),
                                                    min(f['xc'] - 56 for f in FIT), max(f['xc'] - 56 for f in FIT)))
print('  peak медиана %.3f  разброс %.3f..%.3f' % (st.median([f['peak'] for f in FIT]),
                                                   min(f['peak'] for f in FIT), max(f['peak'] for f in FIT)))
allsd = 0.0
prof_ac = collections.defaultdict(list)
for f in FIT:
    for rho, v in f['prof']:
        prof_ac[round(rho, 2)].append(v)
print('  профиль альфы в долях радиуса (медиана):')
for k in sorted(prof_ac):
    if k <= 1.0:
        print('     rho=%.2f  alpha=%.3f  n=%d' % (k, st.median(prof_ac[k]), len(prof_ac[k])))
print('  вертикальный профиль (вдоль малой оси) для rot0:')
s = frame('hero_idle_0_0')
blk = s[..., :3].max(axis=2) <= 8
al = s[..., 3] * blk
for r in range(106, 120):
    c = np.where(al[r] > 0)[0]
    if len(c):
        print('     y=%d peak=%d xc=%.1f' % (r, al[r].max(), (c.min() + c.max()) / 2))
