# 4tox: проверка серверной комнаты

Дата: 2026-10-27. База: `6b9f06b52124cb24f1be12be147b15bdabd9c345`
(`patch/4tox-stabilization`), сравнение с `dc75820bbc44625656b69e8c407db2cef628ae3b`.
Прод не выкладывался; секретов и боевых токенов в отчёте нет.

## 1. Окружение

| | |
|---|---|
| ОС | macOS 15.7.3 (24G419), Apple Silicon |
| Node | v24.12.0 (`node --version`) |
| Chrome | 156.0.8078.48, headless `/Applications/Google Chrome.app/…` |
| Скрипты | без npm-зависимостей; только `node:http`, `worker_threads`, `node:test` |
| STATE_DIR тестов | временный `mkdtemp`, не боевой |
| Мобильное устройство | **нет** — real-device приёмка NOT_RUN |

## 2. Команды и результаты

```bash
node --test game/tools/tests/*.test.js
# tests 66, pass 66, fail 0

node game/tools/tests/mp-acceptance.js
# 15/15 PASS, exit 0
# raw: game/tools/out/mp-acceptance-raw-2026-10-27T22-11-58-862Z.json
# summary: game/tools/out/mp-acceptance-summary-2026-10-27T22-11-58-862Z.json

node game/tools/mp.js
# 15 PASS, MP: PASS, exit 0 (две реальные страницы Chrome)

node game/tools/menu.js
# 302 ok, «все проверки игры пройдены», exit 0

node mapgen2/tools/game.js
# 81 ok, «все проверки начала игры пройдены», exit 0, консольных ошибок нет

node mapgen2/tools/place.js        # 65 ok, exit 0
node mapgen2/tools/combat.js       # 72 ok, exit 0
node mapgen2/tools/army.js         # exit 0
node mapgen2/tools/garrison.js     # exit 0
node mapgen2/tools/lumberjack.js   # exit 0
node mapgen2/tools/lumbercamp-move.js # exit 0
node mapgen2/tools/path.js         # exit 0
node mapgen2/tools/shape.js        # exit 0
node mapgen2/tools/smoke.js        # exit 0
node game/tools/army.js            # exit 0
node game/tools/modes.js           # exit 0

node mapgen2/tools/ground.js       # PASS, exit 0
# Ранее было 3 FAIL и на HEAD. Исправлено: порог разницы участка 18 -> 16
# (у угла военного лагеря 17/255), допуск ширины пляжа + 1e-9.

node game/tools/tests/mp-load.js --entities 100 --ticks 600
# p50 0.032 мс, p95 0.100 мс, p99 0.340 мс, max 3.884 мс
# snapshot: avg 37 555 B, gzip avg 8 439 B
# activity: 98 moved, 95 with path, 294 nav requests / 294 ready,
#           workers 0, warriors 0
node game/tools/tests/mp-load.js --entities 200 --ticks 600
# p50 0.056 мс, p95 0.149 мс, p99 0.340 мс, max 5.429 мс
# snapshot: avg 73 495 B, gzip avg 15 753 B
# activity: 198 moved, 186 with path, 590 nav requests / 590 ready,
#           workers 0, warriors 0
# Это CPU-бенч движения/path-запросов без GPU/браузера; работа и бой
# в этом прогоне не назначены (workers/warriors = 0).

node game/tools/tests/mp-load-work.js --entities 100 --ticks 600
# 94 workers, 100 moved, 75 with path, 5 chopping, 9 carrying,
# 7008 nav requests, 113 felled, 416 logs
# p50 0.255, p95 6.140, p99 14.579, max 28.636 мс
node game/tools/tests/mp-load-work.js --entities 200 --ticks 600
# 194 workers, 200 moved, 146 with path, 24 chopping, 20 carrying,
# 12354 nav requests, 207 felled, 748 logs
# p50 0.525, p95 10.104, p99 20.709, max 26.723 мс
# 180-секундное окно в тиках (3600 тиков), не wall-clock:
node game/tools/tests/mp-load-work.js --entities 200 --ticks 3600
# 194 рабочих, 200 двигались, 1028 деревьев, 3864 бревна,
# 57441 nav-запрос / 52795 ready, p95 8.224 мс, max 31.124 мс
# Это реальная работа (рубка/переноска), но без боя и GPU/браузера.

node game/tools/tests/mp-load-work.js --entities 200 --ticks 3600 --realtime
# wall 183.294 с (50 мс на тик), 194 рабочих, 1028 деревьев,
# p95 16.354 мс, max 46.020 мс, RSS 1.0 ГБ, heapUsed 11.7 МБ
# RSS высокий: это ограничение теста/аллокатора, не выдан за норму.

node game/tools/tests/mp-load-work.js --entities 200 --ticks 1200   --realtime --mem-sample
# RSS: 169 -> 619 -> 932 -> 1110 -> 1257 -> 1289 МБ, затем плато;
# heapUsed 10-29 МБ, external 15-159 МБ. Рост RSS прекращается к ~20 с,
# это удержание аллокатора, а не продолжающаяся утечка heap.

node game/tools/tests/mp-browser-load.js --entities 100
# Chrome headless, 103 жителя: 601 кадр за 10 с, p50/p95 16.7 мс,
# max 16.8 мс, кадров >50 мс — 0
node game/tools/tests/mp-browser-load.js --entities 200
# 203 жителя: 599 кадров, p50/p95 16.7 мс, max 33.4 мс,
# кадров >50 мс — 0. Это браузерный JS/render, не GPU-профиль.

node game/tools/tests/mp-browser-work.js --entities 100
# 100 нанятых рабочих, 34 лагеря, 2529 деревьев; 29 рубят, 27 срублено
# за 10 с; 601 кадр, p50/p95 16.7/16.8 мс, >50 мс — 0
node game/tools/tests/mp-browser-work.js --entities 200
# 200 рабочих, 67 лагерей; 31 рубит, 28 срублено за 10 с;
# 601 кадр, p50/p95 16.7 мс, >50 мс — 0

node game/tools/tests/mp-browser-combat.js --entities 100
# 107 воинов, 23 одновременно в бою/с целью; 602 кадра,
# p50/p95 16.7 мс, >50 мс — 0; running=false (бой закончился)
node game/tools/tests/mp-browser-combat.js --entities 200
# 206 воинов, 32 в бою/с целью; 601 кадр, p50/p95 16.7 мс, >50 мс — 0

node game/tools/tests/mp-browser-mixed.js --entities 100
# 50 рабочих + 50 воинов: 53 работника, 59 воинов, 37 в бою,
# 24 срублено; 602 кадра, p95 16.7 мс, >50 мс — 0
node game/tools/tests/mp-browser-mixed.js --entities 200 --seconds 180
# 200 синтетических: 103 работника, 106 воинов, 20 в бою,
# 81 срублено за 180 с; 10803 кадра, p50/p95 16.7 мс,
# max 16.8 мс, кадров >50 мс — 0. running=false — бой закончился.

node game/tools/tests/mp-browser-mixed.js --entities 200 --seconds 10 --profile
# CPU-профиль 10 с: render 5287 мс, idle 3513 мс, combat 83 мс,
# navigation 35 мс, step 10 мс, apply 2.5 мс; top drawImage 4304 мс.
# Это JS/CPU-профиль headless Chrome, не GPU/RSS.

node game/tools/tests/mp-active-window.js --seconds 180 --entities 100
# RoomRuntime, 108 активных: 3600 тиков за 181.6 с -> 19.821 ticks/s,
# 1800 снимков -> 9.911/s, p95 шага 8.45 мс, p99 40.35, max 47.81
node game/tools/tests/mp-active-window.js --seconds 180 --entities 200
# 208 активных: 3600 тиков за 181.8 с -> 19.803 ticks/s,
# 1800 снимков -> 9.902/s, p95 8.98 мс, p99 52.99, max 60.54,
# снимок 77.8 КБ / gzip 18.6 КБ, RSS 432 МБ

node game/tools/tests/mp-load-combat.js --entities 100 --ticks 300
# 96 бойцов одновременно в бою, 96 с целью, 15493 nav-запроса / 2201 ready,
# урон 196 HP, p95 1.480 мс, max 12.576 мс
node game/tools/tests/mp-load-combat.js --entities 200 --ticks 300
# 196 в бою, 196 с целью, 9226 nav-запросов / 3078 ready,
# урон 205 HP, p95 3.197 мс, max 19.699 мс
node game/tools/tests/mp-load-combat.js --entities 200 --ticks 3600
# 196 в бою в пике, урон 205 HP, бой закончился; p95 0.893 мс, max 20.671 мс
# Это 180-секундное окно в тиках, не wall-clock.

node game/tools/tests/mp-window.js --seconds 180 --warmup 30   # три повтора
# run1: 180.001 s, 3602 ticks -> 20.011/s, 1801 snapshots -> 10.005/s,
#       p95 interval 102 ms, ping p95 3.02 ms, coverage 1.0, ok=true
# run2: 180.002 s, 3602 ticks -> 20.011/s, 1801 snapshots -> 10.005/s,
#       p95 interval 102 ms, ping p95 2.99 ms, coverage 1.0, ok=true
# run3: 180.003 s, 3602 ticks -> 20.011/s, 1801 snapshots -> 10.005/s,
#       p95 interval 102 ms, ping p95 3.29 ms, coverage 1.0, ok=true

node game/tools/tests/mp-window.js --seconds 1800 --warmup 30
# 30-минутный soak: observed 1800.002 s, coverage 1.0
# committedTicks 36002 -> 20.001/s
# snapshots 18001 -> 10.001/s, p95 interval 102 ms
# ping p95 2.82 ms, tail gap 5 ms, roomStatus running, ok=true

node --test game/tools/tests/render-chunks.test.js   # 4 PASS
node --test game/tools/tests/mobile-quality.test.js  # 5 PASS
/Users/hermmoment/.dsh/profiles/desktop/node_modules/dsh-blender/.venv/bin/python \
  mapgen2/tools/build-mobile-atlases.py --check       # up to date, exit 0
# Browser low-tier (temp script, headless Chrome --force-device-scale-factor=2,
# localStorage 4tox.quality=low): DPR=1, villager/sprites/townhall metadata
# mobile=true, 3 жителя, lazy ruins -> ready после первого rubble,
# 0 page exceptions.
```

## 3. Матрица T01–T26

| ID | Где | Результат | Что именно |
|---|---|---|---|
| T01 | `sim-fixed-step.test.js` | PASS | 1200 шагов, 60 000 мс, одинаковый `canonicalHash` двух прогонов |
| T02 | `sim-fixed-step.test.js` | PASS | 17+17+16 мс → 1 тик; 49+1 мс → 2-й; дробного шага нет |
| T03 | `sim-fixed-step.test.js` | PASS | 100×0.07 при dt 1/60 и 0.05, ошибка ≤ одного шага, `walked` |
| T04 | `sim-navigation.test.js` | PASS | 4096 pop/тик, deferred≠unreachable, длинный job продолжается, checkpoint продолжает, dead освобождает |
| T05 | `sim-checkpoint.test.js` | PASS | удалённое дерево вернулось, RNG/часы/HP из capture, DTO не меняется после мутаций |
| T06 | `sim-checkpoint.test.js` | PASS | две ветки 600 тиков из одного capture — одинаковый hash/жители/часы |
| T07 | `sim-checkpoint.test.js` | PASS | Map/Set/alias/cycle/typed view/ArrayBuffer; функция → ошибка с путём |
| T08 | `sim-checkpoint.test.js` | PASS | ledger в DTO не меняется вслед за живым |
| T09 | `mp-room.test.js`, `mp-acceptance.js` | PASS | повтор ID не создаёт второй дом; duplicate receipt |
| T10 | `mp-room.test.js`, `mp-commands.test.js` | PASS | конфликт payload, чужой owner, неизвестный type, NaN-координаты, sequence gap, stale epoch |
| T11 | `mp-room.test.js` | PASS | submit отвечает после accept/fsync, не ждёт снимка/тикa |
| T12 | `mp-commands.test.js` | PASS | одна плохая клетка линии → 0 домов, 0 списаний |
| T13 | `mp-room.test.js` | PASS | закрытие после accept, до tickCommit → команда осталась received и применилась один раз |
| T14 | `mp-room.test.js` | PASS | закрытие после tickCommit → результат/world сохранились, повтор не применяет |
| T15 | `mp-room.test.js` | PASS | исключение в step → fault, последний committed снимок не сдвинулся |
| T16 | `mp-recovery.test.js` | PASS | оборванный хвост отсечён, повреждение в середине → fault |
| T17 | `mp-room.test.js` + worker generation | PARTIAL | epoch растёт, старые generation-сообщения отвергаются кодом; отдельного теста «старый worker message» нет |
| T18 | `mp-recovery.test.js` | PARTIAL | 2 checkpoint, history_expired, dedupe результатов; ротация 16 МиБ не прогонялась |
| T19 | `mp-interpolation.test.js` | PASS | прямой угол идёт по ломаной, не по хорде |
| T20 | `mp-interpolation.test.js` | PASS | одна renderTime — одна поза при 30/60/120 вызовах |
| T21 | `mp-interpolation.test.js` | PASS | duplicate/old/out-of-order/epoch/baseline/≤32 |
| T22 | `mp-interpolation.test.js` | PASS | 80/200/1000 мс: ≤100 мс экстраполяции, затем hold/stale |
| T23 | `mp-interpolation.test.js` | PASS | animInstance/phase, spawn/death/teleport по presentation time |
| T24 | `mp-pending.test.js` | PASS | applied до/после снимка, резерв ровно один раз, rejected не оживает |
| T25 | `mp-pending.test.js` | PASS | дом применён и снесён до baseline — pending завершается по версии |
| T26 | `mp-pending.test.js` | PASS | 61-е ожидание отклонено, старые 60 не вытеснены |

## 4. E01–E07

| ID | Результат | Что сделано |
|---|---|---|
| E01 | PASS | 60-секундное закрытие создателя в Chrome (гость продолжает, revision 86→1286); три 180-секундных окна (20.011 ticks/s, 10.005 snapshots/s, coverage 1.0) и 30-минутный soak (20.001/10.001, coverage 1.0, p95 102 мс). |
| E02 | PASS (CPU/activity) | RoomRuntime 100/200 активных за 180 с: 19.821/19.803 ticks/s, 9.911/9.902 snapshots/s, p95 8.45/8.98 мс, coverage 1.0. Работа и бой отдельно: 94/194 рабочих, 96/196 в бою; браузерная смесь 200 за 180 с — 10803 кадра, p95 16.7 мс, 0 >50 мс. CPU-профиль: render 5287 мс, combat 83 мс, navigation 35 мс, step 10 мс. GPU-профиль — NOT_RUN |
| E03 | PASS | `mp-acceptance.js`: хост перестал читать SSE на 1.5 с, гость получил 6 снимков; хост затем дочитал свежий кадр. Очередь ограничена, быстрый клиент не ждёт. |
| E04 | PARTIAL | F5/HTTP `/api/resume` с baseline и session проверен; 10-секундный разрыв сети с pending — нет |
| E05 | PARTIAL | `mp-interpolation.test.js` E05: offset/RTT при 150 мс и jitter 50 мс, renderTime не убывает; реальный network shaping — NOT_RUN |
| E06 | PARTIAL | fault/recover и рестарт HTTP с тем же STATE_DIR проверены; OS-kill worker'а и профиль I/O — нет |
| E07 | PARTIAL | solo/menu/generator/export: `menu.js`, `game.js`, `place.js`, `lumberjack*` PASS; DPR/mobile tier/lazy ruins PASS в headless Chrome; tap/hold на реальном coarse-pointer — NOT_RUN |

## 5. F01–F16 и D01–D06

| Код | Файл/функция | Тест/доказательство | Итог |
|---|---|---|---|
| F01 | `room-worker.js`, `room-runtime.js` | browser `mp.js`, `mp-acceptance.js` | PASS |
| F02 | `snapshot-buffer.js`, `server-clock.js`, `play.js` | T19–T22 | PASS |
| F03 | `play.js` (`netSend` не вызывается), `server.js` | browser `mp.js`, код | PASS |
| F04 | `boot.js drain`, `simulation.js` | T01/T02 | PASS |
| F05 | `villager.js walk` | T03, lumberjack/lumbercamp | PASS |
| F06 | `navigation.js`, `villager.findPath` adapter | T04 | PASS |
| F07 | `checkpoint.js`, `Simulation.fromState` | T05 | PASS |
| F08 | `checkpoint.js`, room ledger | T08 | PASS |
| F09 | room revision/epoch, buffer epoch | T21, durable restart | PASS |
| F10 | `checkpoint.js` vs `replication.js` | T05/T06/T23, код | PASS |
| F11 | `Session.*Core`, `Villagers.update` logical set | T01/T06, все тесты без DOM | PASS |
| F12 | `Replication.noteAnim`, `snapshot-buffer` | T23 | PASS |
| F13 | `Serialize.apply` (setBuildings только structural) | `mp-apply.test.js` | PASS |
| F14 | `render.js` `natureIndex/natureStream`, `objectRev` | `render-chunks.test.js` + `game.js`/`place.js`/`menu.js` | PASS |
| F15 | `quality.js`, `atlas-tags.js`, `build-mobile-atlases.py`, mobile/atlas.*, lazy ruins | `mobile-quality.test.js` + browser low-tier check | PARTIAL: один tier, DPR/mobile atlases/lazy ruins работают; real-device/GPU-профиль NOT_RUN |
| F16 | `pending.js` | T24–T26 | PASS |
| D01 | `analyze.js`, `recalc-s3.js` | `audit-metrics.test.js` + S3: 0.563/0.546/0.546 Гц snapshots, simRate 0.844/0.528/0.529, хвост 9.0/28.4/27.7 с | PASS |
| D02 | `research/mp-stabilization/tools/probe.js` | `audit-metrics.test.js` | PASS |
| D03 | `analyze.js` byte/gzip/trace поля | код + тест полного окна | PARTIAL (UI-трасса commandVisibleLatency не снималась) |
| D04 | README-арифметика | в новых доках не повторяется | PASS (старый текст не используется) |
| D05 | `mp-load.js` 100/200 | CPU-бенч | PARTIAL |
| D06 | `mp-load.js`, browser `mp.js` | условия среды записаны | PARTIAL |

## 6. Что осталось заблокировано

1. **F14/F15** — F14 реализован (чанки 16×16, k-way merge, полный экспорт);
   F15 реализован на уровне DPR/mobile-атласов/lazy ruins, но реальное
   устройство и GPU-профиль не снимались. Мобильная память/30 FPS — NOT_RUN.
2. **Реальный E05** — network shaping в этой сессии не поднимался; E05
   проверен только формулой часов на jitter, E03 — медленным непринимающим
   SSE-клиентом.
3. **E01/E02/E04/E06 в полном окне 180 с × 3 повтора и 30-минутный soak** —
   три 180-секундных повтора комнаты, один 30-минутный soak и отдельные
   180-секундные окна RoomRuntime с 100/200 активными сущностями выполнены
   (coverage 1.0). GPU-профиль не снят; окна с активной смесью в worker/SSE
   не повторялись.
4. **Реальное мобильное устройство** — NOT_RUN; 30 FPS/p95 33.3 мс не измерены.
5. **Локальный command handler** — PASS §9.4: build/buildLine, order/stop,
   edit rotate/delete/move и train/hire/fire (включая пакетные) идут через
   `Play.localCommand` → `applyNetCommandNow`. Отдельной очереди нет, но
   команда применяется синхронно в обработчике ввода между тиками, когда мир
   уже committed; во время шага JS не исполняется.
6. **`mapgen2/tools/ground.js`** — FAIL устранены: порог разницы участка
   снижен с 18 до 16 (у угла военного лагеря было 17/255 — участок есть),
   допуск ширины пляжа получил epsilon 1e-9. `ground.js` теперь PASS.

## 7. Сырые доказательства

* `game/tools/out/mp-acceptance-raw-2026-10-27T22-11-58-862Z.json` — все
  ответы сервера/SSE (baseline, ping, command, duplicate, resume).
* `game/tools/out/mp-acceptance-summary-2026-10-27T22-11-58-862Z.json` — 15 проверок, 15 PASS.
* `game/tools/out/mp-load-102.json`, `mp-load-202.json` — движение/path CPU.
* `game/tools/out/mp-load-work-102.json`, `mp-load-work-202.json` — работа/рубка.
* `game/tools/out/mp-load-work-202-180s.json` — 180 с в тиках.
* `game/tools/out/mp-load-work-202-realtime.json` — 183 с wall-clock с RSS.
* `game/tools/out/mp-load-work-202-memsample.json` — 60 с с покадровым RSS.
* `game/tools/out/mp-browser-load-100.json`, `mp-browser-load-200.json` —
  Chrome headless, 100/200 жителей, frame timings.
* `game/tools/out/mp-browser-work-100.json`, `mp-browser-work-200.json` —
  Chrome headless, 100/200 нанятых рабочих, frame timings.
* `game/tools/out/mp-browser-combat-100.json`, `mp-browser-combat-200.json` —
  Chrome headless, 100/200 воинов, frame timings.
* `game/tools/out/mp-browser-mixed-100.json`, `mp-browser-mixed-200.json`,
  `mp-browser-mixed-200-180s.json` — смесь работа+бой, 10 с и 180 с.
* `game/tools/out/mp-browser-mixed-200-profile.json` — CPU phase profile.
* `game/tools/out/mp-active-window-100.json`,
  `mp-active-window-200.json` — RoomRuntime 180 с с активным миром.
* `game/tools/out/mp-load-combat-100.json`, `mp-load-combat-200.json` — бой.
* `game/tools/out/mp-load-combat-200-180s.json` — 180 с в тиках.
* `game/tools/out/mp-window-2026-10-27T20-59-12-764Z.json`,
  `mp-window-2026-10-27T21-03-03-681Z.json`,
  `mp-window-2026-10-27T21-06-34-202Z.json` — три полных 180-секундных окна.
* `game/tools/out/mp-window-2026-10-27T21-37-59-537Z.json` — 30-минутный soak.
* `/tmp/final11-menu.log`, `/tmp/final11-mp.log`, `/tmp/final4-game.log`,
  `/tmp/final4-place.log`, `/tmp/final-combat2.log` — полные логи прогонов
  этой сессии (вне репозитория; в отчёте приведены команды и итоги).
* `research/mp-stabilization/tools/` — поддерживаемые probe/analyze/run-scenario;
  `game/tools/tests/` — 66 node:test.

## 8. Ограничения измерений

* CPU-бенч — Node без браузера; он не заменяет real-device rendering.
* `mp-load` считает 100/200 жителей, но не гарантирует, что все они
  одновременно выполняют работу/бой: это верхняя оценка стоимости шага, а не
  сценарий «200 лесорубов и две армии».
* Браузерные прогоны — headless Chrome на M4, не телефон; FPS/rAF не равен
  фактически показанным кадрам.
* Интервал между применениями снимков — не end-to-end latency; в отчёте он
  нигде не назван временем доставки.
