#!/bin/bash
# test_windows_installer.sh — приёмка установщика 4tox для Windows.
#
# Проверяет не «файл существует», а то, без чего игра на Windows не
# запустится: 64-битный exe со встроенным PCK, Windows-node рядом с сервером,
# полный серверный бандл, содержимое setup.exe и живой /api/health.
#
# Запуск: ./tests/test_windows_installer.sh
set -u
cd "$(dirname "$0")/.."                 # godot/
ROOT="$(pwd)"
OUT="$ROOT/build"
VER="$(grep -m1 '^application/product_version=' export_presets.cfg | cut -d'"' -f2 | sed 's/\.0$//')"
APP="$OUT/win/app"
SETUP="$OUT/4tox-$VER-windows-setup.exe"
ZIP="$OUT/4tox-$VER-windows-portable.zip"

pass=0
fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "== файлы"
check "setup.exe собран"            "[ -f \"$SETUP\" ]"
check "portable zip собран"         "[ -f \"$ZIP\" ]"
check "4tox.exe на месте"           "[ -f \"$APP/4tox.exe\" ]"
check "node.exe на месте"           "[ -f \"$APP/server/node.exe\" ]"
check "server.js на месте"          "[ -f \"$APP/server/game/server/server.js\" ]"
check "game/shared на месте"        "[ -f \"$APP/server/game/shared/net-wire.js\" ]"
check "mapgen2/js на месте"         "[ -f \"$APP/server/mapgen2/js/session.js\" ]"
check "EOS SDK рядом с exe"         "[ -f \"$APP/EOSSDK-Win64-Shipping.dll\" ]"
check "VC runtime рядом с exe"      "[ -f \"$APP/msvcp140.dll\" ] && [ -f \"$APP/vcruntime140.dll\" ] && [ -f \"$APP/vcruntime140_1.dll\" ]"

echo "== разрядность и формат"
check "4tox.exe — PE32+ x86-64"     "file \"$APP/4tox.exe\" | grep -q 'PE32+ executable (GUI) x86-64'"
check "node.exe — PE32+ x86-64"     "file \"$APP/server/node.exe\" | grep -q 'PE32+ executable (console) x86-64'"
check "setup.exe — PE32+ x86"       "file \"$SETUP\" | grep -q 'PE32'"
check "в 4tox.exe встроен PCK"      "[ \"\$(tail -c 4 \"$APP/4tox.exe\")\" = 'GDPC' ]"
check "node.exe не из macOS"        "! file \"$APP/server/node.exe\" | grep -q 'Mach-O'"

echo "== сервер из бандла"
STATE="$(mktemp -d)"
LOG="$STATE/server.log"
PORT=$(( 18900 + (RANDOM % 100) ))
"$(command -v node)" "$APP/server/game/server/server.js" \
  --local --no-upnp --port "$PORT" --state-dir "$STATE/rooms" --log-file "$LOG" \
  >/dev/null 2>&1 &
PID=$!
health=0
for _ in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then health=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.25
done
check "сервер ответил /api/health"  "[ \"$health\" = '1' ]"
if [ "$health" = '1' ]; then
  BUILD="$(curl -sf "http://127.0.0.1:$PORT/api/health" | sed -n 's/.*\"build\":\"\([^\"]*\)\".*/\1/p')"
  check "build в ответе непустой"   "[ -n \"$BUILD\" ]"
fi
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
rm -rf "$STATE"

echo "== содержимое установщика"
if command -v 7z >/dev/null 2>&1; then
  LIST="$(7z l -slt "$SETUP" 2>/dev/null)"
  check "в setup есть 4tox.exe"     "printf '%s' \"\$LIST\" | grep -q 'Path = 4tox.exe'"
  check "в setup есть node.exe"     "printf '%s' \"\$LIST\" | grep -q 'Path = server/node.exe'"
  check "в setup есть server.js"    "printf '%s' \"\$LIST\" | grep -q 'Path = server/game/server/server.js'"
  check "в setup есть README"       "printf '%s' \"\$LIST\" | grep -q 'Path = README-WINDOWS.txt'"
  check "в setup есть VC runtime"   "printf '%s' \"\$LIST\" | grep -q 'Path = msvcp140.dll'"
  check "setup целый (7z t)"        "7z t \"$SETUP\" 2>/dev/null | grep -q 'Everything is Ok'"
  # Uninstall.exe создаётся WriteUninstaller при установке, поэтому в списке
  # файлов его нет; проверяем, что деинсталлятор вообще собран в скрипт.
  check "деинсталлятор прописан"    "grep -q 'WriteUninstaller' tools/windows/installer.nsi"
  check "установка в профиль"       "grep -q 'LOCALAPPDATA.Programs.4tox' tools/windows/installer.nsi"
  check "sha256 совпадает"          "(cd \"$OUT\" && shasum -a 256 -c SHA256SUMS-windows.txt >/dev/null 2>&1)"
  check "portable zip целый"        "unzip -tq \"$ZIP\" >/dev/null 2>&1"
  check "в portable есть node.exe"  "unzip -l \"$ZIP\" | grep -q 'server/node.exe'"
else
  bad "нет 7z — содержимое setup.exe не проверено"
fi

echo
echo "PASS $pass · FAIL $fail"
[ "$fail" -eq 0 ]
