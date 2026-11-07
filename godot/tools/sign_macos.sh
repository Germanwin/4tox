#!/bin/bash
# sign_macos.sh — подпись клиента; поведение Keychain требует отдельной проверки.
#
# macOS привязывает «Разрешать всегда» к code requirement приложения. У
# неподписанного/пересобранного клиента requirement меняется вместе с
# бинарником, поэтому EOS-токен
# (com.epicgames.sdk.connect.access_token) спрашивает пароль снова и снова.
#
# Подпись ad-hoc с ЯВНЫМ designated requirement только по identifier:
#   designated => identifier "cloud.fornex.tox4"
# не зависит от хеша конкретной сборки, но не доказывает отсутствие запросов
# и не подтверждает издателя. Для раздачи нужен Developer ID; передайте
# идентификатор подписи в CODESIGN_IDENTITY и проверьте чистый профиль.
#
#   tools/sign_macos.sh build/macos/4tox.app/Contents/Resources/4tox-client.app
set -e
APP="${1:-}"
ID="${2:-cloud.fornex.tox4}"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "usage: $0 <app> [identifier]" >&2
  exit 2
fi
if ! command -v codesign >/dev/null 2>&1; then
  echo "SKIP: codesign не найден" >&2
  exit 0
fi
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  # Release identity supplies the trusted anchor in the designated requirement.
  /usr/bin/codesign --force --deep --options runtime --timestamp \
    --sign "$CODESIGN_IDENTITY" --identifier "$ID" "$APP" >/dev/null
else
  # Local-only fallback; identifier alone is not a trusted publisher identity.
  REQ="=designated => identifier \"$ID\""
  /usr/bin/codesign --force --deep --sign - \
    --identifier "$ID" --requirements "$REQ" "$APP" >/dev/null
fi
/usr/bin/codesign --verify --deep --strict "$APP"
GOT=$(/usr/bin/codesign -d -r- "$APP" 2>&1 || true)
case "$GOT" in
  *"identifier \"$ID\""*) ;;
  *)
    echo "ОШИБКА: requirement не закрепился: $GOT" >&2
    exit 1
    ;;
esac
if printf '%s' "$GOT" | grep -q 'cdhash'; then
  echo "ОШИБКА: requirement содержит cdhash и умрёт на следующей сборке" >&2
  exit 1
fi
echo "  подпись: $ID · $GOT"
