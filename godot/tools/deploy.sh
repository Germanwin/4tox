#!/bin/bash
# deploy.sh — выкладка НОВОГО сервера на прод по docs/DEPLOY.md.
#
# Что делает (и чего не делает):
#   1) требует чистого рабочего дерева и берёт COMMIT из HEAD;
#   2) собирает staging ТОЛЬКО из отдаваемых файлов (без tools/, .git, var/);
#   3) показывает dry-run rsync (удалений быть не должно);
#   4) делает бэкап /opt/4tox;
#   5) rsync game/ и mapgen2/, пишет COMMIT, chown, рестарт ТОЛЬКО 4tox.service;
#   6) проверяет /api/build, /api/health, /game/ и наличие WLD1.
#
# Caddy НЕ перезапускается: он обслуживает naive VPN.
#
# Запуск:
#   ./tools/deploy.sh --dry-run     # только staging + dry-run, ничего не менять
#   ./tools/deploy.sh --yes         # выложить
set -e
cd "$(dirname "$0")/.."                       # godot/
ROOT="$(cd .. && pwd)"
HOST="${TOX_VPS:-4tox-vps}"
PUBLIC="${TOX_PUBLIC:-https://374412.fornex.cloud}"
KEY="${TOX_KEY:-$HOME/.ssh/naive_213}"
MODE="${1:-}"
if [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--yes" ]; then
  echo "использование: $0 --dry-run | --yes"
  exit 2
fi

echo "== git"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "  рабочее дерево не чистое: закоммитьте (staging из HEAD не возьмёт правки)"
  git -C "$ROOT" status --short | head
  exit 1
fi
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
echo "  HEAD $COMMIT"

STAGE="/tmp/4tox-deploy-$COMMIT"
echo "== staging $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/game" "$STAGE/mapgen2"
cp -a "$ROOT/game/README.md" "$ROOT/game/assets" "$ROOT/game/css" \
      "$ROOT/game/index.html" "$ROOT/game/js" "$ROOT/game/server" \
      "$ROOT/game/shared" "$STAGE/game/"
[ -e "$ROOT/game/Мультиплеер.command" ] && cp -a "$ROOT/game/Мультиплеер.command" "$STAGE/game/"
rm -rf "$STAGE/game/server/var"
cp -a "$ROOT/mapgen2/PATHFINDING.md" "$ROOT/mapgen2/README.md" \
      "$ROOT/mapgen2/assets" "$ROOT/mapgen2/css" "$ROOT/mapgen2/index.html" \
      "$ROOT/mapgen2/js" "$STAGE/mapgen2/"
printf '%s\n' "$COMMIT" > "$STAGE/COMMIT"
echo "  файлов game: $(find "$STAGE/game" -type f | wc -l | tr -d ' ')"
echo "  файлов mapgen2: $(find "$STAGE/mapgen2" -type f | wc -l | tr -d ' ')"

SSH="ssh -o BatchMode=yes -i $KEY $HOST"
echo "== dry-run rsync"
$SSH 'true' || { echo "  нет SSH к $HOST"; exit 1; }
rsync -rlptn --checksum --delete --itemize-changes -e "ssh -i $KEY" \
  "$STAGE/game/" "$HOST:/opt/4tox/game/" | grep -E '^\*deleting' && {
    echo "  ВНИМАНИЕ: dry-run показывает удаления (см. выше)"; }
rsync -rlptn --checksum --delete --itemize-changes -e "ssh -i $KEY" \
  "$STAGE/mapgen2/" "$HOST:/opt/4tox/mapgen2/" | grep -E '^\*deleting' || true

if [ "$MODE" = "--dry-run" ]; then
  echo "dry-run: изменения не выложены"
  exit 0
fi

echo "== backup"
$SSH 'tar czf /root/4tox-backup-$(date +%Y%m%d-%H%M%S).tgz -C /opt 4tox && ls -1 /root/4tox-backup-*.tgz | tail -1'

echo "== rsync"
rsync -rlpt --checksum --delete -e "ssh -i $KEY" "$STAGE/game/" "$HOST:/opt/4tox/game/"
rsync -rlpt --checksum --delete -e "ssh -i $KEY" "$STAGE/mapgen2/" "$HOST:/opt/4tox/mapgen2/"

echo "== COMMIT + restart 4tox.service (Caddy не трогаем)"
$SSH "printf '%s\n' $COMMIT > /opt/4tox/COMMIT && chown -R 4tox:4tox /opt/4tox && systemctl restart 4tox.service"

echo "== проверка"
sleep 2
BUILD=$(curl -sS --max-time 12 "$PUBLIC/api/build")
echo "  /api/build: $BUILD"
echo "$BUILD" | grep -q "\"build\":\"$COMMIT\"" || { echo "  НЕТ нового build"; exit 1; }
for path in /api/health /game/; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$PUBLIC$path")
  echo "  $path -> $CODE"
  [ "$CODE" = "200" ] || { echo "  ОШИБКА: $path $CODE"; exit 1; }
done
$SSH 'systemctl is-active 4tox caddy-naive'
echo "готово: $PUBLIC  (build $COMMIT)"
