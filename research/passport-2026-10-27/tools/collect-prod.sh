#!/usr/bin/env bash
# collect-prod.sh — read-only снимок прода: что запущено и какие файлы реально
# отдаются браузерам.
#
# Ничего не меняет и не перезапускает: только cat/systemctl show/ps/ss и GET
# публичных адресов. Секретов не пишет: токенов и cookie нет, публичные GET
# идут без авторизации.
#
# Запуск: tools/collect-prod.sh [ssh-хост] [публичный-базовый-URL]
#   tools/collect-prod.sh 4tox-vps https://374412.fornex.cloud
set -uo pipefail

HOST="${1:-4tox-vps}"
PUB="${2:-https://374412.fornex.cloud}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$(cd "$HERE/.." && pwd)/versions}"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- служба
{
  echo "# read-only снимок прода, $(date -u '+%F %T UTC')"
  echo "# хост: $HOST, публичный адрес: $PUB"
  echo
  echo "## systemctl show 4tox"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
    "systemctl show 4tox -p ActiveState,SubState,MainPID,NRestarts,FragmentPath,WorkingDirectory,EnvironmentFiles --no-pager 2>&1; \
     echo; systemctl show 4tox -p ExecStart --no-pager 2>&1" | sed -E 's#(token|secret|password)=[^ ]*#\1=<hidden>#gI'
  echo
  echo "## процесс, память, время работы"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
    "P=\$(systemctl show -p MainPID --value 4tox); ps -o pid,ppid,etime,rss,vsz,%cpu,%mem,args -p \$P 2>&1; \
     echo; echo 'node:'; /opt/node/bin/node --version 2>/dev/null || node --version 2>/dev/null; \
     echo; echo 'версия ядра:'; uname -r; echo; echo 'uptime:'; uptime" 2>&1
  echo
  echo "## порты службы (только listen)"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
    "ss -ltnp 2>/dev/null | grep -E 'State|8787|:80 |:443 ' || true" 2>&1
  echo
  echo "## caddy: конфиг, относящийся к /game (без ключей)"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
    "systemctl is-active caddy-naive 2>/dev/null || systemctl is-active caddy 2>/dev/null; \
     grep -rn -A6 -B2 'game' /etc/caddy/Caddyfile 2>/dev/null | sed -E 's#(tls|key|token|password)[^ ]* .*#\1 <hidden>#gI' | head -60" 2>&1
  echo
  echo "## COMMIT в /opt/4tox"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "cat /opt/4tox/COMMIT 2>/dev/null; echo; ls -la /opt/4tox" 2>&1
} > "$OUT/prod-readonly.txt" 2>&1

# -------------------------------------------------------- что отдают браузеру
{
  echo "# GET публичных файлов: заголовки и sha256 ТЕЛА"
  echo "# время: $(date -u '+%F %T UTC')"
  for f in game/index.html game/js/boot.js game/js/play.js game/js/net.js \
           game/js/pending.js game/js/lobby.js game/js/hud.js game/js/menu.js \
           mapgen2/js/serialize.js mapgen2/js/render.js mapgen2/js/session.js \
           mapgen2/js/villager.js mapgen2/js/combat.js mapgen2/js/buildings.js; do
    url="$PUB/$f"
    hdr=$(curl -s -D - -o "$TMP/body" "$url" -H 'accept-encoding: identity' 2>/dev/null | tr -d '\r')
    code=$(printf '%s' "$hdr" | awk 'NR==1{print $2}')
    etag=$(printf '%s' "$hdr" | awk 'tolower($1)=="etag:"{print $2}')
    lm=$(printf '%s' "$hdr" | awk 'tolower($1)=="last-modified:"{$1="";print substr($0,2)}')
    cl=$(printf '%s' "$hdr" | awk 'tolower($1)=="content-length:"{print $2}')
    hash=$(shasum -a 256 < "$TMP/body" 2>/dev/null | awk '{print $1}')
    size=$(wc -c < "$TMP/body" | tr -d ' ')
    printf '%s | %s | %s | %s | %s | %s | %s\n' "$f" "$code" "$cl" "$size" "$hash" "${etag:-—}" "${lm:-—}"
  done
  echo
  echo "# /api/build"
  curl -s "$PUB/api/build" -H 'accept-encoding: identity' 2>/dev/null | head -c 600
  echo
} > "$OUT/prod-http.txt" 2>&1

# --------------------------------------------------------------- сборка
{
  echo "# что сервер сам говорит о себе"
  curl -s "$PUB/api/build" -H 'accept-encoding: identity' 2>/dev/null
  echo
} > "$OUT/prod-build.json" 2>&1

# ------------------------------------------------- сверка прод vs checkout
{
  echo "# сверка: тело с публичного адреса против файла в этом checkout"
  echo "# (sha256 тела из prod-http.txt против versions/source-hashes.txt)"
  while IFS='|' read -r f code cl size hash rest; do
    f=$(printf '%s' "$f" | tr -d ' ')
    hash=$(printf '%s' "$hash" | tr -d ' ')
    [ -z "$f" ] && continue
    local_hash=$(shasum -a 256 < "$HERE/../source/$f" 2>/dev/null | awk '{print $1}')
    if [ -z "$local_hash" ]; then echo "$f | нет в source/ | —"; continue; fi
    if [ "$local_hash" = "$hash" ]; then echo "$f | совпадает"; else echo "$f | РАСХОДИТСЯ (прод $hash, checkout $local_hash)"; fi
  done < <(grep '^game/\|^mapgen2/' "$OUT/prod-http.txt" | grep -v '^#')
} > "$OUT/prod-vs-head.txt" 2>&1

echo "готово: $OUT/prod-{readonly,http,build}.txt/json, prod-vs-head.txt"
