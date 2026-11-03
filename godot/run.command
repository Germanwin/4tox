#!/bin/bash
# Запуск 4tox — Godot без редактора.
cd "$(dirname "$0")"
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
if [ ! -x "$GODOT" ]; then
  echo "Godot не найден: $GODOT"
  echo "Укажи путь: GODOT=/путь/к/Godot ./run.command"
  exit 1
fi
exec "$GODOT" --path . "$@"
