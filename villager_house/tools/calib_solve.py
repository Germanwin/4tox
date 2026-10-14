"""calib_solve.py — решатель калибровки палитры дома (внешний python, Pillow).

    python3 tools/calib_solve.py            # посчитать и записать pal_cal.json
    python3 tools/calib_solve.py --dry      # только показать, не писать

Вход — два кадра из tools/calib_live.py:
    renders/calib_a.png   обычный канонный рендер (то, что уйдёт в спрайт);
    renders/calib_b.png   тот же кадр в плоских эмиссиях (карта «фасет -> слот»).

Для каждой пары (семейство, тон): собираем пиксели прохода A по маске её ID,
берём медиану и сравниваем с ЦЕЛЬЮ — канонным тоном атласа. Отношение
цель/медиана в ЛИНЕЙНОМ пространстве домножается на текущий базовый цвет.
Две итерации сводят палитру к канону (после правки геометрии — заново).

Здесь же считается ГЛАВНАЯ метрика стиль-гейта: доля пикселей объекта,
попавших в пределы 26 sRGB до ближайшего тона канона.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RENDERS = os.path.join(ROOT, 'renders')
CAL_JSON = os.path.join(HERE, 'pal_cal.json')
SKILL_PALETTE = ('/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/references/'
                 'palette.json')
TOL = 26.0                      # допуск стиль-гейта до тона канона, sRGB


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb(c):
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def canon_tones():
    with open(SKILL_PALETTE, encoding='utf-8') as f:
        pal = json.load(f)
    out = []
    for fam, t in pal['tones'].items():
        for i, k in enumerate(('light', 'mid', 'dark')):
            h = t[k].lstrip('#')
            out.append((fam, i, np.array([int(h[j:j + 2], 16) for j in (0, 2, 4)],
                                         dtype=np.float64)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--iter', type=int, default=0, help='номер итерации (для отчёта)')
    args = ap.parse_args()

    meta = json.load(open(os.path.join(RENDERS, 'calib_meta.json'),
                          encoding='utf-8'))
    ids = np.array(meta['ids'], dtype=np.float64)          # sRGB-цвета меток
    px_by_slot = {k: [] for k in range(len(meta['slots']))}
    n_ok = 0
    for pair in meta['pairs']:                             # все четыре поворота
        A = np.asarray(Image.open(os.path.join(RENDERS, pair['a']))
                       .convert('RGBA')).astype(np.float64)[..., :3]
        Bi = np.asarray(Image.open(os.path.join(RENDERS, pair['b']))
                        .convert('RGBA')).astype(np.float64)
        alpha = Bi[..., 3] / 255.0
        B = Bi[..., :3] / 255.0
        flat = B.reshape(-1, 3)
        # ближайший ID; расстояние больше 18 = кромка/AA или тень — мимо
        d = np.linalg.norm(flat[:, None, :] - ids[None, :, :], axis=2)
        best = d.argmin(axis=1)
        bestd = d[np.arange(len(flat)), best]
        ok = (bestd < 18.0) & (alpha.reshape(-1) > 0.99)
        n_ok += int(ok.sum())
        lab = np.where(ok, best, -1)
        apix = A.reshape(-1, 3)
        for k in range(len(meta['slots'])):
            sel = apix[lab == k]
            if len(sel):
                px_by_slot[k].append(sel)

    tones = canon_tones()
    cal = {}
    try:
        cal = json.load(open(CAL_JSON, encoding='utf-8'))
    except Exception:
        cal = {}

    print('пикселей с уверенной меткой: %d' % n_ok)
    rows = []
    for k, (fam, tone) in enumerate(meta['slots']):
        px = (np.concatenate(px_by_slot[k]) if px_by_slot[k]
              else np.zeros((0, 3)))
        n = int(len(px))
        if n < 400:
            rows.append(dict(fam=fam, tone=tone, n=n))
            continue
        med = np.median(px, axis=0)                        # sRGB 0..255
        tgt = np.array([int(meta['targets'][fam][tone].lstrip('#')[j:j + 2], 16)
                        for j in (0, 2, 4)], dtype=np.float64)
        dist = float(np.linalg.norm(med - tgt))
        near = np.linalg.norm(px - tgt, axis=1) <= TOL
        share = float(near.mean())
        # коррекция: во сколько раз медиана отличается от цели (в ЛИНЕЙНОМ)
        cur_hex = meta['base'][fam][tone]
        cur_lin = np.array([((cur_hex >> sh) & 255) / 255.0
                            for sh in (16, 8, 0)])
        med_lin = np.array([lin(c / 255.0) for c in med])
        tgt_lin = np.array([lin(c / 255.0) for c in tgt])
        k_corr = np.clip(tgt_lin / np.maximum(med_lin, 1e-4), 0.2, 9.0)
        new_lin = np.clip(cur_lin * k_corr, 0.0, 1.0)
        newhex = '#%02X%02X%02X' % tuple(int(round(c * 255)) for c in new_lin)
        rows.append(dict(fam=fam, tone=tone, n=n, med=med, tgt=tgt,
                         dist=dist, share=share, new=newhex,
                         kcorr=k_corr))

    good = [r for r in rows if 'med' in r and r['n'] >= 400]
    if good:
        ks = []
        for r in good:
            cur_lin = np.array([((meta['base'][r['fam']][r['tone']] >> sh) & 255)
                                / 255.0 for sh in (16, 8, 0)]) * r['kcorr']
            ks.append(cur_lin / np.maximum(np.array(
                [((meta['base'][r['fam']][r['tone']] >> sh) & 255) / 255.0
                 for sh in (16, 8, 0)]), 1e-6))
        med_k = np.median(np.array(ks), axis=0)
        print('общий коэффициент подъёма (медиана по крупным слотам): %s'
              % np.round(med_k, 3))
        for r in rows:
            if 'med' in r and r['n'] >= 400:
                continue
            fam, tone = r['fam'], r['tone']
            cur = np.array([((meta['base'][fam][tone] >> sh) & 255) / 255.0
                            for sh in (16, 8, 0)])
            new = np.clip(cur * med_k, 0.0, 1.0)
            cal.setdefault(fam, {})[str(tone)] = '#%02X%02X%02X' % tuple(
                int(round(c * 255)) for c in new)
            r['filled'] = True

    print('%-12s %-5s %7s  %-19s %-19s %6s %8s  %s'
          % ('семейство', 'тон', 'пикс', 'медиана спрайта', 'цель канона',
             'dRGB', 'в допуске', 'новый базовый (лин.)'))
    tot = totn = 0
    for r in rows:
        if 'med' not in r:
            print('%-12s %-5d %7d  малая площадь -> общий коэффициент: %s'
                  % (r['fam'], r['tone'], r['n'],
                     cal.get(r['fam'], {}).get(str(r['tone']), '-')))
            continue
        med, tgt = r['med'], r['tgt']
        cal.setdefault(r['fam'], {})[str(r['tone'])] = r['new']
        tot += r['share'] * r['n']
        totn += r['n']
        print('%-12s %-5d %7d  #%02X%02X%02X          #%02X%02X%02X          '
              '%6.1f %7.1f%%  %s'
              % (r['fam'], r['tone'], r['n'],
                 int(med[0]), int(med[1]), int(med[2]),
                 int(tgt[0]), int(tgt[1]), int(tgt[2]),
                 r['dist'], r['share'] * 100, r['new']))
    if totn:
        print('ИТОГО в допуске канона: %.1f%% (взвешенно по площади слотов)'
              % (100.0 * tot / totn))

    # --- метрика СТИЛЬ-ГЕЙТА: доля пикселей объекта в 26 sRGB до ЛЮБОГО тона
    tones_all = np.array([c for _, _, c in tones])
    tot = tot_ok = 0
    for pair in meta['pairs']:
        A = np.asarray(Image.open(os.path.join(RENDERS, pair['a']))
                       .convert('RGBA')).astype(np.float64)
        m = A[..., 3] > 40
        px = A[..., :3][m]
        if not len(px):
            continue
        dd = np.linalg.norm(px[:, None, :] - tones_all[None, :, :], axis=2)
        near = dd.min(axis=1) <= TOL
        tot += len(px)
        tot_ok += int(near.sum())
    print('ПАЛИТРА (как в стиль-гейте, ближайший тон из 18 семейств): '
          '%.1f%% пикселей объекта' % (100.0 * tot_ok / max(tot, 1)))

    if args.dry:
        print('--dry: pal_cal.json не тронут')
        return 0
    clean = {fam: {t: h for t, h in d.items() if h}
             for fam, d in cal.items()}
    clean = {fam: d for fam, d in clean.items() if d}
    with open(CAL_JSON, 'w', encoding='utf-8') as f:
        json.dump(clean, f, ensure_ascii=False, indent=1, sort_keys=True)
    print('записано: %s' % CAL_JSON)
    return 0


if __name__ == '__main__':
    sys.exit(main())
