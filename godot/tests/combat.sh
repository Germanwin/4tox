#!/bin/bash
# combat.sh — сквозной боевой сценарий (отдельно от run.sh: ~3–4 мин).
# Бот → лесорубы → 28 брёвен → казарма → трое воинов → приказ на вражеский
# лагерь → постройка становится завалом (rubble). Ответный урон и поражение
# не наблюдались и не выдаются за проверку; картинка HP/завала — test_combat_fx.
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
"$GODOT" --headless --path . -s res://tests/test_combat_scenario.gd
