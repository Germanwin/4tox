#!/usr/bin/env python3
"""Build half-resolution mobile atlases for the assets the game actually loads.

The desktop atlas is the source of truth. For every frame:
  * crop the ORIGINAL rectangle from the source PNG;
  * resize that rectangle independently (never the whole sheet);
  * pack it again with 2 px gaps;
  * halve x/y/w/h, anchors, ppu/res/cell.
World-space values (footprint, ground, mul, anims) stay unchanged, so the
model's size on the map is the same, while decoded pixels are ~1/4.

Run with the bundled Blender Python (Pillow 12):
  /Users/.../dsh-blender/.venv/bin/python mapgen2/tools/build-mobile-atlases.py
  ... --check
"""
from __future__ import annotations

import json
import shutil
import sys
import math
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "assets"
PAD = 2

ASSETS = [
    ("sprites", "MOBILE_SPRITE_ATLAS", True),
    ("waves", "MOBILE_WAVE_ATLAS", False),
    ("villager", "MOBILE_VILLAGER_ATLAS", False),
    ("armored_villager", "MOBILE_ARMORED_VILLAGER_ATLAS", False),
    ("townhall", "MOBILE_TOWNHALL_ATLAS", False),
    ("starter_house", "MOBILE_STARTER_HOUSE_ATLAS", False),
    ("lumbercamp", "MOBILE_LUMBERCAMP_ATLAS", False),
    ("barracks", "MOBILE_BARRACKS_ATLAS", False),
    ("warcamp", "MOBILE_WARCAMP_ATLAS", False),
    ("ruins", "MOBILE_RUINS_ATLAS", False),
]


def half(v: float) -> int:
    return max(1, int(math.floor(float(v) * 0.5 + 0.5)))


def build_one(name: str, global_name: str, sprites_path: bool, out_root: Path | None = None) -> dict:
    src_dir = ROOT / name
    meta = json.loads((src_dir / "atlas.json").read_text(encoding="utf-8"))
    src = Image.open(src_dir / "atlas.png").convert("RGBA")
    frames = meta.get("frames") or {}
    if not frames:
        raise SystemExit(f"{name}: no frames")

    # Per-frame crop -> resize -> shelf pack. Two-pass: first measure, then
    # render. Frame order is the metadata order; rotations/animations are kept.
    items = []
    max_w = 1
    for key, f in frames.items():
        w = half(f["w"])
        h = half(f["h"])
        items.append((key, f, w, h))
        max_w = max(max_w, w)

    sheet_w = max(64, int(round(src.width * 0.5)))
    sheet_w = max(sheet_w, max_w)
    x = PAD
    y = PAD
    row_h = 0
    placed = {}
    for key, f, w, h in items:
        if x + w + PAD > sheet_w:
            x = PAD
            y += row_h + PAD
            row_h = 0
        placed[key] = (x, y, w, h)
        x += w + PAD
        row_h = max(row_h, h)
    sheet_h = y + row_h + PAD

    out = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    for key, f, w, h in items:
        crop = src.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
        crop = crop.resize((w, h), Image.Resampling.LANCZOS)
        px, py, _, _ = placed[key]
        out.alpha_composite(crop, (px, py))

    new_meta = dict(meta)
    new_meta["atlas"] = (name + "/mobile/atlas.png") if sprites_path else "atlas.png"
    new_meta["ppu"] = float(meta.get("ppu", 96.0)) * 0.5
    if isinstance(meta.get("res"), list):
        new_meta["res"] = [half(meta["res"][0]), half(meta["res"][1])]
    if isinstance(meta.get("cell"), list):
        new_meta["cell"] = [half(meta["cell"][0]), half(meta["cell"][1])]
    new_meta["mobile"] = True
    new_meta["mobileScale"] = 0.5
    new_meta["sourcePpu"] = meta.get("ppu", 96.0)
    new_frames = {}
    for key, f, w, h in items:
        px, py, _, _ = placed[key]
        nf = dict(f)
        nf["x"] = px
        nf["y"] = py
        nf["w"] = w
        nf["h"] = h
        if "anchorX" in f:
            nf["anchorX"] = float(f["anchorX"]) * 0.5
        if "anchorY" in f:
            nf["anchorY"] = float(f["anchorY"]) * 0.5
        # footprint and ground are in CELLS, not pixels: never scale.
        new_frames[key] = nf
    new_meta["frames"] = new_frames

    dst = (out_root / name / "mobile") if out_root else (src_dir / "mobile")
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    out.save(dst / "atlas.png", optimize=True)
    (dst / "atlas.json").write_text(
        json.dumps(new_meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    (dst / "atlas.js").write_text(
        "/* мобильный атлас: половина кадров, ppu×0.5; см. build-mobile-atlases.py */\n"
        "window." + global_name + " = " +
        json.dumps(new_meta, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8",
    )
    return {
        "name": name,
        "image": str(dst / "atlas.png"),
        "width": out.width,
        "height": out.height,
        "frames": len(frames),
    }


def main() -> int:
    check = "--check" in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix="4tox-mobile-")) if check else None
    results = []
    bad = 0
    try:
        for name, global_name, sprites_path in ASSETS:
            res = build_one(name, global_name, sprites_path, tmp)
            results.append(res)
            if check:
                src = ROOT / name / "mobile"
                dst = tmp / name / "mobile"
                for fname in ("atlas.png", "atlas.json", "atlas.js"):
                    a = (src / fname).read_bytes() if (src / fname).exists() else b""
                    b = (dst / fname).read_bytes()
                    if a != b:
                        bad += 1
                        print(f"{name}/{fname}: differs")
            print(f"{name}: {res['width']}x{res['height']} ({res['frames']} frames)")
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    if check:
        print("mobile atlases: " + ("up to date" if not bad else f"{bad} differences"))
        return 0 if not bad else 1
    print("mobile atlases: written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
