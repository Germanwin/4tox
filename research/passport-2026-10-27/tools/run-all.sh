#!/usr/bin/env bash
# run-all.sh — все сценарии паспорта по три повтора.
#
# Запуск из каталога пакета:
#     tools/run-all.sh [каталог-сценариев]
#     REPO=/путь/к/4tox tools/run-all.sh runs-baseline
#
# Порядок фиксирован: S1, S2, S3, S4, S5. S6 (второе устройство) не
# запускается — он не воспроизводится одним компьютером, см. LIMITATIONS.md.
# Прогоны идут СТРОГО по одному: два профилируемых браузера на одной машине
# мешают друг другу, и числа становятся несовместимыми.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="${REPO:-$(cd "$PKG/../.." && pwd)}"
OUTDIR="${1:-runs}"
WARMUP="${WARMUP:-25}"
MEASURE="${MEASURE:-60}"
REPEATS="${REPEATS:-3}"
SCENARIOS="${SCENARIOS:-S1 S2 S3 S4 S5}"
SEED="${SEED:-}"

mkdir -p "$PKG/$OUTDIR"
echo "репозиторий: $REPO"
echo "каталог:     $PKG/$OUTDIR"
echo "разогрев $WARMUP с, измерение $MEASURE с, повторов $REPEATS"

for sc in $SCENARIOS; do
  for r in $(seq 1 "$REPEATS"); do
    d="$PKG/$OUTDIR/$sc/r$r"
    if [ -f "$d/scenario.json" ]; then echo "пропуск $sc/r$r (уже есть)"; continue; fi
    mkdir -p "$d"
    echo "=== $sc/r$r  $(date +%H:%M:%S)"
    if [ "$sc" = "S5" ] && [ -n "${PROD_URL:-}" ]; then
      node "$HERE/run-scenario.js" --scenario S5 --repo "$REPO" --url "$PROD_URL" \
        --out "$d" --warmup "$WARMUP" --measure "$MEASURE" || echo "  ПРОГОН НЕ УДАЛСЯ: $sc/r$r"
    else
      node "$HERE/run-scenario.js" --scenario "$sc" --repo "$REPO" \
        ${SEED:+--seed "$SEED"} \
        --out "$d" --warmup "$WARMUP" --measure "$MEASURE" || echo "  ПРОГОН НЕ УДАЛСЯ: $sc/r$r"
    fi
    sleep 5
  done
done
echo "всё: $(date +%H:%M:%S)"
