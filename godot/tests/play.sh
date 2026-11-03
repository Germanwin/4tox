#!/bin/bash
# play.sh — приёмка игры мышью: сценарий §6 промпта через настоящие InputEvent
# в собранной сцене приложения (меню → «Играть» → сервер → найм лесорубов →
# брёвна → стройка с призраком → правка/поворот/перенос/снос → казарма и
# воин → меню не пауза).
#
#   ./tests/play.sh            # структурный прогон (headless, ~3 мин)
#   ./tests/play.sh --shots    # то же с окном: кадры в shots/play_*.png
#
# Порог: 0 FAIL. Скриншоты — доказательство, а не замена проверок.
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
if [ "$1" = "--shots" ]; then
  echo "=== игра мышью + кадры"
  "$GODOT" --path . -s res://tests/test_play.gd
else
  echo "=== игра мышью"
  "$GODOT" --headless --path . -s res://tests/test_play.gd
fi
