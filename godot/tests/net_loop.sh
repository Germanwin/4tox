#!/bin/bash
# Two-process loopback acceptance for the Godot multiplayer.
# Host and client are separate Godot processes talking over real ENet sockets.
set -u
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
PORT="${PORT:-7801}"
HOST_LOG=$(mktemp -t 4tox-net-host.XXXXXX)
CLIENT_LOG=$(mktemp -t 4tox-net-client.XXXXXX)
HOST_PID=""

cleanup() {
  if [ -n "$HOST_PID" ] && kill -0 "$HOST_PID" 2>/dev/null; then
    kill "$HOST_PID" 2>/dev/null
    wait "$HOST_PID" 2>/dev/null
  fi
  rm -f "$HOST_LOG" "$CLIENT_LOG"
}
trap cleanup EXIT

"$GODOT" --headless --path . -s res://tests/net_host.gd -- --port="$PORT" >"$HOST_LOG" 2>&1 &
HOST_PID=$!

ready=""
for _i in $(seq 1 120); do
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    echo "host died before READY"
    cat "$HOST_LOG"
    exit 1
  fi
  if grep -q "HOST READY" "$HOST_LOG"; then
    ready="yes"
    break
  fi
  sleep 0.1
done
if [ -z "$ready" ]; then
  echo "host did not become ready"
  cat "$HOST_LOG"
  exit 1
fi

"$GODOT" --headless --path . -s res://tests/net_client.gd -- --port="$PORT" >"$CLIENT_LOG" 2>&1
CLIENT_STATUS=$?

for _i in $(seq 1 80); do
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if kill -0 "$HOST_PID" 2>/dev/null; then
  kill "$HOST_PID" 2>/dev/null
  HOST_STATUS=124
else
  wait "$HOST_PID"
  HOST_STATUS=$?
fi
HOST_PID=""

echo "=== host"
cat "$HOST_LOG"
echo "=== client"
cat "$CLIENT_LOG"
echo "=== status host=$HOST_STATUS client=$CLIENT_STATUS"

if [ "$HOST_STATUS" -ne 0 ] || [ "$CLIENT_STATUS" -ne 0 ]; then
  exit 1
fi
grep -q "HOST OK" "$HOST_LOG" || { echo "host did not report OK"; exit 1; }
grep -q "CLIENT OK" "$CLIENT_LOG" || { echo "client did not report OK"; exit 1; }
grep -q "HOST WORKERS 3" "$HOST_LOG" || { echo "host did not see three hired workers"; exit 1; }
grep -q "CLIENT WORKERS 3" "$CLIENT_LOG" || { echo "client did not see three hired workers"; exit 1; }
echo "NET LOOPBACK PASSED"
