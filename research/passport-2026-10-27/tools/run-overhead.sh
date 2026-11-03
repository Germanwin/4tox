#!/usr/bin/env bash
# run-overhead.sh — сколько стоит сама диагностика.
#
# Три прогона одного и того же (S1, сид и размер фиксированы), отличаются
# только обвязкой:
#   off     — ничего не включено: игра как есть;
#   metrics — только счётчики движка (Metrics.on), обвязки нет;
#   full    — вся обвязка: счётчики, обёртки, выборка 1 Гц и покадровая.
#
# Сравнивать по внешним счётчикам Chromium (`perf_*` в server-samples.jsonl:
# TaskDuration — сколько главный поток был занят) и по кадрам, если они есть.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="${REPO:-$(cd "$PKG/../.." && pwd)}"
SEED="${SEED:-overhead-96}"
for mode in off metrics full; do
  d="$PKG/runs/_overhead/$mode"
  [ -f "$d/scenario.json" ] && { echo "пропуск $mode"; continue; }
  echo "=== overhead $mode"
  node "$HERE/run-scenario.js" --scenario S1 --repo "$REPO" --out "$d" \
    --warmup 15 --measure 30 --size 96 --seed "$SEED" --probe "$mode" \
    || echo "  НЕ УДАЛСЯ: $mode"
  sleep 3
done
node "$HERE/overhead.js"
