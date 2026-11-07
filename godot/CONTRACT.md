# CONTRACT — гибридный клиент 4tox

Версия 0.2 (2026-11-03). Замораживает то, на чём сходятся сервер, браузер и
Godot-клиент. Менять — только с повышением версии и правкой всех трёх сторон.

## 1. Кто что решает

| Сторона | Отвечает за |
|---|---|
| Node-сервер (`game/server/*`, worker комнаты) | мир, правила, экономика, бой, исход, проверка команд |
| Браузер (`game/`, `mapgen2/js`) | эталон поведения и картинки; одна реализация правил |
| Godot (`godot/`) | камера, ввод, отрисовка по снимку, HUD, отправка команд |

Godot **не** генерирует остров, не считает цену, не решает «можно ли ставить»
и не симулирует жителей. `ToxSim` и `mapgen2/*`-порт из прототипа правилами
не являются.

## 2. Координаты и проекция

- Клетка — целое `(x, y)`, начало в левом верхнем углу сетки мира.
- Мир `W×H` (сетка) больше заказанного острова: генератор добавляет море.
  `islandSize` — заказанный размер (64/96/128/192/256).
- Экран (пиксели кадра), `z` — пикселей на клетку:

```
sx = (x − y − cam.x + cam.y) · z / 2
sy = (x + y − cam.x − cam.y) · z / 4
```

- Обратная проекция (то, чем пользуются `screen_to_cell`/`screen_to_world`):

```
wx = cam.x + (      a + 2·b) / z     a = sx − cssW/2
wy = cam.y + (      2·b − a) / z     b = sy − cssH/2
```

- `zoom` — пикселей на клетку, `3..120`. Зум — к курсору:
  `cam += worldUnderCursor(before) − worldUnderCursor(after)`.
- Камера ограничена сушей: `h = min(cssW/(2z), cssH/z)`, ближайшая клетка
  суши `±h` (как `Renderer.clampCamera`).

## 3. Ввод (числа из `game/js/play.js`)

| Порог | Значение | Что значит |
|---|---|---|
| `CLICK_SLOP` | 8 px | клик/выбор: сдвиг от точки нажатия |
| `PAN_SLOP` | 8 px | после него начинается панорама |
| `PLACE_SLOP` | 18 px | постановка/приказ терпят дрожь руки |
| `HOLD_SLOP` | 18 px | удержание не срывается в панораму |
| `HOLD_MS` | 500 мс | удержание ЛКМ по постройке → правка |
| двойной клик | 500 мс | тот же вход в правку |
| панорама | 900 px/с | WASD и стрелки, экранные направления |

Дрожь считается **расстоянием от точки нажатия** (не суммой пути). Кнопка
срабатывает у самой кромки: `--press`/`translateY` и накладка `::before`
(`game/css/base.css`) — в Godot кнопка не уезжает, нажатие не теряется.

## 4. Транспорт

- Лобби: `POST /api/lobby` (`seed`, `size`, `bot`), `POST /api/ready`,
  `POST /api/start` (`solo:true` / `bot:true`), `GET /api/status`.
- Мир: `GET /api/world?code&token` → `WLD1` (см. `game/shared/world-wire.js`).
- Кадры: `wss://origin/api/ws?code&token` → двоичный `4TX1` v2
  (`game/shared/net-wire.js`), 10 кадров/с.
- Команды: `POST /api/command` → `GET /api/command-state?code&token&id=…`.
  `commandId = "<instance>:<clientSequence>"`, ответы
  `received / applied / rejected / expired / history_expired`.
- Проверка места (подсказка для призрака): `POST /api/check`
  `{query:{kind:build|move|rotate|delete, …}}` →
  `{ok, reason, cells, footprint, exits, decor, blocked, villagers, sealed}`.
- Готовность: `GET /api/health` → `{ok, build, protocol, wsProtocol, rooms, …}`.
- Выход: `POST /api/leave` — закрывает комнату сразу.

### 4.1. WLD1

`u32 magic 'WLD1', u8 version, u16 width, u16 height, u16 islandSize,
u16 seedLen+seed, u8 hashLen+hash, tile[n], isLand[n], distLand u16[n]×100,
distWater u16[n]×100, u32 objectCount, объект(12 байт)`.

### 4.2. 4TX1 v2 (поля снимка)

`protocol, size, epoch, revision(seq), simulationTick, simulationTimeMs,
serverGeneratedAtMs, structureVersion, over, winner, objectTotal, roomId,
worldgenVersion, worldgenHash, gameplayConfigHash, seed, roomStatus, removed,
towns[], buildings[], villagers[], commandResults[], treeHits[]`.

Постройка: `id, type, variant, rot, x, y, owner, town, hp, maxHp, hpUntil,
flinch, rubble`.

Житель: `id, x, y, rot, anim, state, phase, hp, hpUntil, flinch, attackT,
trainingId, trainT, homeId, employerId, campId, stationId, appearT, appearDur,
vanishT, emergeT, orderX, orderY, deathTimeMs, safeExtrapolationTo, motion[],
frozen, warrior, trainee, hidden, carrying, dead, teleport, owner, town`.

`motion[]` — `{t (мс), x, y, rot}`, точки в будущем; клиент интерполирует на
`renderTime = lastSimTimeMs + (now − recv) − 150 мс`.

## 5. Команды (payload — как в `game/js/play.js`)

| Тип | payload |
|---|---|
| `build` | `buildingType, variant, rot, x, y` |
| `buildLine` | `buildingType, variant, rot, x, y, x2, y2` |
| `edit` | `action: rotate\|move\|delete, id` (+`x`,`y` для move) |
| `hire`,`fire`,`train` | `campId` (строка), `villagerId` (ЧИСЛО) |
| `order` | `ids: [число], x, y` |
| `stop` | `ids: [число]` (пусто — все свои) |

`id` постройки — строка (`"0:b2"`), `id` жителя — число. Сравнение на сервере
строгое (`===`), поэтому строка `"1"` жителя не находит.

## 6. Слои и порядок отрисовки

1. кэш земли (вода/пляж/море/мокрый песок) — один спрайт;
2. газон участков (`plots.gd`) — под постройками;
3. природа — мешами-полосами по глубине `(x+y)` в МИРОВЫХ координатах
   (`world_layer.gd`, `NATURE_SPAN`), поэтому панорама и зум её не
   пересобирают; трясущееся дерево входит в свою полосу;
4. один поток глубины: полоса природы → постройки (глубина по пятну) и
   жители (батчинг по кускам между постройками), кайма цветом команды
   1.1/1.4 экранных px; полоса делится на дальнюю/ближнюю половину, чтобы
   дерево перед жителем/домом честно перекрывало его;
5. ожидающие действия (`pending`) — в том же потоке: дом стоит сразу, над
   ним пульсирующая метка; снимок подтверждает и снимает ожидание;
6. эффекты: клетка курсора, кольца выбора, контур постройки, HP-полосы, метка
   приказа;
7. призрак постановки (valid/invalid + причина словами);
8. HUD (Control-ноды), миникарта, экран итога.

Тени у построек нет (правило 2026-10-17); у природы есть.

## 7. Ошибки и отказы

- Команда не применена → HUD пишет `applied/rejected/expired` и причину
  словами сервера; молчаливого «ничего не произошло» нет.
- `/api/check` не ответил → призрак нейтральный (не зелёный и не красный).
- Сервер не поднялся → экран сбоя с причиной и путём к логу
  (`user://logs/server.log`), мир явно не начался.
- Обрыв WS → клиент переподключается; при неудаче — SSE (в работе, §PARITY).

## 8. Файлы, которые нельзя менять без версии контракта

`godot/scripts/wire.gd`, `world_wire.gd`, `world_data.gd`,
`buildings_data.gd`, `villagers_data.gd`, `atlas_db.gd`, этот файл.
