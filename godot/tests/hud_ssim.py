#!/usr/bin/env python3
"""SSIM между кадрами HUD Godot и браузерными эталонами.

Это ДИАГНОСТИКА, а не порог: мир, шрифт и вёрстка разные, поэтому полный
пиксельный SSIM низкий. Структурный паритет проверяет tests/test_hud.gd
(кнопки, панели, тексты); здесь — честное число, чтобы видеть прогресс.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
G = ROOT / "shots"
B = ROOT.parent / "game" / "tools" / "out"
PAIRS = [
    ("hud.png", "input-hud.png"),
    ("hud_build.png", "build-menu.png"),
    ("hud_army.png", "squad-panel.png"),
]


def ssim(a, b):
    if a.size != b.size:
        b = b.resize(a.size)
    a = np.asarray(a.convert("L"), dtype=np.float64)
    b = np.asarray(b.convert("L"), dtype=np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    k = 8
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    a = a[:h, :w].reshape(h // k, k, w // k, k).mean((1, 3))
    b = b[:h, :w].reshape(h // k, k, w // k, k).mean((1, 3))
    ma, mb = a.mean(), b.mean()
    va, vb = a.var(), b.var()
    cov = ((a - ma) * (b - mb)).mean()
    return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))


def main():
    if not G.exists():
        print("нет shots/ — сначала tests/render_hud.gd", file=sys.stderr)
        return 2
    ok = True
    for gname, bname in PAIRS:
        gp, bp = G / gname, B / bname
        if not gp.exists() or not bp.exists():
            print(f"  нет пары: {gname} ↔ {bname}", file=sys.stderr)
            ok = False
            continue
        ga, ba = Image.open(gp), Image.open(bp)
        full = ssim(ga, ba)
        # области HUD: ресурсы, кнопки, обзор, подсказки
        regs = [(0, 0, 760, 110), (840, 0, 1440, 80), (1200, 690, 1440, 900), (0, 820, 600, 900)]
        vals = [ssim(ga.crop(r), ba.crop(r)) for r in regs]
        print(f"  {gname:14s} ↔ {bname:16s} full={full:.3f}  "
              f"hud={np.mean(vals):.3f}  [{', '.join(f'{v:.2f}' for v in vals)}]")
    print("SSIM — диагностика; структурный гейт: tests/parity.sh (test_hud 56/56).")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
