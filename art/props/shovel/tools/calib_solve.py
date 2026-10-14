"""Калибровка палитры, шаг 2: решение по рендеру проб.

    python3 tools/calib_solve.py [--probes renders/calib_probes.json] [--report]

Читает пробы, снятые tools/calib_render.py (или tools/calib_live.py), и
подбирает базовый цвет так, чтобы проба дала ровно тон эталона:

    out_лин = albedo_лин * F(нормаль)  =>  albedo_лин = target_лин / F

F зависит от нормали, поэтому подбор идёт по каждой паре (семья, тон).
Результат — tools/palette_cal.json; shovel.py берёт его, если файл есть.
Прогон повторяют после правки геометрии: нормали тонов меняются, значит
меняются и F. Практика топора: сходится за две итерации.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import color as C

PROBES = os.path.join(ROOT, 'renders', 'calib_probes.json')
CAL_JSON = os.path.join(HERE, 'palette_cal.json')


def measure(path, inset=8):
    """Средний цвет центра пробы (без краёв: там сглаживание с фоном)."""
    a = np.array(Image.open(path).convert('RGBA')).astype(float)
    h, w = a.shape[:2]
    c = a[h // 2 - inset:h // 2 + inset, w // 2 - inset:w // 2 + inset]
    return [float(x) for x in c[:, :, :3].reshape(-1, 3).mean(0)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probes', default=PROBES)
    ap.add_argument('--out', default=CAL_JSON)
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()

    data = json.load(open(args.probes))
    # не терять уже подобранные семьи: прогон по одной семье не должен сносить
    # остальные (у лопаты железо и дерево калибруются одним прогоном, но при
    # правке только рукояти в файле остаётся всё)
    out, report = {}, []
    if os.path.exists(args.out):
        try:
            out = json.load(open(args.out))
        except Exception:
            out = {}
    print('%-8s %-4s %-22s %-9s %-9s %-9s %-9s' % (
        'семья', 'тон', 'нормаль', 'base', 'проба', 'цель', 'новая base'))
    for p in data['probes']:
        path = os.path.join(ROOT, p['probe'])
        measured_srgb = measure(path)
        measured_lin = [C.lin(v / 255.0) for v in measured_srgb]
        base_lin = C.from_lin_hex(int(p['base_hex'][1:], 16))
        target_lin = C.to_lin(int(p['target_hex'][1:], 16))
        new_lin = [base_lin[i] * target_lin[i] / max(measured_lin[i], 1e-5)
                   for i in range(3)]
        new_lin = [min(1.0, max(0.0, x)) for x in new_lin]
        new_hex = C.lin_hex(new_lin)
        out.setdefault(p['family'], {})[str(p['tone'])] = C.hex_str(new_hex)
        print('%-8s %-4d (%5.2f,%5.2f,%5.2f)  %s  #%02X%02X%02X  %s  %s' % (
            p['family'], p['tone'], p['normal'][0], p['normal'][1], p['normal'][2],
            p['base_hex'], int(measured_srgb[0]), int(measured_srgb[1]),
            int(measured_srgb[2]), p['target_hex'], C.hex_str(new_hex)))
        report.append(dict(family=p['family'], tone=p['tone'],
                           measured='#%02X%02X%02X' % tuple(int(x) for x in measured_srgb),
                           target=p['target_hex'], new=C.hex_str(new_hex)))

    if args.report:
        print('\n--report: файл не пишется')
        return
    with open(args.out, 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print('\nзаписано %s' % args.out)


if __name__ == '__main__':
    main()
