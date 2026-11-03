#!/bin/bash
# parity.sh — паритет HUD: структурный гейт (test_hud) + честный SSIM-замер.
# SSIM не порог: мир/шрифт/вёрстка отличаются, число печатается для истории.
# Запуск: ./tests/parity.sh   (нужны numpy и Pillow; PYTHON=... )
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
PY="${PYTHON:-python3}"
cd "$(dirname "$0")/.."

echo "== структурный паритет HUD (кнопки, панели, тексты)"
"$GODOT" --headless --path . -s res://tests/test_hud.gd | tail -3

echo "== кадры HUD (1440x900)"
"$GODOT" --path . -s res://tests/render_hud.gd >/dev/null

echo "== SSIM с браузерными эталонами (диагностика)"
"$PY" tests/hud_ssim.py
