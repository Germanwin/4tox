#!/bin/bash
# wrap_macos.sh — обернуть настоящий клиент в 4tox.app-лаунчер.
#
# Зачем: macOS считает запущенным приложение, которое само живёт окном, и
# повторный клик по иконке активирует его, а не открывает второе окно.
# Лаунчер — отдельный .app со своим bundle id: он запускает вложенный клиент
# через `open -n` и сразу выходит. Клик по нему снова застаёт лаунчер
# «незапущенным», поэтому каждое нажатие даёт новое окно.
#
#   tools/wrap_macos.sh build/macos/4tox-client.app build/macos/4tox.app
#
# Вложенный клиент остаётся отдельным .app (`4tox-client.app`) со своим
# bundle id; CLI-флаги (`--headless`, `--smoke`, `--eos-probe`) лаунчер
# передаёт настоящему бинарнику напрямую, чтобы приёмки не отцеплялись.
set -e
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <real.app> <out.app>" >&2
  exit 2
fi
REAL="$1"
OUT="$2"
if [ ! -d "$REAL" ]; then
  echo "нет клиента: $REAL" >&2
  exit 1
fi
if [ ! -x "$REAL/Contents/MacOS/4tox" ]; then
  echo "в $REAL нет Contents/MacOS/4tox" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

# Настоящий клиент — вложенным .app, со своим bundle id.
cp -R "$REAL" "$OUT/Contents/Resources/4tox-client.app"

# Стабильная подпись: иначе Keychain на каждый пересбор снова спрашивает
# доступ к com.epicgames.sdk.connect.access_token, хотя нажато «всегда».
if [ -x "$(dirname "$0")/sign_macos.sh" ]; then
  "$(dirname "$0")/sign_macos.sh" "$OUT/Contents/Resources/4tox-client.app" cloud.fornex.tox4
fi

# Иконка лаунчера — та же, что у игры.
if [ -f "$REAL/Contents/Resources/icon.icns" ]; then
  cp "$REAL/Contents/Resources/icon.icns" "$OUT/Contents/Resources/icon.icns"
fi

# Info.plist лаунчера: тот же, но другой исполняемый файл и bundle id.
cp "$REAL/Contents/Info.plist" "$OUT/Contents/Info.plist"
plutil -replace CFBundleExecutable -string launcher "$OUT/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string cloud.fornex.tox4.launcher "$OUT/Contents/Info.plist"
plutil -replace CFBundleName -string "4tox" "$OUT/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "4tox" "$OUT/Contents/Info.plist"
# Эти ключи описывают настоящий бинарник, а не скрипт-лаунчер.
plutil -remove LSArchitecturePriority "$OUT/Contents/Info.plist" 2>/dev/null || true
plutil -remove LSMinimumSystemVersionByArchitecture "$OUT/Contents/Info.plist" 2>/dev/null || true

cat > "$OUT/Contents/MacOS/launcher" <<'LAUNCHER'
#!/bin/bash
# Не оставаться живым: иначе macOS снова сочтёт 4tox.app запущенным.
here="$(cd "$(dirname "$0")" && pwd)"
inner="$here/../Resources/4tox-client.app"
if [ ! -x "$inner/Contents/MacOS/4tox" ]; then
  /usr/bin/osascript -e 'display alert "4tox" message "Внутри 4tox.app нет клиента 4tox-client.app. Пересоберите приложение."' >/dev/null 2>&1 || true
  exit 1
fi

# Finder иногда передаёт -psn_...; клиенту он не нужен.
args=()
for a in "$@"; do
  case "$a" in
    -psn_*) ;;
    *) args+=("$a") ;;
  esac
done

# Приёмки и headless — настоящий процесс, без отделения: важен код возврата.
case " $* " in
  *" --headless "*|*" --smoke "*|*" --eos-probe "*)
    exec "$inner/Contents/MacOS/4tox" "${args[@]}" ;;
esac

fail_open() {
  /usr/bin/osascript -e 'display alert "4tox" message "Не удалось открыть новое окно. Запускаю клиент напрямую — окно будет одно."' >/dev/null 2>&1 || true
}

if [ "${#args[@]}" -gt 0 ]; then
  if ! /usr/bin/open -n "$inner" --args "${args[@]}"; then
    fail_open
    exec "$inner/Contents/MacOS/4tox" "${args[@]}"
  fi
else
  if ! /usr/bin/open -n "$inner"; then
    fail_open
    exec "$inner/Contents/MacOS/4tox"
  fi
fi
exit 0
LAUNCHER
chmod +x "$OUT/Contents/MacOS/launcher"

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  /usr/bin/codesign --force --deep --options runtime --timestamp \
    --sign "$CODESIGN_IDENTITY" --identifier cloud.fornex.tox4.launcher "$OUT"
  /usr/bin/codesign --verify --deep --strict "$OUT"
fi

echo "  обёртка: $OUT (лаунчер) + $OUT/Contents/Resources/4tox-client.app (клиент)"
