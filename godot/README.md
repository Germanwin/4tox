# 4tox — клиент на Godot 4 (гибрид)

Изометрическая деревня 4tox. **Мир и правила считает Node-сервер**
(`game/server/*`, комнаты в worker), Godot — глаза и руки: лобби по HTTP,
статический остров `WLD1`, кадры `4TX1` v2 по WebSocket, команды
`POST /api/command`, отрисовка и HUD. В GDScript нет симуляции — одна копия
правил, та же, что в браузере.

Атласы, текстуры и модели взяты из `mapgen2/assets` и `art/**/out`;
`tools/sync-assets.sh` обновляет копии.

![Главное меню](shots/menu.png)

## Запуск

Двойной клик по `run.command` (или из терминала):

```bash
cd godot
./run.command
# то же вручную:
/Applications/Godot.app/Contents/MacOS/Godot --path .
```

Терминал и ручной `node` не нужны: `scripts/server_supervisor.gd` находит
Node (рядом с приложением или в PATH), выбирает свободный порт, поднимает
`game/server/server.js --local --no-upnp`, ждёт `/api/health` и гасит процесс
при выходе. Лог — `user://logs/server.log`.

«Играть» — это **гибридная партия**. «Против деревни» — та же партия с
деревней бота (`bot:true`). Старый прототип `ToxSim` остался только
заставкой меню и отладочными кнопками «Новый рендер» / «Живая комната».

## Управление

| Действие | Как |
|---|---|
| Панорама | тянуть ЛКМ/СКМ, WASD, стрелки |
| Зум | колесо (3..120, к курсору) |
| Выбрать | клик по постройке/жителю |
| Правка | удержание ЛКМ 0,5 с или двойной клик |
| Стройка | «Стройка» → карточка → клик по карте |
| Серия домов | «Серия» → клик конца → «Построить» |
| Найм/тренировка | клик по лагерю/казарме |
| Войска | `O`, приказ — клик по карте |
| Деревня | `T` |
| Общий план | `V` |
| К жителю / следить | `H` / `C` |
| Новый остров | `N` |
| Меню (мир не стоит) | `Esc` |
| Отмена | ПКМ / `Esc` |

## Гейты

```bash
./tests/run.sh            # headless: wire/world/core/hud/supervisor/bot/live/кроссплей
./tests/play.sh           # сценарий мышью: 47 проверок
./tests/play.sh --shots   # то же с окном, кадры shots/play_*.png
./tests/visual.sh         # 3 карты × 18 кадров ≤0,5 %
```

Актуальное состояние и честный список несделанного — [PORT-STATE.md](PORT-STATE.md),
матрица паритета — [PARITY.md](PARITY.md), контракты — [CONTRACT.md](CONTRACT.md),
устройство гибрида — [HYBRID.md](HYBRID.md), батчинг — [BATCHING.md](BATCHING.md).

## Где что

| Файл | Роль |
|---|---|
| `scripts/main.gd` | меню → гибрид, супервизор, экраны |
| `scripts/server_supervisor.gd` | встроенный Node: порт, health, лог, стоп |
| `scripts/live_room.gd` | лобби, `WLD1`, WS, команды, `/api/check` |
| `scripts/hybrid_demo.gd` | камера, ввод, призрак, выделение, интерполяция жителей |
| `scripts/hybrid_hud.gd` | HUD: ресурсы, стройка, правка, найм, войска, деревня, меню, итог |
| `scripts/match_fx.gd` | кольца, контур, HP-полосы, метка приказа |
| `scripts/match_minimap.gd` | обзор острова и клик по нему |
| `scripts/world_layer.gd`, `ground_cache.gd`, `plots.gd`, `nature.gd`, `outline.gd` | рендер мира (пиксельный гейт) |
| `data/constants.json` | числа из JS (генерирует `tools/gen_constants.js`) |
| `tests/play.sh`, `tests/test_play.gd` | игра мышью, настоящие `InputEvent` |

## Прототип (не игра)

`scripts/sim.gd`, `worldgen.gd`, `pathfinder.gd`, `villager.gd` — старый
полный порт со своей симуляцией. Он **не** используется в главном пути:
другая копия правил — ровно то, из-за чего прошлый порт разъехался. Код
оставлен для заставки меню и сравнения; правила берутся только с сервера.

## Сборка

`export_presets.cfg` и `tools/package.sh` готовы. Шаблоны экспорта Godot на
этой машине не установлены, поэтому `.app`/`.exe` не собраны — см.
[PORT-STATE.md](PORT-STATE.md).
