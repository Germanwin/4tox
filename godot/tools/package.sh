#!/bin/bash
# package.sh — сборка приложения и бандла Node рядом с ним.
#
# Что делает:
#   1) проверяет шаблоны экспорта Godot;
#   2) собирает .app (macOS) или .exe (Windows) через export_presets.cfg;
#   3) кладёт рядом каталог server/ с game/, mapgen2/, game/server и node,
#      чтобы ServerSupervisor нашёл их без репозитория;
#   4) запускает собранный сервер и ждёт /api/health.
#
# Шаблоны экспорта НЕ входят в Godot.app: их скачивают в
#   ~/Library/Application Support/Godot/export_templates/<версия>/
# (Godot → Editor → Manage Export Templates). Без них шаг 2 честно падает.
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."                # godot/
ROOT="$(cd .. && pwd)"
VER="$("$GODOT" --version | sed -E 's/.*\.stable.*//; s/^([0-9]+\.[0-9]+(\.[0-9]+)?).*/\1/')"
TPL_DIR="$HOME/Library/Application Support/Godot/export_templates"
echo "== шаблоны экспорта"
if ! ls "$TPL_DIR" 2>/dev/null | grep -q .; then
  echo "  НЕТ шаблонов экспорта в $TPL_DIR"
  echo "  Откройте Godot → Editor → Manage Export Templates → Download."
  echo "  Без них .app/.exe не собрать; run.command при этом работает."
  exit 2
fi

OUT="build"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "== macOS"
"$GODOT" --headless --path . --export-release "macOS" "$OUT/macos/4tox.app"

echo "== Windows"
if "$GODOT" --headless --path . --export-release "Windows" "$OUT/windows/4tox.exe"; then
  echo "  windows: $OUT/windows/4tox.exe"
else
  echo "  windows: НЕ собрано (нет шаблона Windows)"
fi

echo "== бандл Node"
bundle_server() {
  local dest="$1"           # каталог, где приложение ищет server/
  mkdir -p "$dest/game/server" "$dest/mapgen2"
  cp -R "$ROOT/game/shared" "$dest/game/"
  cp -R "$ROOT/game/server/." "$dest/game/server/"
  rm -rf "$dest/game/server/var"
  cp -R "$ROOT/mapgen2/js" "$dest/mapgen2/"
  cp -R "$ROOT/mapgen2/assets" "$dest/mapgen2/"
  cp "$ROOT/package.json" "$dest/" 2>/dev/null || true
  local node_bin
  node_bin="$(command -v node || true)"
  if [ -n "$node_bin" ]; then
    cp "$node_bin" "$dest/node"
    chmod +x "$dest/node"
  else
    echo "  ВНИМАНИЕ: node не найден; положите его в $dest/node"
  fi
}
bundle_server "$OUT/macos/4tox.app/Contents/Resources/server"
bundle_server "$OUT/windows/server"

echo "== проверка собранного сервера"
S="$OUT/macos/4tox.app/Contents/Resources/server"
PORT=8861
"$S/node" "$S/game/server/server.js" --local --no-upnp --port $PORT \
  --state-dir "$OUT/state" --log-file "$OUT/server.log" >/dev/null 2>&1 &
PID=$!
ok=0
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then ok=1; break; fi
  sleep 0.25
done
kill "$PID" 2>/dev/null || true
if [ "$ok" = "1" ]; then
  echo "  /api/health ответил — бандл сервера рабочий"
else
  echo "  ОШИБКА: сервер из бандла не ответил; лог $OUT/server.log"
  exit 1
fi
echo "готово: $OUT/"
