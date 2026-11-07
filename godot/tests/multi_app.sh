#!/bin/bash
# Приёмка macOS-упаковки: повторный клик по 4tox.app открывает НОВОЕ окно,
# а не активирует старое. Обёртка-лаунчер запускает вложенный клиент через
# `open -n` и сразу выходит; клиент лежит отдельным .app со своим bundle id.
#
# Если 4tox.app уже собран с обёрткой (tools/package.sh), проверяется он сам.
# Если лежит только «плоский» клиент — он заворачивается во временный .app.
# Запускается на macOS с живой графической сессией.
set -u
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: не macOS"
  exit 0
fi

OUT="build/macos/4tox.app"
REAL="$OUT/Contents/Resources/4tox-client.app"
if [ -d "$REAL" ]; then
  echo "  проверяем собранный $OUT"
else
  REAL="build/macos/4tox-client.app"
  [ -d "$REAL" ] || REAL="build/macos/4tox.app"
  if [ ! -d "$REAL" ]; then
    echo "SKIP: нет собранного приложения (сначала ./tools/package.sh)"
    exit 0
  fi
  OUT="/tmp/4tox-multi-acceptance.app"
  rm -rf "$OUT"
  if [ ! -x "tools/wrap_macos.sh" ]; then
    echo "ОШИБКА: нет tools/wrap_macos.sh"
    exit 1
  fi
  ./tools/wrap_macos.sh "$REAL" "$OUT" || exit 1
  REAL="$OUT/Contents/Resources/4tox-client.app"
fi

LAUNCHER="$OUT/Contents/MacOS/launcher"
[ -x "$LAUNCHER" ] || { echo "ОШИБКА: в $OUT нет launcher"; exit 1; }
[ -x "$REAL/Contents/MacOS/4tox" ] || { echo "ОШИБКА: в $OUT нет клиента"; exit 1; }
if command -v codesign >/dev/null 2>&1; then
  codesign --verify --deep --strict "$REAL" >/dev/null 2>&1 \
    || { echo "ОШИБКА: подпись клиента не проверяется"; exit 1; }
  REQ=$(codesign -d -r- "$REAL" 2>&1)
  case "$REQ" in
    *'identifier "cloud.fornex.tox4"'*) ;;
    *) echo "ОШИБКА: нет стабильного requirement: $REQ"; exit 1 ;;
  esac
  case "$REQ" in
    *cdhash*) echo "ОШИБКА: requirement привязан к хешу сборки: $REQ"; exit 1 ;;
  esac
fi
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$OUT/Contents/Info.plist" 2>/dev/null)" = \
     "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$REAL/Contents/Info.plist" 2>/dev/null)" ]; then
  echo "ОШИБКА: у лаунчера и клиента один bundle id — macOS снова активирует старое окно"
  exit 1
fi

# CLI-путь не должен отцеплять копию: --headless проходит через настоящий
# бинарник и завершается сам.
if ! "$LAUNCHER" --headless --quit-after 30 > /tmp/4tox-multi-cli.log 2>&1; then
  echo "ОШИБКА: --headless через лаунчер упал"
  tail -20 /tmp/4tox-multi-cli.log
  exit 1
fi
grep -q "Godot Engine" /tmp/4tox-multi-cli.log || {
  echo "ОШИБКА: --headless не дошёл до клиента"
  cat /tmp/4tox-multi-cli.log
  exit 1
}

PATTERN="$REAL/Contents/MacOS/4tox"
DATA="$HOME/Library/Application Support/Godot/app_userdata/4tox/instances"
pkill -f "$PATTERN" 2>/dev/null || true
pkill -f "$REAL/Contents/Resources/server/game/server/server.js" 2>/dev/null || true
sleep 0.5
# Замки прошлых прогонов не должны сдвигать номера: проверяем именно 1/2/3.
rm -rf "$DATA"/client-*
for i in 1 2 3; do
  open "$OUT" --args --quit-after 300
  sleep 1.2
done
COUNT=$(pgrep -f "$PATTERN" | wc -l | tr -d ' ')
echo "живых клиентов после трёх кликов: $COUNT"
# Разные номера окон видны по живым замкам user://instances/client-N.
NOW=$(date +%s)
LOCKS=0
for f in "$DATA"/client-*/alive; do
  [ -f "$f" ] || continue
  T=$(stat -f %m "$f" 2>/dev/null || echo 0)
  if [ $((NOW - T)) -le 5 ]; then LOCKS=$((LOCKS + 1)); fi
done
echo "живых замков-профилей: $LOCKS"
pkill -f "$PATTERN" 2>/dev/null || true
pkill -f "$REAL/Contents/Resources/server/game/server/server.js" 2>/dev/null || true
rm -rf "$DATA"/client-*
if [ "$COUNT" -lt 3 ]; then
  echo "ОШИБКА: очередной клик не открыл новое окно (клиентов $COUNT)"
  exit 1
fi
if [ "$LOCKS" -lt 3 ]; then
  echo "ОШИБКА: у окон не разошлись номера (замков $LOCKS)"
  exit 1
fi
echo "MULTI APP PASSED: три клика — три клиента"
