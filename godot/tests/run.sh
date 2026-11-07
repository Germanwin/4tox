#!/bin/bash
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
if [ ! -f tests/fixtures/frame.bin ] || [ ! -f tests/fixtures/world.bin ]; then
  echo "=== capture_fixture (нет фикстур)"
  node tests/capture_fixture.js
fi
if [ ! -f tests/fixtures/world.json ]; then
  echo "=== export_world (нет мира)"
  node tests/export_world.js
fi
echo "=== server api (аддитивные эндпоинты Godot-клиента)"
node tests/test_server_api.js
echo "=== constants (числа из JS)"
node tests/test_constants.js
for t in test_wire test_world test_world_wire test_core test_features test_ui test_demo test_hud test_hud_layout test_room_detach test_plot_cache test_plot_baker test_zoom_gestures test_camera_release test_zoom_feel test_tree_removal test_draw_order test_pending_build test_pending_edit test_menu_static test_edit_move test_supervisor test_client_profile test_multi_windows test_bot test_ruins test_shake test_combat_fx test_patrol test_lobby test_net_lobby_ui test_net_entry test_main_net test_resume test_main_resume test_reconnect test_poll_fallback test_sse test_spectate test_net_events test_net test_live; do
  echo "=== $t"
  "$GODOT" --headless --path . -s "res://tests/$t.gd" -- --test-profile=1
done
echo "=== multi_app (macOS: повторный клик — новое окно)"
./tests/multi_app.sh

echo "=== net_loop"
GODOT="$GODOT" ./tests/net_loop.sh
echo "=== main_net_loop"
GODOT="$GODOT" ./tests/main_net_loop.sh

echo "=== crossplay godot <-> browser"
if node ../mapgen2/tools/chrome.js >/dev/null 2>&1; then
  "$GODOT" --headless --path . -s res://tests/test_crossplay.gd
else
  echo "  SKIP: Chrome не найден (кроссплей проверяется node game/tools/mp.js)"
fi
