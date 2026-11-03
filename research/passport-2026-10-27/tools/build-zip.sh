#!/usr/bin/env bash
# build-zip.sh — собрать финальный архив паспорта.
#
# Что делает:
#   1) копирует пакет в чистый каталог (без _smoke-прогонов, .DS_Store, следов);
#   2) вычищает из журналов и сэмплов приватные адреса (192.168.x, 10.x,
#      172.16-31.x, 25.x Hamachi) — они не нужны ревьюверу и это чужие данные;
#   3) пишет MANIFEST.sha256;
#   4) кладёт рядом zip.
#
# Запуск: tools/build-zip.sh [имя-архива]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
NAME="${1:-4tox-current-passport-$(date +%Y%m%d).zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
OUT="$STAGE/passport"
mkdir -p "$OUT"

echo "пакет: $PKG"
echo "имя:   $NAME"

# --- 1. копия без мусора
rsync -a \
  --exclude '.DS_Store' \
  --exclude 'runs/_smoke*' \
  --exclude 'runs/*/trace.json' \
  --exclude '*.zip' \
  "$PKG/" "$OUT/"

# --- 2. приватные адреса
echo "чищу приватные адреса в журналах и сэмплах…"
# Текст — всё, кроме картинок и архивов. Секретов в пакете нет, но приватные
# адреса машины и имя ssh-ключа ревьюверу не нужны.
find "$OUT" -type f ! -name '*.png' ! -name '*.jpg' ! -name '*.zip' \
     ! -name '*.glb' -print0 |
  while IFS= read -r -d '' f; do
    perl -i -pe '
      s/\b192\.168\.\d{1,3}\.\d{1,3}\b/<lan-ip>/g;
      s/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/<lan-ip>/g;
      s/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/<lan-ip>/g;
      s/\b25\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/<hamachi-ip>/g;
      s/naive_213/<ssh-key>/g;
      s/\b[A-Fa-f0-9]{2}(:[A-Fa-f0-9]{2}){5,}\b/<mac>/g;
    ' "$f"
  done

# --- 3. манифест
( cd "$OUT" && find . -type f ! -name 'MANIFEST.sha256' | sort | while read -r f; do
    printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "${f#./}"
  done > MANIFEST.sha256 )
echo "файлов: $(wc -l < "$OUT/MANIFEST.sha256" | tr -d ' ')"

# --- 4. архив
( cd "$OUT" && zip -q -r -X "../$NAME" . )
mv "$STAGE/$NAME" "$PKG/$NAME"
echo "готово: $PKG/$NAME ($(du -h "$PKG/$NAME" | awk '{print $1}'))"
