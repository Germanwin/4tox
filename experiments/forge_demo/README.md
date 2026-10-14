# _forge_demo — постройка для 4tox/mapgen2

Собрано по скиллу `4tox-building-forge`.  Сцена Blender `forge_barn`, префикс имён
`fb_`, кадр 80 ppu (изометрия 2:1).

## Инструменты (копии из скилла, можно править под эту постройку)

| файл | что делает |
|---|---|
| `tools/building.py` | ГЕОМЕТРИЯ: чистый Python, ярусы и раскладка. Главный файл. |
| `tools/forge.py` | примитивы, отсев невидимых фасетов, триангуляция, палитра |
| `tools/xray.py` | софт-рендер и детектор дефектов (изнанки, зазоры, z-fighting) |
| `tools/canon.py` | приёмка по канону: ярусы, габарит, уклон, свесы, бюджет, нормали |
| `tools/blender_live.py` | материалы, свет, камера, рендер, экспорт (внутри Blender) |
| `tools/build_live.py` | точка входа сборки в живом Blender |
| `tools/mcp.py` | клиент сокета аддона blender-mcp (снаружи Blender) |

## Порядок работы

```bash
PY=/Users/hermmoment/.dsh/profiles/desktop/node_modules/dsh-blender/.venv/bin/python
PY3=/Users/hermmoment/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3

$PY3 tools/canon.py --gen tools/building.py        # числа против канона
$PY3 tools/xray.py probe --gen tools/building.py --full   # дефекты, 32 ракурса
$PY  tools/mcp.py run tools/build_live.py          # сборка в УЖЕ ЗАПУЩЕННОМ Blender
$PY  tools/mcp.py shot renders/live.png            # посмотреть вьюпорт
```

## Что дальше по пайплайну

Спрайты и атлас собираются пост-обработкой (контур, контактная тень, обрезка) —
см. `4tox-lowpoly-3d/references/pipeline.md`; приёмка кадра — `scripts/audit.py`
того же скилла (порог палитры 93%, детализации, контура, тени, полигонажа).
