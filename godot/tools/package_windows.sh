#!/bin/bash
# package_windows.sh — установщик 4tox для Windows x64.
#
# Что делает:
#   1) экспортирует 4tox.exe из Godot (шаблоны Windows той же версии);
#   2) собирает рядом server/ с game/, mapgen2/js и настоящим node.exe;
#   3) проверяет серверный бандл живым /api/health (тем JS, что уедет);
#   4) собирает setup.exe (NSIS, установка в профиль, без UAC) и portable zip.
#
# Требуется: Godot 4.7.2 с шаблонами Windows, makensis, 7z не нужен.
# Запуск: godot/tools/package_windows.sh [--skip-export]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # godot/
REPO="$(cd "$ROOT/.." && pwd)"
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
OUT="$ROOT/build"
STAGE="$OUT/win/app"
SKIP_EXPORT=0
[ "${1:-}" = "--skip-export" ] && SKIP_EXPORT=1

VER="$(grep -m1 '^application/product_version=' "$ROOT/export_presets.cfg" | cut -d'"' -f2 | sed 's/\.0$//')"
if [ -z "$VER" ]; then echo "ОШИБКА: не нашёл версию в export_presets.cfg" >&2; exit 1; fi
echo "== 4tox $VER для Windows x64"

if [ "$SKIP_EXPORT" = 0 ]; then
  echo "== экспорт Godot"
  mkdir -p "$OUT/win"
  rm -f "$OUT/win/4tox.exe"
  "$GODOT" --headless --path "$ROOT" --export-release "Windows" "$OUT/win/4tox.exe"
else
  [ -f "$OUT/win/4tox.exe" ] || { echo "нет $OUT/win/4tox.exe" >&2; exit 1; }
fi

echo "== сборка каталога приложения"
rm -rf "$STAGE"
mkdir -p "$STAGE/server/game/server" "$STAGE/server/mapgen2"
cp "$OUT/win/4tox.exe" "$OUT/win/EOSSDK-Win64-Shipping.dll" \
   "$OUT/win/libeosg.windows.template_release.x86_64.dll" \
   "$OUT/win/xaudio2_9redist.dll" "$STAGE/"
# EOSSDK тянет MSVCP140/VCRUNTIME140: на чистой Windows без VC++ Redist
# расширение EOS не загрузится. Кладём app-local, Microsoft это разрешает.
cp "$ROOT/tools/windows/vc-runtime/"*.dll "$STAGE/"

# Сервер — те же JS-файлы, что в репозитории; var/ (состояние) не тащим.
rsync -a "$REPO/game/shared" "$STAGE/server/game/"
rsync -a --exclude 'var' "$REPO/game/server/." "$STAGE/server/game/server/"
rsync -a "$REPO/mapgen2/js" "$STAGE/server/mapgen2/"

NODE_DIR="$("$ROOT/tools/windows/fetch-node.sh")"
cp "$NODE_DIR/node.exe" "$STAGE/server/node.exe"

# Один и тот же build-id в health и в логе: по нему видно, что запущено.
BUILD_ID="${BUILD_ID:-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo dev)-win}"
printf '%s\n' "$BUILD_ID" > "$STAGE/server/COMMIT"

cp "$ROOT/tools/windows/README-WINDOWS.txt" "$STAGE/README-WINDOWS.txt"

echo "== проверка серверного бандла (JS + host node)"
PORT=$(( 18800 + (RANDOM % 100) ))
STATE="$(mktemp -d)"
"$(command -v node)" "$STAGE/server/game/server/server.js" \
  --local --no-upnp --port "$PORT" --state-dir "$STATE/rooms" \
  --log-file "$STATE/server.log" >/dev/null 2>&1 &
PID=$!
ok=0
for _ in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.25
done
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
if [ "$ok" != 1 ]; then
  echo "ОШИБКА: сервер из бандла не ответил; лог $STATE/server.log" >&2
  tail -20 "$STATE/server.log" >&2 || true
  exit 1
fi
echo "  /api/health ответил на порту $PORT"
rm -rf "$STATE"

echo "== установщик NSIS"
SETUP="$OUT/4tox-$VER-windows-setup.exe"
rm -f "$SETUP"
# NSIS на macOS читает UTF-8 только при UTF-8-локали (баг NSIS #1165):
# с LANG=C кириллица даёт «Bad text encoding», а Unicode-сборка падает.
LANG=en_GB.UTF-8 LC_ALL=en_GB.UTF-8 makensis -V2 \
  -DAPP_VERSION="$VER" \
  -DSOURCE_DIR="$STAGE" \
  -DOUT_FILE="$SETUP" \
  -DICON_FILE="$ROOT/icon.ico" \
  "$ROOT/tools/windows/installer.nsi"

echo "== portable zip"
ZIP="$OUT/4tox-$VER-windows-portable.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qry "$ZIP" 4tox.exe EOSSDK-Win64-Shipping.dll \
    libeosg.windows.template_release.x86_64.dll xaudio2_9redist.dll \
    msvcp140.dll vcruntime140.dll vcruntime140_1.dll \
    README-WINDOWS.txt server )

echo "== контрольные суммы"
( cd "$OUT" && shasum -a 256 "4tox-$VER-windows-setup.exe" "4tox-$VER-windows-portable.zip" \
    > "SHA256SUMS-windows.txt" && cat "SHA256SUMS-windows.txt" )

ls -lh "$SETUP" "$ZIP"
echo "готово"
