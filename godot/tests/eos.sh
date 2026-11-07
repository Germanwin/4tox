#!/bin/bash
# eos.sh — приёмка отдельного режима EOS.
#
#   ./tests/eos.sh
#
# Туннель: хозяин поднимает Node, гость входит по коду через транспорт-петлю,
# получает WLD1 и 4TX1, команда гостя применяется.
# Экран: пункт меню, свой экран, отказ без ключей Epic, комната на петле.
# Порог: 0 FAIL в обоих прогонах.
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
echo "=== eos tunnel"
"$GODOT" --headless --path . -s res://tests/test_eos_tunnel.gd
echo "=== eos mode"
"$GODOT" --headless --path . -s res://tests/test_eos_mode.gd
echo "=== eos pair (настоящий EOS, если есть ключи)"
./tests/eos_pair.sh
