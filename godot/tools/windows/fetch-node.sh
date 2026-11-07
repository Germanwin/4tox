#!/bin/bash
# fetch-node.sh — Windows-сборка Node.js для бандла рядом с игрой.
#
# Кладёт node.exe в build/cache/node-v<версия>-win-x64/ и печатает путь
# к каталогу. Скачивание один раз, сумма сверяется по SHASUMS256.txt с
# nodejs.org: подменённый архив не пройдёт.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # godot/
NODE_VERSION="${NODE_VERSION:-24.12.0}"
CACHE="${NODE_CACHE:-$ROOT/build/cache}"
DEST="$CACHE/node-v$NODE_VERSION-win-x64"
ZIP="$CACHE/node-v$NODE_VERSION-win-x64.zip"

if [ -f "$DEST/node.exe" ] && ! file "$DEST/node.exe" | grep -q 'Mach-O'; then
  echo "$DEST"
  exit 0
fi

mkdir -p "$CACHE"
if [ ! -f "$ZIP" ]; then
  echo "== скачиваем Node.js v$NODE_VERSION для Windows x64" >&2
  curl -fL --retry 3 --connect-timeout 20 \
    -o "$ZIP.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip"
  mv "$ZIP.part" "$ZIP"
fi

EXPECTED="$(curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
  | grep " node-v$NODE_VERSION-win-x64.zip\$" | awk '{print $1}')"
ACTUAL="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "ОШИБКА: sha256 node.exe не совпал (ожидали $EXPECTED, получили $ACTUAL)" >&2
  exit 1
fi

rm -rf "$DEST"
unzip -q -o "$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" -d "$CACHE"
if ! file "$DEST/node.exe" | grep -q 'PE32+ executable'; then
  echo "ОШИБКА: внутри архива не Windows-node.exe" >&2
  exit 1
fi
echo "$DEST"
