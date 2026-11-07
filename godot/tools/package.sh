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

# Куда класть сборку. Переопределяется OUT=... — так можно собрать в
# сторонний каталог, не трогая работающую сборку в build/.
OUT="${OUT:-build}"
# Каталоги сборки чистим по отдельности: build/cache (node.exe) и готовый
# установщик Windows не должны исчезать из-за пересборки .app.
rm -rf "$OUT/macos" "$OUT/windows"
mkdir -p "$OUT/macos" "$OUT/windows"

echo "== macOS (${EXPORT_MODE:-release})"
"$GODOT" --headless --path . --export-${EXPORT_MODE:-release} "macOS" "$OUT/macos/4tox-client.app"

echo "== Windows"
if "$GODOT" --headless --path . --export-release "Windows" "$OUT/windows/4tox.exe"; then
  echo "  windows: $OUT/windows/4tox.exe"
else
  echo "  windows: НЕ собрано (нет шаблона Windows)"
fi

echo "== бандл Node"
bundle_server() {
  local dest="$1"           # каталог, где приложение ищет server/
  local platform="$2"       # macos | windows
  mkdir -p "$dest/game/server" "$dest/mapgen2"
  cp -R "$ROOT/game/shared" "$dest/game/"
  cp -R "$ROOT/game/server/." "$dest/game/server/"
  rm -rf "$dest/game/server/var"
  cp -R "$ROOT/mapgen2/js" "$dest/mapgen2/"
  cp -R "$ROOT/mapgen2/assets" "$dest/mapgen2/"
  cp "$ROOT/package.json" "$dest/" 2>/dev/null || true
  if [ "$platform" = windows ]; then
    # На Windows нужен именно node.exe: macOS-бинарь там не запускается.
    local node_win
    node_win="$("$ROOT/godot/tools/windows/fetch-node.sh")"
    cp "$node_win/node.exe" "$dest/node.exe"
  else
    local node_bin
    node_bin="$(command -v node || true)"
    if [ -n "$node_bin" ]; then
      cp "$node_bin" "$dest/node"
      chmod +x "$dest/node"
    else
      echo "  ВНИМАНИЕ: node не найден; положите его в $dest/node"
    fi
  fi
}
bundle_server "$OUT/macos/4tox-client.app/Contents/Resources/server" macos
bundle_server "$OUT/windows/server" windows

echo "== проверка собранного сервера"
S="$OUT/macos/4tox-client.app/Contents/Resources/server"
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

echo "== обёртка macOS: повторный клик по 4tox.app открывает новое окно"
"$ROOT/godot/tools/wrap_macos.sh" "$OUT/macos/4tox-client.app" "$OUT/macos/4tox.app"
rm -rf "$OUT/macos/4tox-client.app"

APP="$(find "$OUT/macos/4tox.app/Contents/MacOS" -maxdepth 1 -type f -perm -111 2>/dev/null | head -1)"
if [ -n "$APP" ] && [ -x "$APP" ]; then
  echo "== smoke собранного .app: сервер внутри, мир и кадр"
  if "$APP" --headless -- --smoke > "$OUT/smoke.log" 2>&1; then
    grep -E "SMOKE" "$OUT/smoke.log" | tail -2
    echo "  приложение само подняло сервер и вошло в партию"
  else
    echo "  ОШИБКА: smoke .app не прошёл; лог $OUT/smoke.log"
    tail -20 "$OUT/smoke.log"
    exit 1
  fi
fi
# --- распространяемые архивы -------------------------------------------
if command -v hdiutil >/dev/null 2>&1 && [ -d "$OUT/macos/4tox.app" ]; then
  echo "== dmg macOS"
  rm -f "$OUT/4tox-macos.dmg"
  hdiutil create -quiet -volname "4tox" -srcfolder "$OUT/macos/4tox.app" \
    -ov -format UDZO "$OUT/4tox-macos.dmg"
  hdiutil attach -quiet -nobrowse -readonly "$OUT/4tox-macos.dmg"
  if [ -d "/Volumes/4tox/4tox.app" ]; then
    echo "  dmg смонтирован, 4tox.app внутри"
  else
    echo "  ОШИБКА: в dmg нет 4tox.app"; hdiutil detach -quiet "/Volumes/4tox"; exit 1
  fi
  hdiutil detach -quiet "/Volumes/4tox"
  ls -lh "$OUT/4tox-macos.dmg" | awk '{print "  "$5" "$9}'
fi
if command -v zip >/dev/null 2>&1 && [ -f "$OUT/windows/4tox.exe" ]; then
  echo "== zip Windows"
  # Абсолютный путь: после cd в $OUT/windows относительный "$OUT/..." уже не
  # тот, а прежний "$OLDPWD/$OUT" ломался, стоило задать OUT=/абсолютный/путь.
  ZIP="$(cd "$OUT" && pwd)/4tox-windows.zip"
  rm -f "$ZIP"
  (cd "$OUT/windows" && zip -qry "$ZIP" 4tox.exe server \
      EOSSDK-Win64-Shipping.dll libeosg.windows.template_release.x86_64.dll \
      xaudio2_9redist.dll 2>/dev/null)
  unzip -tq "$ZIP" >/dev/null
  echo "  zip целый: $(unzip -l "$ZIP" | tail -1 | awk '{print $2}') файлов"
  ls -lh "$ZIP" | awk '{print "  "$5" "$9}'
fi

echo "готово: $OUT/"
