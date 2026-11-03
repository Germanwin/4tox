#!/bin/bash
# combat.sh — сквозной боевой сценарий (отдельно от run.sh: ~3–4 мин).
# Бот → лесорубы → 28 брёвен → казарма → трое воинов → приказ на вражескую
# ратушу → у врага падает hp. Ответный урон не гарантирован и не выдаётся за
# проверку (защитники могут стоять далеко); картинка HP/завала — test_combat_fx.
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
"$GODOT" --headless --path . -s res://tests/test_combat_scenario.gd
