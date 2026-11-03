#!/usr/bin/env bash
# collect-static.sh — снимок «что за код» без браузера и без сети.
#
# Собирает в пакет: историю git, список файлов и хешей, копию исходников,
# diff последнего патча и diff рабочего дерева.
#
# Запуск (из корня распакованного пакета, репозиторий рядом):
#     tools/collect-static.sh /путь/к/4tox
# или из самого репозитория:
#     research/passport-2026-10-27/tools/collect-static.sh .
#
# Переменные:
#     BASE   — коммит ДО последнего патча (по умолчанию dc75820)
#     OUT    — куда писать (по умолчанию каталог пакета)
#
# Секретов не пишет: URL удалённого репозитория очищается от user:pass@,
# содержимое ~/.ssh и переменных окружения не копируется.
set -euo pipefail

REPO="${1:-.}"
BASE="${BASE:-dc75820}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$(cd "$HERE/.." && pwd)}"

cd "$REPO"
REPO="$(pwd)"
mkdir -p "$OUT/versions" "$OUT/source" "$OUT/diffs"

echo "репозиторий: $REPO"
echo "пакет:       $OUT"
echo "base:        $BASE"

# ---------------------------------------------------------------- git facts
{
  echo "# git status --short"
  git status --short || true
  echo
  echo "# git remote -v (credentials вырезаны)"
  git remote -v | sed -E 's#(https?://)[^@/]+@#\1***@#g'
  echo
  echo "# git branch -avv"
  git branch -avv
  echo
  echo "# git rev-parse HEAD"
  git rev-parse HEAD
  echo
  echo "# git describe --always --dirty"
  git describe --always --dirty 2>/dev/null || true
  echo
  echo "# git log -40 --date=iso-strict --format=fuller"
  git log -40 --date=iso-strict --format=fuller
  echo
  echo "# коммиты BASE..HEAD (первая ветка)"
  git log --first-parent --format='%H %ad %an %s' --date=iso-strict "$BASE"..HEAD
  echo
  echo "# всего коммитов BASE..HEAD"
  git rev-list --count "$BASE"..HEAD
} > "$OUT/versions/git.txt"

{
  echo "# diff --stat $BASE..HEAD"
  git diff --stat "$BASE"..HEAD
  echo
  echo "# diff --shortstat $BASE..HEAD"
  git diff --shortstat "$BASE"..HEAD
  echo
  echo "# diff --stat рабочего дерева против HEAD"
  git diff --stat HEAD
  echo
  echo "# неотслеживаемые файлы (git status --porcelain, ?? строки)"
  git status --porcelain | grep '^??' || echo "(нет)"
} > "$OUT/versions/diffstat.txt"

# ------------------------------------------------------- hashes of JS/HTML
{
  echo "# sha256 исходников, которые грузит браузер (HEAD)"
  for f in game/index.html mapgen2/index.html game/js/*.js mapgen2/js/*.js game/css/*.css; do
    [ -f "$f" ] && printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"
  done
  echo
  echo "# sha256 серверных файлов"
  for f in game/server/*.js game/server/README.md; do
    [ -f "$f" ] && printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"
  done
} > "$OUT/versions/source-hashes.txt"

# --------------------------------------------------------- atlas manifest
# Полные атласы в пакет не кладутся (тяжёлые), но их размеры и хеши нужны:
# по ним видно, подменяли ли графику между версиями.
{
  echo "# atlas | width x height | bytes | sha256"
  if [ -d mapgen2/assets ]; then
    find mapgen2/assets -type f \( -name '*.png' -o -name '*.json' \) | sort | while read -r f; do
      sz=$(wc -c < "$f" | tr -d ' ')
      hash=$(shasum -a 256 "$f" | awk '{print $1}')
      wh=$(python3 - "$f" <<'PY' 2>/dev/null || echo "-"
import sys, struct
p = sys.argv[1]
if not p.lower().endswith('.png'):
    print('-'); raise SystemExit
d = open(p,'rb').read(33)
if d[:8] != b'\x89PNG\r\n\x1a\n':
    print('-'); raise SystemExit
w, h = struct.unpack('>II', d[16:24])
print('%dx%d' % (w, h))
PY
)
      printf '%s | %s | %s | %s\n' "$f" "$wh" "$sz" "$hash"
    done
  fi
} > "$OUT/versions/atlas-manifest.txt"

# ------------------------------------------------------------- source copy
# Удобная копия для ревью: ровно то, что исполняется, плюс тесты и правила.
rm -rf "$OUT/source"
mkdir -p "$OUT/source"
copy() { # copy <path> [dest]
  if [ -e "$1" ]; then
    mkdir -p "$OUT/source/$(dirname "$1")"
    cp -R "$1" "$OUT/source/$1"
  fi
}
for d in game/js game/css game/server mapgen2/js mapgen2/css; do copy "$d"; done
for f in game/index.html mapgen2/index.html AGENTS.md README.md docs/STRUCTURE.md \
         docs/DEPLOY.md docs/PIPELINE.md mapgen2/PATHFINDING.md game/README.md \
         game/server/README.md mapgen2/README.md; do copy "$f"; done
mkdir -p "$OUT/source/tests"
for f in game/tools/*.js mapgen2/tools/*.js; do
  base=$(basename "$f")
  # Атласы и ассеты — не тесты; сюда попадают только скрипты.
  cp "$f" "$OUT/source/tests/$base" 2>/dev/null || true
done

{
  echo "# source/, состав"
  cd "$OUT/source" && find . -type f | sort
} > "$OUT/versions/source-listing.txt"
cd "$REPO"

# ------------------------------------------------------------------ diffs
git diff "$BASE"..HEAD > "$OUT/diffs/final-stabilization-$BASE..HEAD.diff"
git diff --stat "$BASE"..HEAD > "$OUT/diffs/final-stabilization.stat.txt"
git diff "$BASE"..HEAD -- game mapgen2 AGENTS.md docs > "$OUT/diffs/final-stabilization-code.diff"
git diff "$BASE"..HEAD -- research > "$OUT/diffs/final-stabilization-research.diff"
git diff --stat HEAD > "$OUT/diffs/worktree.stat.txt"
git diff HEAD > "$OUT/diffs/worktree.diff"
git status --porcelain > "$OUT/diffs/worktree.status.txt"

# Отдельно: правки, которые меняли частоту сети, сглаживание, таймеры и
# обработку фона. Это не «намерение», а фактический список кусков diff.
{
  echo "# куски final-stabilization, меняющие частоту/сглаживание/таймеры/фон"
  git diff "$BASE"..HEAD -U0 | grep -nE '^(\+\+\+|@@)' > "$OUT/diffs/touchpoints.index.txt" || true
} > "$OUT/diffs/touchpoints.index.txt"

echo "готово: $OUT"
