#!/bin/bash
# Визуальный гейт M1: земля и природа в Godot против эталона браузера.
# Нужен дисплей (не --headless): Godot должен отрендерить кадр.
set -e
GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
cd "$(dirname "$0")/.."
for MAP in "res://tests/fixtures" "res://tests/fixtures/m192" "res://tests/fixtures/m96"; do
export TOX_FIXTURES="$MAP"
echo "##### $MAP"
for tag in ground_z24 ground_z40 ground_z64; do
  echo "=== $tag"
  "$GODOT" --path . -s res://tests/render_ground.gd -- "$tag" >/dev/null
  "$GODOT" --headless --path . -s res://tests/test_render.gd -- "$tag"
done
for tag in z24 z40 z64; do
  echo "=== $tag (с природой)"
  "$GODOT" --path . -s res://tests/render_nature.gd -- "$tag" >/dev/null
  "$GODOT" --headless --path . -s res://tests/test_render.gd -- "$tag"
done
for tag in build_z24 build_z40 build_z64; do
  echo "=== $tag (постройки с газоном)"
  "$GODOT" --path . -s res://tests/render_build.gd -- "$tag" >/dev/null
  "$GODOT" --headless --path . -s res://tests/test_render.gd -- "$tag"
done
for tag in plot_z24 plot_z40 plot_z64; do
  echo "=== $tag (газон участка)"
  "$GODOT" --path . -s res://tests/render_plot.gd -- "$tag" >/dev/null
  "$GODOT" --headless --path . -s res://tests/test_render.gd -- "$tag"
done
for tag in vill_z24 vill_z40 vill_z64; do
  echo "=== $tag (жители)"
  "$GODOT" --path . -s res://tests/render_vill.gd -- "$tag" >/dev/null
  "$GODOT" --headless --path . -s res://tests/test_render.gd -- "$tag"
done
for tag in full_z24 full_z40 full_z64; do
  echo "=== $tag (общий кадр с газоном)"
  "$GODOT" --path . -s res://tests/render_world.gd -- "$tag" >/dev/null
  "$GODOT" --headless --path . -s res://tests/test_render.gd -- "$tag"
done
done
