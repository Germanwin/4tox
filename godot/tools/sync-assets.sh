#!/bin/bash
# sync-assets.sh — копии атласов и моделей из исходных папок 4tox.
#
# godot/assets/** и godot/models/** — это КОПИИ mapgen2/assets/** и
# art/**/out/*.glb. Они лежат в проекте, чтобы Godot не ходил по путям вне
# res:// (импорт так не работает). Скрипт повторяет ровно то, что уже лежит:
# после правки атласа в mapgen2/ или модели в art/ его достаточно запустить.
#
# Запуск: ./tools/sync-assets.sh [--dry-run]
set -e
cd "$(dirname "$0")/.."          # godot/
ROOT="$(cd .. && pwd)"
DRY=""
if [ "$1" = "--dry-run" ]; then DRY="--dry-run"; fi

echo "== атласы: mapgen2/assets/ → godot/assets/"
rsync -a --itemize-changes $DRY "$ROOT/mapgen2/assets/" assets/ | tail -20

echo "== модели: art/*/*/out/*.glb → godot/models/"
mkdir -p models
count=0
for f in "$ROOT"/art/*/*/out/*.glb; do
  [ -e "$f" ] || continue
  pack="$(basename "$(dirname "$(dirname "$f")")")"
  name="${pack}_$(basename "$f")"
  cp -p $DRY "$f" "models/$name" 2>/dev/null || true
  count=$((count + 1))
done
echo "  моделей: $count"

echo "== проверка: в assets/ нет пустых каталогов"
find assets -type d -empty -print

echo "готово. Откройте проект в Godot — он импортирует новые файлы сам."
