#!/bin/bash
# vps.sh — проверка прода БЕЗ выкладки: что реально отвечает VPS.
#
# Скрипт ничего не меняет: только GET /api/build, /api/health, /api/world.
# Нужен, чтобы не путать «баг клиента» с «сервер на VPS старее клиента».
#
# Запуск: ./tests/vps.sh [origin]
#   ./tests/vps.sh https://374412.fornex.cloud:8443
set -u
ORIGIN="${1:-https://374412.fornex.cloud}"
FAIL=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; FAIL=$((FAIL + 1)); }

echo "== VPS $ORIGIN"
BUILD=$(curl -sS --max-time 12 "$ORIGIN/api/build" 2>/dev/null || true)
if [ -z "$BUILD" ]; then
  bad "/api/build не ответил"
else
  echo "  build: $BUILD"
  echo "$BUILD" | grep -q '"ok":true' && ok "/api/build" || bad "/api/build не ok"
  echo "$BUILD" | grep -q '"ws":true' && ok "ws включён" || bad "ws выключен"
fi

HEALTH=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$ORIGIN/api/health" 2>/dev/null || echo 000)
if [ "$HEALTH" = "200" ]; then
  ok "/api/health 200 (сервер новый)"
else
  bad "/api/health $HEALTH — на VPS старая сборка без встроенного сервера Godot"
fi

WORLD=$(curl -sS -o /tmp/vps-world.bin -w '%{http_code}' --max-time 12 \
  "$ORIGIN/api/world?code=NOPE&token=NOPE" 2>/dev/null || echo 000)
if [ "$WORLD" = "404" ]; then
  bad "/api/world 404 — WLD1 на VPS нет, гибридный клиент туда не подключится"
elif [ "$WORLD" = "403" ] || [ "$WORLD" = "200" ]; then
  ok "/api/world $WORLD — эндпоинт есть"
else
  bad "/api/world $WORLD"
fi

GAME=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$ORIGIN/game/" 2>/dev/null || echo 000)
[ "$GAME" = "200" ] && ok "/game/ 200" || bad "/game/ $GAME"

echo "== провалов: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Вывод: выкладка по docs/DEPLOY.md нужна; клиент локально играбелен."
  exit 1
fi
echo "VPS: PASS"
