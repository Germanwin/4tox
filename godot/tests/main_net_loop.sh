#!/bin/bash
# Full main-scene loopback: lobby UI, host start, guest command through Main.
set -u
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
PORT="${PORT:-7812}"
HOST_LOG=$(mktemp -t 4tox-mainnet-host.XXXXXX)
CLIENT_LOG=$(mktemp -t 4tox-mainnet-client.XXXXXX)
HOST_PID=""
cleanup() {
  if [ -n "$HOST_PID" ] && kill -0 "$HOST_PID" 2>/dev/null; then
    kill "$HOST_PID" 2>/dev/null
    wait "$HOST_PID" 2>/dev/null
  fi
  rm -f "$HOST_LOG" "$CLIENT_LOG"
}
trap cleanup EXIT
"$GODOT" --headless --path . -s res://tests/main_net_host.gd -- --port="$PORT" >"$HOST_LOG" 2>&1 &
HOST_PID=$!
ready=""
for _i in $(seq 1 150); do
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    echo "main host died before READY"; cat "$HOST_LOG"; exit 1
  fi
  if grep -q "MAIN HOST READY" "$HOST_LOG"; then ready="yes"; break; fi
  sleep 0.1
done
if [ -z "$ready" ]; then
  echo "main host did not become ready"; cat "$HOST_LOG"; exit 1
fi
"$GODOT" --headless --path . -s res://tests/main_net_client.gd -- --port="$PORT" >"$CLIENT_LOG" 2>&1
CLIENT_STATUS=$?
for _i in $(seq 1 100); do
  if ! kill -0 "$HOST_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if kill -0 "$HOST_PID" 2>/dev/null; then
  kill "$HOST_PID" 2>/dev/null
  HOST_STATUS=124
else
  wait "$HOST_PID"; HOST_STATUS=$?
fi
HOST_PID=""
echo "=== main host"
cat "$HOST_LOG"
echo "=== main client"
cat "$CLIENT_LOG"
echo "=== status host=$HOST_STATUS client=$CLIENT_STATUS"
[ "$HOST_STATUS" -eq 0 ] && [ "$CLIENT_STATUS" -eq 0 ] || exit 1
grep -q "MAIN HOST OK" "$HOST_LOG" || { echo "main host did not report OK"; exit 1; }
grep -q "MAIN CLIENT OK" "$CLIENT_LOG" || { echo "main client did not report OK"; exit 1; }
echo "MAIN NET LOOPBACK PASSED"
