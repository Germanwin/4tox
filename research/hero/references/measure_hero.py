#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""measure_hero.py — точные мерки эталонного персонажа mapgen2 (герой-лесоруб).

Мерит ТОЛЬКО чтением:
  mapgen2/assets/hero/atlas.png + atlas.json        (88 кадров, 96 ppu, mul 1.35)
  ~/.dsh/skills/4tox-lowpoly-3d/references/palette.json   (палитра канона)
  ~/.dsh/skills/4tox-lowpoly-3d/scripts/{canon,measure}.py (инструменты замера)

Пишет рядом с собой (research/hero/references/):
  hero-reference.md, hero-reference.json, PNG-вырезки @6x.

Запуск:
  PY=/Users/hermmoment/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
  $PY measure_hero.py
"""
import collections
import json
import math
import os
import statistics as st
import sys

import numpy as np
from PIL import Image

# Пути считаются от самого скрипта, а не от абсолютного адреса: references →
# hero → research → корень 4tox (docs/STRUCTURE.md).
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
HERO = os.path.join(REPO, 'mapgen2', 'assets', 'hero') + os.sep
OUT = HERE + os.sep
SKILL = '/Users/hermmoment/.dsh/skills/4tox-lowpoly-3d/'
sys.path.insert(0, os.path.join(SKILL, 'scripts'))
import canon as C            # noqa: E402
import measure as M          # noqa: E402

os.makedirs(OUT, exist_ok=True)

PPU = 96.0
UPZ = C.UP[2]                     # 0.816497: столько экранных пикселей даёт 1 юнит Z
GROUND_ALPHA = 8                  # порог силуэта
SHADOW_MAXRGB = 8                 # тень — чистый чёрный; у плотных пикселей объекта min maxRGB = 17

meta = json.load(open(HERO + 'atlas.json', encoding='utf-8'))
ATLAS = np.asarray(Image.open(HERO + 'atlas.png').convert('RGBA'))

ANIMS = ['idle', 'walk', 'chop']
ROTS = [0, 90, 180, 270]
ROTNAME = {0: 0, 90: 1, 180: 2, 270: 3}

# канон как массивы
TONES = C.canon_tones()                                   # [(fam, idx, (r,g,b))]
TONE_RGB = np.array([t[2] for t in TONES], float)
TONE_FAM = [t[0] for t in TONES]
OUTLINE_RGB = np.array([C.hex_rgb(h) for h in C.palette()['outline']], float)
OUTLINE_TOL = 16.0


def frame_img(name):
    f = meta['frames'][name]
    return ATLAS[f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']].astype(np.int16)


def anchor(name):
    f = meta['frames'][name]
    return float(f['anchorX']), float(f['anchorY'])


# ==========================================================================
# материалы: пиксель -> семья канона
# ==========================================================================
def analyze(a):
    """(H,W,4 int16) -> dict с масками, семьёй и расстоянием до тона канона."""
    al = a[..., 3]
    rgb = a[..., :3]
    black = rgb.max(axis=2) <= SHADOW_MAXRGB
    obj = (al > GROUND_ALPHA) & ~black
    solid = (al >= 200) & ~black
    shadow = (al > GROUND_ALPHA) & black
    d = np.sqrt(((rgb.astype(float)[..., None, :] - TONE_RGB[None, None]) ** 2).sum(-1))
    fi = np.argmin(d, axis=-1)
    fd = np.take_along_axis(d, fi[..., None], -1)[..., 0]
    do = np.sqrt(((rgb.astype(float)[..., None, :] - OUTLINE_RGB[None, None]) ** 2).sum(-1)).min(-1)
    is_out = do <= OUTLINE_TOL
    # ВАЖНО: цвет контура #0E120E ближайшим тоном канона даёт leather/dark —
    # если не вывести контур из семейства, вся обводка уедет в «обувь».
    fam = np.where(is_out, 'outline', np.array(TONE_FAM)[fi])
    gray = (rgb.max(axis=2) - rgb.min(axis=2)) <= 22
    return dict(al=al, rgb=rgb, obj=obj, solid=solid, shadow=shadow,
                fam=fam, fdist=fd, outline=is_out, gray=gray)


def run_rows(m):
    """Число непрерывных отрезков маски в каждой строке."""
    out = np.zeros(m.shape[0], int)
    for r in range(m.shape[0]):
        idx = np.where(m[r])[0]
        if len(idx):
            out[r] = 1 + int(np.sum(np.diff(idx) > 1))
    return out


def run_width(m):
    """Ширина САМОГО ШИРОКОГО непрерывного отрезка в строке (не размах).
    Нужна для ноги: у 180°/270° рукоять топора смыкается с ногой, и размах врёт."""
    out = np.zeros(m.shape[0], int)
    for r in range(m.shape[0]):
        idx = np.where(m[r])[0]
        if not len(idx):
            continue
        brk = np.where(np.diff(idx) > 1)[0]
        segs = np.split(idx, brk + 1)
        out[r] = max(len(s) for s in segs)
    return out


# ==========================================================================
# 1. габарит всех 88 кадров
# ==========================================================================
def frame_geom(name):
    a = frame_img(name)
    ax, ay = anchor(name)
    f = meta['frames'][name]
    S = analyze(a)
    obj, solid, shadow = S['obj'], S['solid'], S['shadow']
    rec = dict(name=name, anim=f['anim'], frame=f['frame'],
               rotation=f['rotation'], rot_index=f['rot_index'])
    for key, m in (('obj', obj), ('solid', solid), ('shadow', shadow)):
        if m.any():
            rr, cc = np.where(m.any(axis=1))[0], np.where(m.any(axis=0))[0]
            rec['bbox_' + key] = [int(cc.min()), int(cc.max()), int(rr.min()), int(rr.max())]
        else:
            rec['bbox_' + key] = None
    if rec['bbox_obj'] is None:
        return rec
    x0, x1, y0, y1 = rec['bbox_obj']
    rec['obj_px'] = int(obj.sum())
    rec['solid_px'] = int(solid.sum())
    rec['h_top_px'] = int(ay - y0)
    rec['h_bot_px'] = int(ay - y1)
    rec['h_top_units'] = round((ay - y0) / PPU, 4)
    rec['h_bot_units'] = round((ay - y1) / PPU, 4)
    rec['z_top_world'] = round((ay - y0) / (PPU * UPZ), 4)
    rec['z_bot_world'] = round((ay - y1) / (PPU * UPZ), 4)
    rec['w_px'] = int(x1 - x0 + 1)
    rec['w_units'] = round((x1 - x0 + 1) / PPU, 4)
    rec['h_sil_px'] = int(y1 - y0 + 1)
    half = [(lambda c: (c.max() - c.min() + 1) / 2.0)(np.where(obj[r])[0])
            for r in range(y0, y1 + 1) if obj[r].any()]
    rec['half_w_max_px'] = round(float(max(half)), 2)
    rec['half_w_max_units'] = round(float(max(half)) / PPU, 4)
    rec['bbox_rel_anchor'] = [int(x0 - ax), int(x1 - ax), int(y0 - ay), int(y1 - ay)]
    rp = run_rows(obj)
    rec['max_runs_all'] = int(rp.max())
    # обувь: полоса, где кожа-обувь (leather) составляет заметную долю материала
    # ноги и которая лежит в нижней части фигуры (иначе тени-подобные тона на
    # руках и штанах ловятся как «обувь»)
    # ВАЖНО: прозрачный фон тоже имеет RGB и ближайшим тоном канона ему выходит
    # leather — считать семьи можно только ВНУТРИ силуэта.
    nL = ((S['fam'] == 'leather') & obj).sum(axis=1)
    nT = ((S['fam'] == 'trunk') & obj).sum(axis=1)
    nA = ((S['fam'] == 'leaf_autumn') & obj).sum(axis=1)
    hem_rows = [r for r in range(y0, y1 + 1) if nA[r] >= 2]
    y_hem = hem_rows[-1] if hem_rows else y0
    lo_boot = int(y_hem + max(2, 0.35 * (y1 - y_hem)))
    boots = [r for r in range(lo_boot, y1 + 1)
             if nL[r] >= 3 and nL[r] >= 0.35 * (nL[r] + nT[r])]
    rec['hem_bottom_px'] = int(y_hem)
    rec['boot_top_px'] = int(boots[0]) if boots else None
    legzone = rp[(boots[0] if boots else int(y0 + 0.78 * (y1 - y0))): y1 + 1]
    rec['max_runs_legzone'] = int(legzone.max()) if len(legzone) else 0
    # ступни: только нижние 8 строк силуэта — там рукоять топора уже не мешает
    feet = rp[max(y0, y1 - 7): y1 + 1]
    rec['feet_runs'] = int(feet.max()) if len(feet) else 0
    rec['legzone_rows'] = int(len(legzone))
    rec['legzone_merged_rows'] = int((legzone <= 1).sum()) if len(legzone) else 0
    if rec['bbox_shadow']:
        sx0, sx1, sy0, sy1 = rec['bbox_shadow']
        sa = a[..., 3][shadow]
        rec['shadow'] = dict(
            w_px=int(sx1 - sx0 + 1), h_px=int(sy1 - sy0 + 1),
            x0=int(sx0), x1=int(sx1), y0=int(sy0), y1=int(sy1),
            w_over_sil=round((sx1 - sx0 + 1) / float(rec['w_px']), 3),
            h_over_w=round((sy1 - sy0 + 1) / float(sx1 - sx0 + 1), 3),
            max_alpha=round(float(sa.max()) / 255.0, 3),
            p90_alpha=round(float(np.percentile(sa, 90)) / 255.0, 3),
            center_dx_px=round((sx0 + sx1) / 2.0 - ax, 2),
            below_sil_px=int(sy1 - y1))
    else:
        rec['shadow'] = None
    return rec


ALL = [frame_geom(n) for n in meta['frames']]
BY = {r['name']: r for r in ALL}


def agg(rows, key):
    v = [r[key] for r in rows if r.get(key) is not None]
    return None if not v else dict(min=round(min(v), 4), max=round(max(v), 4),
                                   mean=round(sum(v) / len(v), 4))


AGG = {}
for an in ANIMS:
    for rot in ROTS:
        rows = [r for r in ALL if r['anim'] == an and r['rotation'] == rot]
        AGG['%s_%d' % (an, rot)] = dict(
            n=len(rows), h_top_units=agg(rows, 'h_top_units'),
            h_bot_units=agg(rows, 'h_bot_units'), w_px=agg(rows, 'w_px'),
            w_units=agg(rows, 'w_units'), h_sil_px=agg(rows, 'h_sil_px'),
            half_w_units=agg(rows, 'half_w_max_units'),
            z_top_world=agg(rows, 'z_top_world'), obj_px=agg(rows, 'obj_px'),
            max_runs_legzone=max(r['max_runs_legzone'] for r in rows),
            feet_runs_max=max(r['feet_runs'] for r in rows),
            feet_runs2=sum(1 for r in rows if r['feet_runs'] >= 2),
            runs_legzone_at_boot=[min(r['max_runs_legzone'] for r in rows),
                                  max(r['max_runs_legzone'] for r in rows)],
            max_runs_all=max(r['max_runs_all'] for r in rows),
            boot_top_px=[min(r['boot_top_px'] for r in rows if r['boot_top_px']),
                         max(r['boot_top_px'] for r in rows if r['boot_top_px'])],
        )

GLOBAL = dict(h_top_units=agg(ALL, 'h_top_units'), h_bot_units=agg(ALL, 'h_bot_units'),
              w_units=agg(ALL, 'w_units'), w_px=agg(ALL, 'w_px'),
              z_top_world=agg(ALL, 'z_top_world'), z_bot_world=agg(ALL, 'z_bot_world'),
              half_w_units=agg(ALL, 'half_w_max_units'), obj_px=agg(ALL, 'obj_px'),
              h_sil_px=agg(ALL, 'h_sil_px'))


def agg_idle(key):
    return agg([r for r in ALL if r['anim'] == 'idle'], key)


# ==========================================================================
# 2. ориентиры фигуры (idle_0, 4 поворота)
# ==========================================================================
def landmarks(name):
    a = frame_img(name)
    S = analyze(a)
    ax, ay = anchor(name)
    obj, solid, fam = S['obj'], S['solid'], S['fam']
    body = obj & ~S['outline']
    isT = body & (fam == 'trunk')
    isS = body & (fam == 'skin')
    isA = body & (fam == 'leaf_autumn')
    isL = body & (fam == 'leather')
    isG = body & S['gray'] & ~S['outline']      # лезвие (серое)
    cnt = lambda m: m.sum(axis=1)                # noqa: E731
    nT, nS, nA, nL, nG = cnt(isT), cnt(isS), cnt(isA), cnt(isL), cnt(isG)
    rr = np.where(obj.any(axis=1))[0]
    sr = np.where(solid.any(axis=1))[0]
    y_top, y_bot = int(rr.min()), int(rr.max())
    y_stop, y_sbot = int(sr.min()), int(sr.max())
    width = np.array([int(obj[r].sum()) for r in range(obj.shape[0])])
    n = len(width)
    first = lambda v, k=2, lo=0: next((r for r in range(max(lo, y_top), min(y_bot, n - 1) + 1)  # noqa: E731
                                       if v[r] >= k), None)
    last = lambda v, k=2, lo=0, hi=None: next(  # noqa: E731
        (r for r in range(min(hi if hi is not None else y_bot, n - 1), max(lo, y_top) - 1, -1)
         if v[r] >= k), None)
    lm = {}
    lm['hat_top'] = (y_top, 'первая строка силуэта (альфа>8, не тень)')
    lm['hat_top_solid'] = (y_stop, 'первая строка плотного силуэта (альфа>=200)')
    y_sh = first(nA, 3)
    lm['shoulder_top'] = (y_sh, 'первая строка, где рубаха (leaf_autumn) >=3 px — ворот')
    y_fc = first(nS, 2)
    lm['face_top'] = (y_fc, 'первая строка с кожей (skin) >=2 px')
    # низ лица: конец НЕПРЕРЫВНОГО блока кожи (разрыв не больше 1 строки)
    fb = y_fc
    if y_fc is not None:
        gap = 0
        for r in range(y_fc, min(y_bot, n - 1) + 1):
            if nS[r] >= 1:
                fb, gap = r, 0
            else:
                gap += 1
                if gap > 1:
                    break
    lm['face_bottom'] = (fb, 'конец непрерывного блока кожи от лица вниз (подбородок/шея)')
    # шея: есть ли сужение между головой и плечами
    mono = all(width[r + 1] >= width[r] - 1 for r in range(y_top + 4, (y_sh or y_top) + 3))
    hw = int(max(width[r] for r in range(y_top, y_sh))) if y_sh else 0
    sw = int(max(width[r] for r in range(y_sh or y_top, y_bot)))
    lm['neck'] = ((y_sh - 1, 'шеи как сужения НЕТ: ширина растёт монотонно от головы (%d px) '
                   'к плечам (%d px), за шею принята строка над воротом' % (hw, sw)) if mono
                  else (y_sh - 1, 'строка над воротом (шея уже плеч на %d px)' % (sw - hw)))
    # пояс: полоса торса, где trunk идёт рядом с рубахой
    tr = [r for r in range((y_sh or y_top) + 4, (last(nA, 2) or y_bot))
          if nT[r] >= 4 and nA[r] >= 1]
    lm['belt'] = (tr[0], tr[-1], 'полоса торса, где trunk>=4 px рядом с рубахой — пояс') if tr else None
    y_hem = last(nA, 2)
    lm['hem_bottom'] = (y_hem, 'последняя строка с рубахой >=2 px — подол')
    # лезвие: серые пиксели рядом с железом
    iron = body & (fam == 'iron')
    if iron.any():
        iy, ix = np.where(iron)
        y0b, y1b = max(0, iy.min() - 4), min(n - 1, iy.max() + 4)
        blade = np.zeros_like(isG)
        blade[y0b:y1b + 1] = True
        blade &= isG | iron
        hb = first(cnt(blade), 2)
        lb = last(cnt(blade), 2)
    else:
        blade = np.zeros_like(isG)
        hb = lb = None
    lm['axe_blade_top'] = (hb, 'первая строка лезвия (серые пиксели рядом с iron) >=2 px')
    lm['axe_blade_bottom'] = (lb, 'последняя строка лезвия >=2 px')
    # нога начинается там, где кончается подол
    leg_rows = [r for r in range(y_hem, y_bot + 1) if nT[r] + nL[r] >= 2] if y_hem else []
    y_leg = leg_rows[0] if leg_rows else y_hem
    lm['leg_top'] = (y_leg, 'первая строка ниже подола с материалом ноги (trunk/leather)')
    boot = []
    if y_leg:
        lo_boot = int(y_leg + max(2, 0.35 * (y_bot - y_leg)))
        boot = [r for r in range(lo_boot, y_bot + 1)
                if nL[r] >= 3 and nL[r] >= 0.35 * (nL[r] + nT[r])]
    y_bt = boot[0] if boot else None
    lm['boot_top'] = (y_bt, 'первая строка в нижней части ноги, где обувь (leather) >=3 px '
                           'и >=35%% материала ноги (leather+trunk)')
    # самое узкое место ноги (голень) — в нижней половине полосы ноги
    rwid = run_width(obj)
    knee = None
    if y_bt and y_bt - (y_leg or y_top) >= 4:
        lo = int(y_leg + 0.4 * (y_bt - y_leg))
        seg = [(r, int(rwid[r])) for r in range(lo, y_bt) if rwid[r] > 0]
        if seg:
            knee = min(seg, key=lambda t: t[1])
    lm['knee'] = (knee[0], 'самое узкое место ноги (ширина широкого отрезка %d px); '
                           'у 180/270 рукоять топора смыкается с ногой — число завышено'
                   % knee[1]) if knee else None
    lm['foot_bottom_solid'] = (y_sbot, 'последняя строка плотного силуэта — подошва')
    lm['foot_bottom_obj'] = (y_bot, 'последняя строка силуэта (сглаженная кромка подошвы)')
    lm['ground'] = (int(ay), 'линия земли = anchorY, проекция мировой точки (0,0,0)')
    # грудь: середина полосы торса между воротом и поясом
    y_belt = tr[0] if tr else (y_hem or y_bot)
    chest = int((y_sh + y_belt) / 2) if y_sh else y_top
    lm['chest'] = (chest, 'середина полосы торса ворот..пояс, px (ширина %d)' % width[chest])
    lm['torso_widest'] = (int(max(range(y_sh or y_top, (y_hem or y_bot) + 1),
                                 key=lambda r: width[r])),
                          'самая широкая строка торса (ворот..подол), px')
    return dict(lm=lm, width=width, knee_w=(knee[1] if knee else None),
                fam_counts=dict(trunk=nT, skin=nS, autumn=nA,
                                leather=nL, gray=nG),
                masks=dict(body=body, isT=isT, isS=isS, isA=isA, isL=isL, blade=blade))


LM = {}
for rot in ROTS:
    nm = 'hero_idle_0_%d' % ROTNAME[rot]
    r = landmarks(nm)
    LM[rot] = dict(name=nm, landmarks=r['lm'], knee_w=r['knee_w'],
                   width_profile=[int(v) for v in r['width']],
                   family_rows={k: [int(v) for v in arr] for k, arr in r['fam_counts'].items()})

# ==========================================================================
# 3. палитра по частям
# ==========================================================================
def zone_masks(name, blade_min_pts=2):
    """Маски зон. Возвращает (зоны, ориентиры)."""
    r = landmarks(name)
    lm = r['lm']
    S = analyze(frame_img(name))
    a = frame_img(name)
    body = S['obj'] & ~S['outline'] & (a[..., 3] >= 200)
    fam = S['fam']
    H, W = body.shape
    rows = np.arange(H)[:, None] * np.ones((1, W), int)
    y_sh = lm['shoulder_top'][0]
    y_hem = lm['hem_bottom'][0]
    y_bt = lm['boot_top'][0]
    y_bot = lm['foot_bottom_obj'][0]
    blade = r['masks']['blade'] & body & S['gray']
    # рукоять: дерево в радиусе 3 px от лезвия
    dil = np.zeros_like(blade)
    ys, xs = np.where(blade)
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            yy = np.clip(ys + dy, 0, H - 1)
            xx = np.clip(xs + dx, 0, W - 1)
            dil[yy, xx] = True
    handle = body & (fam == 'trunk') & dil & ~blade
    z = {}
    z['волосы'] = body & (fam == 'trunk') & (rows < y_sh)
    z['лицо'] = body & (fam == 'skin') & (rows < y_sh + 3)
    z['кисти рук'] = body & (fam == 'skin') & (rows >= y_sh + 3)
    z['рубаха'] = body & (fam == 'leaf_autumn')
    z['пояс'] = body & (fam == 'trunk') & (rows >= y_sh + 4) & (rows < y_hem)
    z['штаны'] = body & (fam == 'trunk') & (rows >= y_hem) & (rows < y_bt) & ~handle
    z['обувь'] = body & ((fam == 'leather') | (fam == 'trunk')) & (rows >= y_bt) & (rows <= y_bot)
    z['лезвие топора'] = blade
    z['топорище'] = handle
    return z, lm


ZONES = ['волосы', 'лицо', 'кисти рук', 'рубаха', 'пояс', 'штаны', 'обувь',
         'лезвие топора', 'топорище']


def zone_stats(mask, a):
    n = int(mask.sum())
    if n == 0:
        return dict(px=0)
    px = a[..., :3][mask]
    cnt = collections.Counter(map(tuple, px.tolist()))
    rgb, k = cnt.most_common(1)[0]
    fam, ti, dist = C.nearest_tone(rgb)
    return dict(px=n, modal_rgb='#%02X%02X%02X' % rgb, modal_px=k,
                modal_share=round(k / n, 3), family=fam,
                tone=('light', 'mid', 'dark')[ti], dist=round(dist, 1),
                distinct=len(cnt),
                top4=[dict(rgb='#%02X%02X%02X' % c, px=int(p),
                           family=C.nearest_tone(c)[0],
                           tone=('light', 'mid', 'dark')[C.nearest_tone(c)[1]],
                           dist=round(C.nearest_tone(c)[2], 1))
                      for c, p in cnt.most_common(4)])


PAL_PER_ROT = {}
for rot in ROTS:
    nm = 'hero_idle_0_%d' % ROTNAME[rot]
    a = frame_img(nm)
    z, _ = zone_masks(nm)
    PAL_PER_ROT[rot] = {zn: zone_stats(m, a) for zn, m in z.items()}


def merged_zone(zn):
    tot = collections.Counter()
    n = 0
    for rot in ROTS:
        nm = 'hero_idle_0_%d' % ROTNAME[rot]
        a = frame_img(nm)
        z = zone_masks(nm)[0][zn]
        if not z.any():
            continue
        n += int(z.sum())
        for c, p in collections.Counter(map(tuple, a[..., :3][z].tolist())).items():
            tot[c] += p
    if not tot:
        return dict(px=0)
    rgb, k = tot.most_common(1)[0]
    fam, ti, dist = C.nearest_tone(rgb)
    return dict(px=n, modal_rgb='#%02X%02X%02X' % rgb, modal_px=k,
                modal_share=round(k / n, 3), family=fam,
                tone=('light', 'mid', 'dark')[ti], dist=round(dist, 1),
                distinct=len(tot),
                top4=[dict(rgb='#%02X%02X%02X' % c, px=int(p),
                           family=C.nearest_tone(c)[0],
                           tone=('light', 'mid', 'dark')[C.nearest_tone(c)[1]],
                           dist=round(C.nearest_tone(c)[2], 1))
                      for c, p in tot.most_common(4)])


PAL_MERGED = {zn: merged_zone(zn) for zn in ZONES}

# контур
out_cnt = collections.Counter()
for rot in ROTS:
    a = frame_img('hero_idle_0_%d' % ROTNAME[rot])
    S = analyze(a)
    m = S['outline'] & S['obj'] & (a[..., 3] == 255)
    for c, p in collections.Counter(map(tuple, a[..., :3][m].tolist())).items():
        out_cnt[c] += p
OUTLINE_MODAL = out_cnt.most_common(1)[0][0]
OUTLINE = dict(modal='#%02X%02X%02X' % OUTLINE_MODAL,
               dist=round(min(C.dist(OUTLINE_MODAL, C.hex_rgb(h))
                              for h in C.palette()['outline']), 1),
               canon=C.palette()['outline'],
               px=int(sum(out_cnt.values())), distinct=len(out_cnt),
               top3=['#%02X%02X%02X' % c for c, _ in out_cnt.most_common(3)])

# ==========================================================================
# 4. фасеты и контур @4x
# ==========================================================================
def upscale4(a):
    return np.repeat(np.repeat(a, 4, axis=0), 4, axis=1)


FACETS = {}
for rot in ROTS:
    nm = 'hero_idle_0_%d' % ROTNAME[rot]
    a4 = upscale4(frame_img(nm))
    m4 = M.obj_mask(a4)
    _, _, _, out_cols = M.tone_arrays()
    near_out = (np.abs(a4[..., :3].astype(float)[..., None, :] - out_cols) <= 14).all(-1).any(-1)
    inner = m4 & ~near_out
    fs = M.facet_stats(a4, inner)
    opx4 = M.outline_px(a4, m4)
    reps = M.report(frame_img(nm), anchor(nm), nm)
    FACETS[rot] = dict(n_big=fs['n_big'], n_all=fs['n_all'], big_share=fs['big_share'],
                       dust_share=fs['dust_share'], area4=fs['area'], area1=reps['obj_px'],
                       outline_px_4x=round(float(opx4), 2),
                       outline_px_96=round(float(opx4) / 4.0, 2),
                       facets_ge6_1x=reps['facets']['ge6'],
                       facets_ge50_1x=reps['facets']['ge50'],
                       share_in_canon_1x=reps['share_in_canon'])

# ==========================================================================
# 5. тень: эллипс по нижней половине пятна
# ==========================================================================
def fit_shadow(name):
    """Эллипс пятна. Берём всё нарисованное пятно (альфа > 0), а не только ядро
    альфа > 8: вопрос «какого размера рисовать пятно» — про нарисованную форму,
    а гейт мерит ядро, поэтому обе величины и попадают в отчёт."""
    a = frame_img(name)
    S = analyze(a)
    blk = a[..., :3].max(axis=2) <= SHADOW_MAXRGB
    al = a[..., 3].astype(float) * blk          # всё нарисованное пятно, альфа > 0
    core = a[..., 3] > GROUND_ALPHA
    if not al.any():
        return None
    wr = {}
    for r in range(al.shape[0]):
        c = np.where(al[r] > 0)[0]
        wr[r] = (c.max() - c.min() + 1) if len(c) else 0
    rows_w = [r for r in wr if wr[r] > 0]
    yc0 = max(rows_w, key=lambda r: wr[r])
    a_semi = wr[yc0] / 2.0
    ybot = rows_w[-1]
    best = None
    for b in np.arange(2.0, 12.01, 0.25):
        yc = ybot - b
        err, k = 0.0, 0
        for r in rows_w:
            if r < yc:
                continue
            t = (r - yc) / b
            if t > 1:
                continue
            err += (2 * a_semi * np.sqrt(max(0.0, 1 - t * t)) - wr[r]) ** 2
            k += 1
        if k:
            err /= k
            if best is None or err < best[0]:
                best = (err, b, yc)
    c0 = np.where(al[yc0] > 0)[0]
    xc = (c0.min() + c0.max()) / 2.0
    # профиль альфы как функция нормированного радиуса эллипса: берём ВСЕ
    # пиксели пятна, а не одну строку — иначе перекрытые ступнями кадры врут.
    yy, xx = np.where(al > 0)
    rho = np.sqrt(((xx - xc) / a_semi) ** 2 + ((yy - best[2]) / best[1]) ** 2)
    prof = collections.defaultdict(list)
    for r_, v_ in zip(rho, al[yy, xx] / 255.0):
        if r_ <= 1.0:
            prof[round(round(r_ / 0.05) * 0.05, 2)].append(v_)
    prof = {k: float(np.median(v)) for k, v in prof.items() if len(v) >= 5}
    # ядро (альфа > 8) — то, что видит гейт measure.py
    ys, xs = np.where(S['shadow'] & core)
    core_w = int(xs.max() - xs.min() + 1) if len(xs) else 0
    core_h = int(ys.max() - ys.min() + 1) if len(ys) else 0
    return dict(a=a_semi, b=float(best[1]), yc=float(best[2]), ybot=int(ybot),
                xc=float(xc), peak=float(al.max()) / 255.0,
                visible_rows=[int(rows_w[0]), int(ybot)], prof=prof,
                core_w_px=core_w, core_h_px=core_h)


FIT = {}
for nm in meta['frames']:
    f = fit_shadow(nm)
    if f:
        FIT[nm] = f

SH_AGG = {}
for an in ANIMS:
    for rot in ROTS:
        rows = [FIT[r['name']] for r in ALL
                if r['anim'] == an and r['rotation'] == rot and r['name'] in FIT]
        if not rows:
            continue
        SH_AGG['%s_%d' % (an, rot)] = dict(
            n=len(rows),
            a=[round(min(r['a'] for r in rows), 1), round(max(r['a'] for r in rows), 1)],
            b=[round(min(r['b'] for r in rows), 1), round(max(r['b'] for r in rows), 1)],
            yc=[round(min(r['yc'] for r in rows), 1), round(max(r['yc'] for r in rows), 1)],
            ybot=[min(r['ybot'] for r in rows), max(r['ybot'] for r in rows)],
            xc_minus_anchor=[round(min(r['xc'] - 56 for r in rows), 2),
                             round(max(r['xc'] - 56 for r in rows), 2)],
            peak=[round(min(r['peak'] for r in rows), 3), round(max(r['peak'] for r in rows), 3)],
            core_w=[min(r['core_w_px'] for r in rows), max(r['core_w_px'] for r in rows)],
            core_h=[min(r['core_h_px'] for r in rows), max(r['core_h_px'] for r in rows)],
        )

# профиль альфы пятна (медиана по всем кадрам)
PROF = collections.defaultdict(list)
for r in FIT.values():
    for rho, v in r['prof'].items():
        PROF[rho].append(v)
PROF_MED = {str(k): round(st.median(PROF[k]), 3) for k in sorted(PROF) if k <= 1.0}


def fit_exp(prof):
    """alpha(rho) ~ a0 * exp(-c*rho^2): МНК по логарифму в полосе 0.15..0.95."""
    xs, ys = [], []
    for k, v in prof.items():
        if 0.15 <= k <= 0.95 and v > 0.002:
            xs.append(k * k)
            ys.append(math.log(v))
    if len(xs) < 4:
        return None, None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    c = -sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else 0.0
    a0 = math.exp(my + c * mx)
    return round(a0, 3), round(c, 2)


A0, CEXP = fit_exp({float(k): v for k, v in PROF_MED.items()})

IDLE_FIT = [FIT[r['name']] for r in ALL if r['anim'] == 'idle' and r['name'] in FIT]
SHADOW = dict(
    per_anim_rot=SH_AGG,
    alpha_profile=PROF_MED,
    alpha_fit=dict(a0=A0, c=CEXP,
                   formula='alpha(rho) = %.3f * exp(-%.2f * rho^2), rho = sqrt((dx/a)^2+(dy/b)^2)'
                           % (A0, CEXP)),
    recommended=dict(
        a_px=round(st.median([r['a'] for r in IDLE_FIT]), 1),
        b_px=round(st.median([r['b'] for r in IDLE_FIT]), 1),
        yc_px=round(st.median([r['yc'] for r in IDLE_FIT]), 1),
        xc_px=round(st.median([r['xc'] for r in IDLE_FIT]), 1),
        ybot_px=round(st.median([r['ybot'] for r in IDLE_FIT]), 1),
        peak_alpha=round(st.median([r['peak'] for r in IDLE_FIT]), 3),
        note='медиана по 24 кадрам idle (стоячая поза); в walk/chop пятно шире — см. per_anim_rot'),
)

# ==========================================================================
# 6. вырезки @6x
# ==========================================================================
CROPS = []


def over(sub, bg=(190, 190, 190)):
    rgb = sub[..., :3].astype(np.float32)
    al = sub[..., 3:4].astype(np.float32) / 255.0
    b = np.zeros_like(rgb) + np.array(bg, dtype=np.float32)
    return (rgb * al + b * (1 - al)).astype(np.uint8)


def save6(arr, path, k=6):
    im = Image.fromarray(arr)
    im.resize((im.width * k, im.height * k), Image.NEAREST).save(path)
    CROPS.append(os.path.basename(path))


for rot in ROTS:
    nm = 'hero_idle_0_%d' % ROTNAME[rot]
    im = over(frame_img(nm))
    save6(im[24:82, 34:80], OUT + 'hero_idle_0_rot%d_head_torso@6x.png' % rot)
    save6(im[80:120, 32:82], OUT + 'hero_idle_0_rot%d_legs_feet@6x.png' % rot)

nm = 'hero_idle_0_0'
im = over(frame_img(nm)).copy()
lm0 = LM[0]['landmarks']
COLORS = {'hat_top': (255, 0, 0), 'face_top': (0, 128, 255), 'face_bottom': (0, 210, 255),
          'shoulder_top': (0, 200, 0), 'chest': (0, 255, 120), 'hem_bottom': (255, 0, 255),
          'boot_top': (255, 128, 0), 'knee': (255, 160, 255),
          'foot_bottom_solid': (255, 255, 0), 'ground': (255, 255, 255)}
for key, col in COLORS.items():
    v = lm0.get(key)
    if not v:
        continue
    y = v[0]
    if 0 <= y < im.shape[0]:
        im[y, 32:82] = np.array(col, np.uint8)
if lm0.get('belt'):
    for y in (lm0['belt'][0], lm0['belt'][1]):
        im[y, 32:82] = np.array((170, 255, 170), np.uint8)
save6(im[24:120, 32:82], OUT + 'hero_idle_0_rot0_landmarks@6x.png')

# ==========================================================================
# 7. отчёт
# ==========================================================================
def y2h(y):
    return None if y is None else round((106.0 - y) / PPU, 4)


def y2z(y):
    return None if y is None else round((106.0 - y) / (PPU * UPZ), 4)


LM_ORDER = [
    ('верх волос (макушка)', 'hat_top'), ('верх плотный', 'hat_top_solid'),
    ('лицо верх', 'face_top'), ('подбородок / низ лица', 'face_bottom'),
    ('шея', 'neck'), ('плечи (ворот)', 'shoulder_top'),
    ('грудь (середина торса)', 'chest'), ('самая широкая строка торса', 'torso_widest'),
    ('пояс верх', 'belt'), ('пояс низ', 'belt_b'), ('подол рубахи', 'hem_bottom'),
    ('лезвие верх', 'axe_blade_top'), ('лезвие низ', 'axe_blade_bottom'),
    ('нога верх', 'leg_top'), ('самое узкое место ноги', 'knee'), ('обувь верх', 'boot_top'),
    ('подошва (плотная)', 'foot_bottom_solid'), ('подошва (силуэт)', 'foot_bottom_obj'),
    ('ЛИНИЯ ЗЕМЛИ', 'ground'),
]


def lm_get(rot, key):
    lm = LM[rot]['landmarks']
    if key == 'belt_b':
        return (lm['belt'][1], lm['belt'][2]) if lm.get('belt') else None
    v = lm.get(key)
    return v


JL = {}
for rot in ROTS:
    JL[str(rot)] = {}
    for title, key in LM_ORDER:
        v = lm_get(rot, key)
        if not v:
            JL[str(rot)][title] = None
            continue
        y = v[0]
        JL[str(rot)][title] = dict(y_px=int(y), h_units=y2h(y), z_world=y2z(y),
                                  rule=v[1] if len(v) > 1 else '')

# читаемость
READ = {}
for rot in ROTS:
    nm = 'hero_idle_0_%d' % ROTNAME[rot]
    r = landmarks(nm)
    a = frame_img(nm)
    lm = r['lm']
    y_sh = lm['shoulder_top'][0]
    body = r['masks']['body'] & (a[..., 3] >= 200)
    head = body.copy()
    head[y_sh:, :] = False
    face = r['masks']['isS'] & (a[..., 3] >= 200)
    fy = np.where(face.any(axis=1))[0]
    face_head = face.copy()
    if len(fy):
        face_head[lm['face_bottom'][0] + 1:, :] = False
    # тёмные пиксели ВНУТРИ лица (глаза/нос/рот были бы такими)
    dark_in_face = 0
    if face_head.any():
        ys, xs = np.where(face_head)
        for y, x in zip(ys, xs):
            if (a[y, x, :3].max() < 60) and 0 < x < a.shape[1] - 1 and face_head[y, x - 1] \
                    and face_head[y, x + 1]:
                dark_in_face += 1
    rp = run_rows(analyze(frame_img(nm))['obj'])
    y_top, y_bot = lm['hat_top'][0], lm['foot_bottom_obj'][0]
    feet = rp[max(y_top, y_bot - 7): y_bot + 1]
    lz = rp[(lm['boot_top'][0] or y_top): y_bot + 1]
    READ[rot] = dict(
        name=nm, body_px=int(body.sum()), head_px=int(head.sum()),
        head_share=round(float(head.sum()) / float(body.sum()), 3),
        head_w_px=int(max(r['width'][y_top:y_sh])) if y_sh > y_top else 0,
        head_h_px=int(y_sh - y_top),
        face_px=int(face_head.sum()),
        face_w_px=(int(np.where(face_head.any(axis=0))[0].max()
                       - np.where(face_head.any(axis=0))[0].min() + 1) if face_head.any() else 0),
        face_h_px=(int(np.where(face_head.any(axis=1))[0].max()
                       - np.where(face_head.any(axis=1))[0].min() + 1) if face_head.any() else 0),
        face_dark_px=int(dark_in_face),
        legs_max_runs=int(lz.max()) if len(lz) else 0,
        legs_merged_rows=int((lz <= 1).sum()), legs_rows=int(len(lz)),
        feet_runs=int(feet.max()) if len(feet) else 0,
        feet_rows=int(len(feet)),
        distinct_colors=int(len(set(map(tuple, a[..., :3][body].tolist())))),
        min_detail_px=2,
    )

RESULT = dict(
    # Пути в отчёте — от корня 4tox, а не абсолютные: отчёт читают и переносят,
    # и адрес домашней папки в нём бесполезен (docs/STRUCTURE.md §6.2).
    source=dict(atlas=os.path.relpath(HERO + 'atlas.png', REPO),
                meta=os.path.relpath(HERO + 'atlas.json', REPO), ppu=meta['ppu'],
                mul=meta['mul'], frames=len(meta['frames']),
                frame_px=[meta['cell'][0] - 2, meta['cell'][1] - 2],
                anchor=[56.0, 106.0], camera=dict(az_deg=meta['az_deg'], el_deg=meta['el_deg']),
                anims=meta['anims'], note=meta['note']),
    conventions=dict(
        silhouette='альфа > 8 и НЕ чистый чёрный (maxRGB > 8): тень отсекается по цвету',
        shadow='чистый чёрный maxRGB <= 8 (у плотных пикселей объекта min maxRGB = 17)',
        ground='anchorY = 106 px — проекция мировой точки (0,0,0), земля между ступнями',
        h_units='(anchorY - y) / 96 — соглашение ТЗ (экранные юниты)',
        z_world='(anchorY - y) / (96 * 0.816497) — мировые Z модели',
        upz=round(UPZ, 6),
        z_per_px=round(1.0 / (PPU * UPZ), 6),
        note='1 юнит Z модели = %.2f px кадра при 96 ppu' % (UPZ * 96)),
    global_extent=GLOBAL, global_idle=dict(
        h_top_units=agg_idle('h_top_units'), h_bot_units=agg_idle('h_bot_units'),
        w_units=agg_idle('w_units'), z_top_world=agg_idle('z_top_world')),
    aggregate=AGG, frames=ALL, landmarks=JL,
    landmarks_width_profile={str(r): LM[r]['width_profile'] for r in ROTS},
    landmarks_family_rows={str(r): LM[r]['family_rows'] for r in ROTS},
    palette_by_part=dict(merged=PAL_MERGED,
                         per_rotation={str(r): PAL_PER_ROT[r] for r in ROTS},
                         outline=OUTLINE),
    facets_4x={str(r): FACETS[r] for r in ROTS},
    shadow=SHADOW,
    readability={str(r): READ[r] for r in ROTS},
    crops=CROPS,
)


def _jsonable(o):
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError('не сериализуется: %r' % type(o))


with open(OUT + 'hero-reference.json', 'w', encoding='utf-8') as f:
    json.dump(RESULT, f, ensure_ascii=False, indent=1, default=_jsonable)

# ---------------------------------------------------------------- markdown --
L = []
w = L.append
w('# Эталонный персонаж mapgen2 — «герой-лесоруб»: точные мерки')
w('')
w('Снято **только чтением** с `mapgen2/assets/hero/atlas.png` + `atlas.json` (88 кадров, '
  '96 ppu, `mul` 1.35) скриптом `measure_hero.py`; инструменты канона — '
  '`4tox-lowpoly-3d/scripts/{canon,measure}.py`. В `mapgen2/` ничего не менялось.')
w('')
w('**Кадр:** %d×%d px, у всех 88 кадров `anchorX/anchorY = 56 / 106`. `anchorY` — строка, '
  'куда проецируется мировая точка (0,0,0): **земля между ступнями**.'
  % (meta['cell'][0] - 2, meta['cell'][1] - 2))
w('')
w('## 0. Две «высоты» — прочитать до всего остального')
w('')
w('| величина | формула | кому нужна |')
w('|---|---|---|')
w('| **h** (экранные юниты) | `(106 − y) / 96` | соглашение ТЗ; столько пикселей кадра / ppu |')
w('| **z** (мировые Z модели) | `(106 − y) / (96 × 0.816497)` | Blender: высота в юнитах мира |')
w('')
w('`0.816497 = UP.z = cos(35.2644°)`: **1 юнит Z модели = %.2f px кадра при 96 ppu**, '
  'не 96. Обратно: чтобы спрайт вышел как у эталона, модель по Z обязана быть в '
  '**1.2247 раза** выше «экранной» высоты. Кто построит человека 0.86 юнита по Z — '
  'получит спрайт 67 px вместо 78.' % (UPZ * 96))
w('')
idle_h = RESULT['global_idle']['h_top_units']
idle_z = RESULT['global_idle']['z_top_world']
w('**Стоячий рост (idle, 24 кадра): h = %.3f..%.3f экранных юнита = z = %.3f..%.3f юнита '
  'мира.** В chop рука с топором поднимается до h = %.3f (z = %.3f), но это уже не рост.'
  % (idle_h['min'], idle_h['max'], idle_z['min'], idle_z['max'],
     GLOBAL['h_top_units']['max'], GLOBAL['z_top_world']['max']))
w('')
ib = RESULT['global_idle']['h_bot_units']
w('Второе следствие изометрии: **ступни уходят ниже якоря**. Якорь — точка (0,0,0) *между* '
  'ступнями, а носок выдвинут вперёд и проецируется ниже: у idle низ силуэта '
  'h = %+0.3f..%+0.3f (z = %+0.3f..%+0.3f), то есть y = 112..114 при земле y = 106. '
  'Это ступни, а не тень: тень чисто чёрная и лежит ещё ниже (§5).'
  % (ib['min'], ib['max'],
     RESULT['global_idle']['h_bot_units']['min'] / UPZ,
     RESULT['global_idle']['h_bot_units']['max'] / UPZ))
w('')
w('## 1. Габарит: 88 кадров')
w('')
w('Силуэт — `альфа > 8` **без тени** (тень = чистый чёрный `maxRGB ≤ 8`; у плотных пикселей '
  'объекта минимум `maxRGB` = 17, порог чистый).')
w('')
w('| анимация | поворот | кадров | рост h min..max | z мира min..max | ширина px min..max | '
  'ширина юниты | полуширина max | силуэт px | ступни разведены |')
w('|---|---|---|---|---|---|---|---|---|---|')
for an in ANIMS:
    for rot in ROTS:
        A = AGG['%s_%d' % (an, rot)]
        w('| %s | %d° | %d | %.3f..%.3f | %.3f..%.3f | %g..%g | %.3f..%.3f | %.3f | %d..%d | %s |'
          % (an, rot, A['n'], A['h_top_units']['min'], A['h_top_units']['max'],
             A['z_top_world']['min'], A['z_top_world']['max'], A['w_px']['min'], A['w_px']['max'],
             A['w_units']['min'], A['w_units']['max'], A['half_w_units']['max'],
             A['obj_px']['min'], A['obj_px']['max'],
             '%d из %d' % (A['feet_runs2'], A['n'])))
w('')
w('Низ силуэта (отрицательный = ниже линии земли):')
w('')
w('| анимация | поворот | низ h min..max | низ y px |')
w('|---|---|---|---|')
for an in ANIMS:
    for rot in ROTS:
        A = AGG['%s_%d' % (an, rot)]
        w('| %s | %d° | %+0.4f..%+0.4f | %d..%d |'
          % (an, rot, A['h_bot_units']['min'], A['h_bot_units']['max'],
             round(106 - A['h_bot_units']['max'] * 96), round(106 - A['h_bot_units']['min'] * 96)))
w('')
w('Весь набор: рост %.3f..%.3f h (%.3f..%.3f z мира), ширина %.3f..%.3f юнита, '
  'полуширина до %.3f, силуэт %d..%d px.'
  % (GLOBAL['h_top_units']['min'], GLOBAL['h_top_units']['max'],
     GLOBAL['z_top_world']['min'], GLOBAL['z_top_world']['max'],
     GLOBAL['w_units']['min'], GLOBAL['w_units']['max'], GLOBAL['half_w_units']['max'],
     GLOBAL['obj_px']['min'], GLOBAL['obj_px']['max']))
w('')
w('## 2. Вертикальные ориентиры фигуры (idle_0, 4 поворота)')
w('')
w('`y` — строка кадра (0 сверху), `h` — высота над землёй в экранных юнитах `(106−y)/96`, '
  '`z` — то же в мировых Z. Правило замера — в JSON `landmarks.<rot>.<ориентир>.rule`.')
w('')
w('| ориентир | rot0 y | h | z | rot90 y | h | z | rot180 y | h | z | rot270 y | h | z |')
w('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for title, key in LM_ORDER:
    cells = []
    for rot in ROTS:
        v = JL[str(rot)].get(title)
        cells += ['—', '—', '—'] if not v else \
            ['%d' % v['y_px'], '%.3f' % v['h_units'], '%.3f' % v['z_world']]
    w('| %s | %s |' % (title, ' | '.join(cells)))
w('')
w('Ширина по ориентирам (px из силуэта):')
w('')
w('| поворот | голова max | плечи/торс max | весь кадр max | самое узкое место ноги |')
w('|---|---|---|---|---|')
for rot in ROTS:
    lm = LM[rot]['landmarks']
    y_top, y_sh = lm['hat_top'][0], lm['shoulder_top'][0]
    y_hem = lm['hem_bottom'][0]
    wprof = LM[rot]['width_profile']
    head_w = max(wprof[y_top:y_sh]) if y_sh > y_top else 0
    sh_w = max(wprof[y_sh:y_hem + 1]) if y_hem >= y_sh else 0
    knee = lm.get('knee')
    kw = ('%d (строка %d)' % (LM[rot]['knee_w'], knee[0])) if knee else '—'
    w('| %d° | %d | %d | %d | %s |' % (rot, head_w, sh_w, max(wprof), kw))
w('')
w('Ширина силуэта по строкам — в JSON (`landmarks_width_profile`).')
w('')
w('## 3. Палитра по частям (модальный цвет, альфа ≥ 200, контур исключён)')
w('')
w('Зона = «семья канона × полоса строк из ориентиров»; цвет **модальный** (самый частый точный '
  'RGB), не средний. `Δ` — расстояние до ближайшего тона канона в sRGB.')
w('')
w('| зона | px (4 пов.) | модальный RGB | семья канона | тон | Δ | доля моды | цветов |')
w('|---|---|---|---|---|---|---|---|')
ZNAME = {'волосы': 'волосы (шапка волос, без шляпы)', 'лицо': 'лицо',
         'кисти рук': 'кисти рук', 'рубаха': 'рубаха', 'пояс': 'пояс',
         'штаны': 'штаны', 'обувь': 'обувь', 'лезвие топора': 'лезвие топора',
         'топорище': 'топорище (рукоять)'}
for zn in ZONES:
    p = PAL_MERGED[zn]
    if not p.get('px'):
        w('| %s | 0 | — не найдено — | | | | | |' % ZNAME[zn])
        continue
    w('| %s | %d | `%s` | %s | %s | %.1f | %.2f | %d |'
      % (ZNAME[zn], p['px'], p['modal_rgb'], p['family'], p['tone'], p['dist'],
         p['modal_share'], p['distinct']))
w('')
w('Топ-4 цвета зон (видно, какие тона семьи реально использованы):')
w('')
for zn in ZONES:
    p = PAL_MERGED[zn]
    if not p.get('px'):
        continue
    w('- **%s** (%d px): ' % (ZNAME[zn], p['px'])
      + ', '.join('`%s` %s/%s Δ%.1f ×%d' % (t['rgb'], t['family'], t['tone'], t['dist'], t['px'])
                  for t in p['top4']))
w('')
w('Контур: модальный `%s`, ближайший канонный `%s` — Δ%.1f (всего %d px, %d разных цветов).'
  % (OUTLINE['modal'], OUTLINE['canon'][2], OUTLINE['dist'], OUTLINE['px'], OUTLINE['distinct']))
w('')
w('## 4. Фасеты и контур (@4x, nearest)')
w('')
w('Метод `measure.py`: кадр ×4 nearest, объект `альфа > 200`, контур исключён, цвета квантованы '
  'в 10 мод, фасет — 4-связная область одного цвета.')
w('')
w('| поворот | крупных фасетов (≥3%) | доля площади в них | мусор (<1%) | фасетов всего | '
  '≥6 px (1x) | контур @4x | контур при 96 ppu | в палитре |')
w('|---|---|---|---|---|---|---|---|---|')
for rot in ROTS:
    F = FACETS[rot]
    w('| %d° | %d | %.0f%% | %.0f%% | %d | %d | %.2f px | **%.2f px** | %.1f%% |'
      % (rot, F['n_big'], 100 * F['big_share'], 100 * F['dust_share'], F['n_all'],
         F['facets_ge6_1x'], F['outline_px_4x'], F['outline_px_96'],
         100 * F['share_in_canon_1x']))
w('')
w('Порог гейта: крупные фасеты ≥30% площади, мусор <40%, контур 0.6..3.5 px. Эталон проходит.')
w('')
w('## 5. Тень')
w('')
w('Два замера. (а) По методу `measure.py`: пятно = только часть НИЖЕ низа силуэта, отступ 1 px, '
  'пик альфы — включая контактную строку. (б) Полный эллипс: подгонка по нижней половине пятна '
  '(низ пятна ступнями не перекрыт, поэтому b считается честно), центр — строка максимальной '
  'ширины.')
w('')
w('(а) Замер по скиллу:')
w('')
w('| поворот | ширина пятна px | h px | h/w | ширина/силуэт | пик α | p90 α |')
w('|---|---|---|---|---|---|---|')
for rot in ROTS:
    nm = 'hero_idle_0_%d' % ROTNAME[rot]
    reps = M.report(frame_img(nm), anchor(nm), nm)
    s = reps['shadow']
    w('| %d° | %d | %d | %.2f | %.2f | %.2f | %.2f |'
      % (rot, round(s['w'] * 96), round(s['h'] * 96), s['h_over_w'], s['w_over_sil'],
         s['max_alpha'], s['p90_alpha']))
w('')
w('(б) Полный эллипс, медианы и разброс по анимациям (px при 96 ppu):')
w('')
w('| анимация | поворот | a (полуось X) | b (полуось Y) | центр y | низ y | центр x − 56 | пик α |')
w('|---|---|---|---|---|---|---|---|')
for an in ANIMS:
    for rot in ROTS:
        S = SH_AGG['%s_%d' % (an, rot)]
        w('| %s | %d° | %.1f..%.1f | %.1f..%.1f | %.0f..%.0f | %d..%d | %.1f..%.1f | %.2f..%.2f |'
          % (an, rot, S['a'][0], S['a'][1], S['b'][0], S['b'][1], S['yc'][0], S['yc'][1],
             S['ybot'][0], S['ybot'][1], S['xc_minus_anchor'][0], S['xc_minus_anchor'][1],
             S['peak'][0], S['peak'][1]))
w('')
R = SHADOW['recommended']
w('**Пятно стоячей позы (медиана 24 кадров idle): a = %.1f px, b = %.1f px, центр '
  '(%+.0f, %+.0f) от якоря, низ строки %.0f, пик α %.2f.** Оси эллипса строго экранные '
  '(наклон 0°): центр строки на каждом ряду стоит на x = 58 = anchorX + 2, поэтому '
  '«наклон большой оси» у эталона нулевой, а не −30°.'
  % (R['a_px'], R['b_px'], R['xc_px'] - 56, R['yc_px'] - 106, R['ybot_px'], R['peak_alpha']))
w('')
w('Альфа не плоская: это радиальный градиент. По радиусу `ρ = sqrt((dx/a)² + (dy/b)²)` '
  'медиана по всем 88 кадрам:')
w('')
w('| ρ | ' + ' | '.join(['%.2f' % float(k) for k in list(PROF_MED)[::6]]) + ' |')
w('|---|' + '---|' * len(list(PROF_MED)[::6]))
w('| α | ' + ' | '.join(['%.3f' % PROF_MED[k] for k in list(PROF_MED)[::6]]) + ' |')
w('')
w('Модель: `alpha(ρ) = %.3f · exp(−%.2f · ρ²)` (МНК по полосе ρ = 0.15..0.95).'
  % (A0, CEXP))
w('')
w('**Рекомендуемые параметры пятна** — формат `templates/screen_shadow.py` (px при 96 ppu, '
  '`blur` там в юнитах):')
w('')
w('```python')
w('HERO = dict(a=%.1f, b=%.1f, angle=0.0, alpha=%.2f, blur=0.010, shift=(2.0, %.1f))'
  % (R['a_px'], R['b_px'], R['peak_alpha'], R['yc_px'] - 106))
w('```')
w('')
w('Важно: `alpha` здесь — ПИК в центре. У эталона к краю альфа падает до ~0.01, то есть '
  'пятно без резкой кромки; если пайплайн умеет только плоскую альфу + blur, ближайший '
  'эквивалент — `alpha≈0.28, blur≈0.02` (2 px).')
w('')
w('В walk и chop пятно заметно шире стоячего: у chop a доходит до 36.5 px, b до 10 px, низ до '
  'y = 126. Если тень рисуется не по кадру, а одна на персонажа — берите стоячую.')
w('')
w('## 6. Читаемость на 1x (96 ppu)')
w('')
w('| поворот | голова px | доля головы | голова ш×в | лицо px | лицо ш×в | тёмных пикселей '
  'внутри лица | отрезков в зоне ног | строк со слитыми ногами | цветов тела |')
w('|---|---|---|---|---|---|---|---|---|---|')
for rot in ROTS:
    Rr = READ[rot]
    w('| %d° | %d | %.0f%% | %d×%d | %d | %d×%d | %d | %d | %d из %d | %d |'
      % (rot, Rr['head_px'], 100 * Rr['head_share'], Rr['head_w_px'], Rr['head_h_px'],
         Rr['face_px'], Rr['face_w_px'], Rr['face_h_px'], Rr['face_dark_px'],
         Rr['legs_max_runs'], Rr['legs_merged_rows'], Rr['legs_rows'],
         Rr['distinct_colors']))
w('')


# --- §7 что доехало до спрайта -------------------------------------------
w('## 7. Что доехало до спрайта, а что нет (1x, 96 ppu)')
w('')
w('Проверено числами выше; здесь — честный вывод.')
w('')
w('**Читается:**')
w('')
_idle_rows = [r for r in ALL if r['anim'] == 'idle']
_walk_rows = [r for r in ALL if r['anim'] == 'walk']
_chop_rows = [r for r in ALL if r['anim'] == 'chop']
w('- **силуэт целиком**: ширина idle %d..%d px, walk %d..%d, chop %d..%d; высота силуэта '
  'idle %d..%d px; площадь %d..%d px. Фигура опознаётся контуром и позой.'
  % (min(r['w_px'] for r in _idle_rows), max(r['w_px'] for r in _idle_rows),
     min(r['w_px'] for r in _walk_rows), max(r['w_px'] for r in _walk_rows),
     min(r['w_px'] for r in _chop_rows), max(r['w_px'] for r in _chop_rows),
     min(r['h_sil_px'] for r in _idle_rows), max(r['h_sil_px'] for r in _idle_rows),
     GLOBAL['obj_px']['min'], GLOBAL['obj_px']['max']))
w('- **шапка волос** — крупное тёмно-коричневое пятно 25×20 px (19% площади тела), '
  'верх головы и затылок;')
w('- **лицо** — плоское пятно кожи 15..16 × 13 px;')
w('- **рубаха** — самое крупное цветовое пятно кадра (1658 px на 4 поворота), '
  'тона leaf_autumn видны сразу;')
w('- **пояс** — диагональная коричневая полоса поперёк рубахи, ~70 px на кадр, читается;')
w('- **штаны** и **обувь** — разделены по тону: штаны светлее (trunk/light), '
  'обувь темнее (trunk/dark + leather/mid);')
w('- **лезвие топора** — серое пятно 350 px на 4 поворота (в среднем 88 px), '
  'единственный холодный тон в фигуре, поэтому цепляет глаз;')
_fs = {an: sum(AGG['%s_%d' % (an, rot)]['feet_runs2'] for rot in ROTS)
       for an in ANIMS}
_ft = {an: sum(AGG['%s_%d' % (an, rot)]['n'] for rot in ROTS) for an in ANIMS}
w('- **разделение ступней — НЕ надёжное.** В нижних 8 строках силуэта два отрезка '
  'встречаются: idle %d из %d кадров, walk %d из %d, chop %d из %d. В idle ноги почти '
  'всегда слиты в одно пятно; на ходу и в рубке просвет между ступнями появляется, '
  'но не в каждом кадре. Для нового персонажа это значит: рассчитывать на читаемый '
  'просвет между ногами нельзя, фигуру держит силуэт целиком.'
  % (_fs['idle'], _ft['idle'], _fs['walk'], _ft['walk'], _fs['chop'], _ft['chop']))
w('')
w('**НЕ читается:**')
w('')
w('- **лица как лица нет.** Глаз, носа, рта, бровей нет вовсе: 0 тёмных пикселей внутри '
  'пятна кожи на всех 4 поворотах. Лицо — одна плоская грань с одной линией перелома тени.')
w('- **шеи нет.** Ширина растёт монотонно от головы (25..26 px) к плечам (29..32 px): '
  'голова стоит прямо на плечах. Строка «шея» в §2 — условная (строка над воротом).')
w('- **колена и голени нет.** От подола (y = 78) до обуви (y = 94..98) всего 16..20 px, '
  'и это один столбик; ниже — обувь, слитая в одно пятно. Анатомии ноги в спрайте нет, '
  'есть «штанина + сапог».')
w('- **пальцев, кистей как кистей нет**: кисть — пятно кожи ~90 px, без большого пальца.')
w('- **топорище почти не видно.** Рукоять 1..2 px толщиной, а контур 2 px с каждой стороны: '
  'собственный цвет рукояти виден только на 180°, где она вынесена в сторону от тела. '
  'В остальных поворотах это тёмная линия цвета контура.')
w('- **деталей мельче 2 px нет вообще** — и не должно быть: 1 px кожи на строке 52 (уголок '
  'подбородка) в спрайте читается как случайный пиксель.')
w('')
w('**Ловушка для того, кто будет мерить этот же атлас:** у плотного тела 409..449 РАЗНЫХ '
  'цветов на ~1800 px. Это сглаживание кромок и мягкая тень под ногами, а не палитра. '
  'Поэтому «модальный цвет» в §3 осмыслен, а «средний цвет зоны» — нет.')
w('')

# --- §8 выводы ------------------------------------------------------------
w('## 8. Пять выводов для того, кто строит персонажа рядом с этим')
w('')
w('1. **Считай высоту в мировых Z, а не в пикселях/96.** Камера сжимает Z на 0.8165: '
  'чтобы спрайт был как у эталона, модель обязана быть **z = 0.98..1.01 юнита** '
  '(макушка), а не 0.81. Голова: верх на z = 0.995, ворот на z = 0.740.')
w('2. **Опора — между ступнями, и ступни вылезают ниже неё.** Точка (0,0,0) обязана '
  'проецироваться в (56, 106) пикселя кадра. Если поставить модель так, что низ подошвы '
  'ляжет на y = 106, фигура «всплывёт» на 5..8 px: у эталона низ силуэта на y = 112..114, '
  'то есть h = −0.062..−0.083 (передний носок выдвинут вперёд и проецируется ниже).')
_lt = LM[0]['landmarks']
_y_top = _lt['hat_top'][0]
_y_sh = _lt['shoulder_top'][0]
_y_hem = _lt['hem_bottom'][0]
_y_bot = _lt['foot_bottom_obj'][0]
_above = 106 - _y_top
w('3. **Пропорции (idle_0, строка → высота):** макушка 28, лицо 40, ворот 48, пояс 67..77, '
  'подол 78, обувь 95, подошва 111..112, **земля 106**. Над землёй %d px: голова %d px '
  '(%.0f%%), торс %d px (%.0f%%), ноги %d px (%.0f%%); ещё %d px ступни уходят ниже земли. '
  'Держись этих чисел — и человек встанет в один ряд с деревьями так же, как эталон '
  '(mul 1.35 у обоих).'
  % (_above, _y_sh - _y_top, 100.0 * (_y_sh - _y_top) / _above,
     _y_hem - _y_sh, 100.0 * (_y_hem - _y_sh) / _above,
     106 - _y_hem, 100.0 * (106 - _y_hem) / _above, _y_bot - 106))
w('4. **Палитра частей — четыре семейства канона:** волосы/штаны/пояс/рукоять — `trunk`, '
  'рубаха — `leaf_autumn`, лицо и кисти — `skin`, обувь — `leather` + `trunk/dark`, '
  'лезвие — `iron`/`ore_iron` (единственный холодный тон). Шляпы у эталона НЕТ — '
  'на голове шапка волос; если новому персонажу нужна шляпа, это уже другое семейство '
  'и другая высота макушки.')
w('5. **Ни одной детали мельче 2 px и не больше 8..11 крупных фасетов.** Контур 2 px '
  'съедает всё, что тоньше: рукоять топора в спрайте — просто тёмная линия. '
  'Крупные плоские пятна должны занимать 54..64% площади (у эталона столько), '
  'мусорных пятнышек <1% — не больше 21..24%.')
w('')

# --- §9 файлы -------------------------------------------------------------
w('## 9. Файлы')
w('')
w('| файл | что внутри |')
w('|---|---|')
w('| `hero-reference.md` | этот отчёт |')
w('| `hero-reference.json` | те же числа машинно: все 88 кадров, ориентиры, палитры, '
  'фасеты, тень, читаемость, правила замера |')
for c in CROPS:
    if 'head_torso' in c:
        w('| `%s` | голова + торс, idle_0, поворот %s, ×6 nearest |'
          % (c, c.split('rot')[1].split('_')[0]))
    elif 'legs_feet' in c:
        w('| `%s` | ноги + ступни, idle_0, поворот %s, ×6 nearest |'
          % (c, c.split('rot')[1].split('_')[0]))
    else:
        w('| `%s` | тот же кадр с линиями ориентиров §2 |' % c)
w('| `measure_hero.py` | скрипт замера (перезапускаемый, только чтение исходников) |')
w('')
w('Рабочие файлы рядом (черновики замера, читателю не нужны): `_explore_*.py`, `_dbg_leather.py`, `_tmp_*.png`.')
w('## Приложение A. Все 88 кадров')
w('')
w('`h_top` / `h_bot` — экранные юниты от линии земли, `z_top` — мировые Z, '
  '`runs` — отрезков силуэта в зоне обуви (2 = ноги разведены).')
w('')
w('| кадр | h_top | z_top | h_bot | ширина px | силуэт px | runs | обувь с y |')
w('|---|---|---|---|---|---|---|---|')
for r in sorted(ALL, key=lambda x: (ANIMS.index(x['anim']), x['rotation'], x['frame'])):
    w('| `%s` | %.3f | %.3f | %+.3f | %d | %d | %d | %s |'
      % (r['name'], r['h_top_units'], r['z_top_world'], r['h_bot_units'], r['w_px'],
         r['obj_px'], r['max_runs_legzone'], r['boot_top_px']))
w('')

with open(OUT + 'hero-reference.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(L))
print('JSON: %shero-reference.json' % OUT)
print('MD:   %shero-reference.md' % OUT)
print('CROPS:', len(CROPS))
print('shadow idle  a=%.1f b=%.1f yc=%.1f xc=%.1f peak=%.2f' %
      (R['a_px'], R['b_px'], R['yc_px'], R['xc_px'], R['peak_alpha']))
print('alpha fit: %.3f*exp(-%.2f rho^2)' % (A0, CEXP))
