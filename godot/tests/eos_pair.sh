#!/bin/bash
# Приёмка настоящего EOS на одной машине: две копии, разные анонимные
# пользователи, пакет хозяин↔гость. Заодно проверяет, что вход второго окна
# не сносит сессию первого (общий device id сериализован очередью).
#
#   ./tests/eos_pair.sh
#
# Без user://eos.cfg — SKIP: без ключей Epic проверять нечего.
set -u
cd "$(dirname "$0")/.."
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
CFG="$HOME/Library/Application Support/Godot/app_userdata/4tox/eos.cfg"
if [ ! -f "$CFG" ]; then
  echo "SKIP: нет $CFG"
  exit 0
fi
LOCK="$HOME/Library/Application Support/Godot/app_userdata/4tox/eos-login.lock"
rm -rf "$LOCK"
HOST_LOG=$(mktemp -t 4tox-eos-host.XXXXXX)
GUEST_LOG=$(mktemp -t 4tox-eos-guest.XXXXXX)
HOST_PID=""
cleanup() {
  if [ -n "$HOST_PID" ] && kill -0 "$HOST_PID" 2>/dev/null; then
    kill "$HOST_PID" 2>/dev/null
    wait "$HOST_PID" 2>/dev/null
  fi
  rm -f "$HOST_LOG" "$GUEST_LOG"
}
trap cleanup EXIT

# grep на живой лог: без -q, иначе не видно, что хозяин дошёл до ROOM.
"$GODOT" --headless --path . -s res://tests/eos_pair.gd -- --host >"$HOST_LOG" 2>&1 &
HOST_PID=$!
ROOM=""
for _i in $(seq 1 300); do
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    echo "хозяин умер до ROOM"
    cat "$HOST_LOG"
    exit 1
  fi
  ROOM=$(grep -m1 '^ROOM ' "$HOST_LOG" 2>/dev/null | awk '{print $2}')
  [ -n "$ROOM" ] && break
  sleep 0.2
done
if [ -z "$ROOM" ]; then
  echo "хозяин не выдал ROOM"
  cat "$HOST_LOG"
  exit 1
fi
echo "комната: $ROOM"

"$GODOT" --headless --path . -s res://tests/eos_pair.gd -- --guest="$ROOM" >"$GUEST_LOG" 2>&1
GUEST_RC=$?
wait "$HOST_PID"
HOST_RC=$?
HOST_PID=""

echo "=== host"; grep -E "ROOM |PEER_UP|PACKET|RESULT|FAILED" "$HOST_LOG"
echo "=== guest"; grep -E "PEER_UP|PACKET|RESULT|FAILED" "$GUEST_LOG"
echo "=== status host=$HOST_RC guest=$GUEST_RC"
grep -q "RESULT OK" "$HOST_LOG" || { echo "хозяин не получил пакет"; exit 1; }
grep -q "RESULT OK" "$GUEST_LOG" || { echo "гость не получил пакет"; exit 1; }
[ "$HOST_RC" -eq 0 ] && [ "$GUEST_RC" -eq 0 ] || exit 1
echo "EOS PAIR PASSED: две копии, разные device id, пакет туда-обратно"
