# 4tox: серверная комната и чистый движок

Дата: 2026-10-27. Исходный коммит: `6b9f06b52124cb24f1be12be147b15bdabd9c345`
(ветка `patch/4tox-stabilization`). Задание: `4tox_DeepSeek_Implementation_Prompt.md`.
Выкладка на прод в ходе работы **не выполнялась**.

## 1. Что изменилось по сути

До миграции браузер создателя считал мир, собирал `Serialize.world()` и
публиковал снимки на VPS; VPS был релеем, а команды гостей приезжали хосту в
ответе на снимок. Теперь:

* мир считает `worker_threads.Worker` комнаты, 20 шагов/с по 50 мс;
* создатель — обычный клиент: его вкладка только рисует и отправляет команды;
* все команды проходят серверную проверку, общую очередь и исполнение на
  границе тика;
* клиент получает независимые полные снимки 10 раз/с и рисует по серверной
  временной шкале с буфером 32 снимка;
* `SimulationCheckpoint` (полное продолжение мира) и `ReplicationSnapshot`
  (представление) — разные форматы; `Serialize.apply/hydrate` больше не
  используются для восстановления авторитетной симуляции.

## 2. Карта модулей

| Файл | Ответственность |
|---|---|
| `game/shared/net-config.js` | protocol 4, tick 50 мс, snapshotEvery 2, буфер 32, лимиты очередей, `STATE_DIR`-независимые числа |
| `mapgen2/js/simulation/gameplay-config.js` | СГЕНЕРИРОВАН из `atlas.json` жителя/воина: frames/fps/loop, `dropDuration=1/3`, цены, константы |
| `mapgen2/js/simulation/navigation.js` | порционный A*: 4096 pop/тик, quantum 256, 8 активных job, 4096 ожидающих, продолжение с того же heap |
| `mapgen2/js/simulation/checkpoint.js` | graph codec: объекты/массивы/Map/Set/typed arrays/DataView/ArrayBuffer/RNG, `$ref`, циклы, явные ошибки |
| `mapgen2/js/simulation/commands.js` | order/stop/build/buildLine/edit/train/hire/fire; ни renderer, ни toast |
| `mapgen2/js/simulation/simulation.js` | `create/fromState`, `step(commands)`, `exportState`, `events`; фиксированные фазы |
| `mapgen2/js/simulation/replication.js` | DTO снимка: towns/buildings/villagers/removed + motion-хвост и anim-метаданные |
| `game/server/room-runtime.js` | admission, очередь, durable accept/tickCommit, snapshot/revision/epoch, recover, diagnostics |
| `game/server/persistence.js` | журнал `len+payload+sha256`, fsync, checkpoint temp→sync→rename, 2 последних, rotate 16 MiB |
| `game/server/room-worker.js` | worker: `init/commands/snapshotAck/shutdown/diagnostics/testFault`; кредит на 1 снимок |
| `game/server/server.js` | лобби, токены, SSE, `/api/start`, `/api/command`, `/api/command-state`, `/api/resume`, `/api/ping`, `/api/recover` |
| `game/js/server-clock.js` | RTT/offset по c0/s1/s2/c3, медиана 3 лучших, неубывающий renderTime |
| `game/js/snapshot-buffer.js` | epoch/revision, 32 снимка, поза по ломаной, экстраполяция ≤100 мс, stale |
| `game/js/net.js` | envelope commandId/instance/sequence, `command-state`, ping-метки, baseline/resume |
| `game/js/play.js` | серверный baseline, presentation-only тик, display-позы, pending |
| `game/js/pending.js` | точный result, резерв, visualSettled ≠ resourceSettled, лимит 60 |
| `mapgen2/tools/build-mobile-atlases.py` | half-resolution PNG + metadata, `--check` |

## 3. Авторитетный жизненный цикл

### Старт

1. `POST /api/start` (только хост, все нажали «Готов») выбирает seed/size.
2. Главный поток создаёт worker комнаты (`room-worker.js`) и отправляет
   `init` с seed/size/players/owners и `STATE_DIR`.
3. Worker поднимает `RoomRuntime`, тот создаёт `Simulation` один раз (или
   восстанавливает checkpoint+журнал) и пишет нулевой checkpoint.
4. Только после `ready` с первым committed baseline лобби получает `start`;
   пока worker не готов, пустая running-партия не отдаётся.

### Тик и commit

`room-runtime.js` → `pump()`: монотонные часы, целые шаги 50 мс, не больше 4
шагов за проход и 8 мс CPU, остаток долга ждёт следующего вызова. На шаг:

1. выбрать до 64 принятых команд по возрастанию `roomOrder`;
2. `sim.step(commands)` — команды, затем `tick++`, `world.time=tick*0.05`,
   Combat, рождение, `Navigation.beginTick`, шаг жителей, удаление мёртвых,
   итог партии, `structureVersion`;
3. записать `tickCommit` (tick, revision, команды, результаты, события) и
   **fsync**;
4. только после fsync объявить tick/revision committed, обновить ledger,
   опубликовать снимок каждые 2 тика и checkpoint каждые 200 тиков (10 с).
   Снятие состояния синхронно на границе тика, запись/fsync — в фоне; тик не
   ждёт записи. Ошибка записи checkpoint'а не роняет комнату.

`applied` не отдаётся до fsync. Незавершённый тик не публикуется. Если
исключение внутри step — комната останавливается (`room-fault`), последний
committed снимок остаётся; выбранные команды получают durable
`rejected/recovery_interrupted` при восстановлении.

### Снимки и SSE

`Replication.build` строит новый независимый DTO после commit. Worker держит
не больше одного снимка in-flight до `snapshotAck`; если кредит занят, хранит
только последний committed, а не очередь DTO. Главный поток раскладывает один
актуальный снимок по ограниченным клиентским слотам SSE (существующий
`streamWrite`/gzip/backpressure). Новое подключение всегда получает baseline.

### Пустая комната

Сервер раз в 30 с сообщает worker'у, есть ли онлайн-игроки. Если никого нет
`emptyRoomGraceMs=600000` (10 минут), комната сохраняет checkpoint и
переходит в `suspended_empty`; reconnect внутри окна не пересоздаёт мир.
`/api/events` и `/api/resume` возвращают её в running.

## 4. Протокол

### Команда (вверх, HTTP POST `/api/command`)

```json
{
  "protocol": 4,
  "roomId": "ROOM",
  "epoch": 1,
  "commandId": "s0-<sha1(player)>:17",
  "clientSequence": 17,
  "type": "build",
  "payload": {"buildingType":"house","variant":"a","rot":0,"x":42,"y":39}
}
```

Сервер:

* аутентифицирует токен и берёт `owner`/`playerId` из лобби, а не из payload;
* проверяет `protocol/roomId/epoch`, длину тела 16 КиБ, `ids≤200`,
  `commandId` начинается с выданной сервером instance;
* известный ID с тем же payload → прежний результат; с другим payload →
  `command_id_conflict`;
* `epoch` старый → `stale_epoch`; новый ID не по порядку → `sequence_gap`;
  повтор уже consumed ID ниже boundary → `history_expired`;
* token bucket 20/с burst 40, очередь 64/игрок и 256/комната;
* `accept` пишется в журнал и fsync **до** ответа `received`/HTTP 202;
* отказ до admission имеет `admitted:false` и не расходует ID.

### Результат

`GET /api/command-state?code&token&id=...` (можно несколько `id`, и `n` для
старой формы) отдаёт `{status: received|applied|rejected|expired|
history_expired|unknown, appliedTick, appliedRevision, decidedTick,
decidedRevision, reasonCode, reason, ids, nextClientSequence, watermark}`.
Результаты незакрытых команд дублируются в персональном блоке снимка
`commandResults` до client ack.

### Снимок (вниз, SSE `snapshot`)

`protocol/roomId/epoch/revision/seq/simulationTick/simulationTimeMs/
serverGeneratedAtMs/worldgenVersion/worldgenHash/gameplayConfigHash/seed/size/
structureVersion/over/winner/roomStatus/towns/buildings/villagers/objectTotal/
removed/commandResults`, плюс у жителя `motion` (фактическая ломаная
последней секунды, ≤128 точек), `animInstance/animStartTimeMs/
animDurationMs/loop`, `safeExtrapolationTo`, `spawnTimeMs/deathTimeMs/hidden`.
Полные снимки независимы, без baseRevision; дельт в этом релизе нет.

### Часы

`GET /api/ping?c0=...` возвращает echo `clientSendAtMs` и
`serverReceiveAtMs/serverSendAtMs` (монотонный `hrtime`), `epoch/tick/
simulationTimeMs/roomStatus`. Клиент считает
`rtt=(c3-c0)-(s2-s1)`, `offset=((s1-c0)+(s2-c3))/2`, медиану 3 проб с
наименьшим неотрицательным RTT; `renderTime = simulationTime + serverMono -
serverGeneratedAt - 150`.

## 5. Checkpoint, журнал, восстановление

### Checkpoint

`Checkpoint.encode(state)` → `{checkpointSchema:1, root, nodes, meta}`.
Поддерживаются plain object/array/Map/Set/typed array/DataView/ArrayBuffer/
RNG (`{seed,state}`), `undefined`, `$ref` на общий узел, циклы. Функции,
DOM/Canvas/Image/Promise/unsupported instance → ошибка с путём. Decode:
сначала все узлы, потом views, потом содержимое; ссылки указывают на те же
объекты. `canonicalHash` — FNV-подобный хеш канонического графа, независим
от порядка ключей plain object.

### Журнал

`STATE_DIR` (env; по умолчанию `./game/server/var/rooms` относительно cwd)
`/<roomId>/`:

* `journal-NNNNNN.log` — записи `uint32 length + JSON payload + sha256[0..8]`;
* `checkpoint-<tick>-<revision>-<epoch>.json` — последние два;
* `meta.json` — номер сегмента;
* `lobby.json` — код/токены/состав лобби, режим 0600 (секреты).

Записи: `accept`, `tickCommit`, `control` (room-start, fault, terminal,
suspend, recover). Запись длиннее 4 МиБ запрещена; сегмент 16 МиБ; старые
сегменты старше предыдущего сохраняемого checkpoint удаляются. При загрузке
оборванный последний record отсекается, повреждение в середине — fault.
Replay `accept` не исполняет команду; исполнение привязано только к
`tickCommit`. Checkpoint хранит журнальный offset; новый checkpoint не
считается пригодным до atomic rename + fsync каталога.

### Epoch / revision

* `simulationTick` — завершённые шаги мира; при restore может вернуться назад
  к checkpoint.
* `simulationTimeMs = tick * 50`.
* `revision` — серверная версия каждого committed тика, монотонна; при
  restore не берётся из старого сетевого снимка.
* `epoch` — поколение комнаты; растёт при restart/recover. Старые worker
  messages и снимки отвергаются по generation/epoch.
* `workerGeneration` — внутренний токен процесса, не заменяет epoch.

### Fault / recover

Логическая ошибка: комната → `faulted`, клиенты получают `room-fault`;
последний committed снимок не меняется. Восстановление — отдельное действие
организатора `POST /api/recover`: новый SimState из последнего checkpoint,
replay журнала, новый epoch, baseline всем; команды упавшего тика получают
`recovery_interrupted`. Автоматического повторения шага после логической
ошибки нет.

## 6. Команды и pending

`Commands.apply` — единственная реализация правил. `build` проверяет
type/rot/координаты/цену/`Buildings.canPlace` с живыми жителями и только
потом списывает; `buildLine` сначала строит полный план и суммарную цену, при
одном плохом элементе — ноль домов и ноль списаний. `edit` проверяет
владение/`canEdit`/`checkAt`; `train/hire/fire` — владение и правила Session;
`order/stop` фильтруют только своих живых воинов.

`game/js/pending.js` создаёт commandId до HTTP, держит призрак и отдельный
резерв. `resourceSettled` наступает по terminal result + authoritative
revision, `visualSettled` — по появлению реального id в снимке. Резерв
снимается ровно один раз; rejected снимает, поздний received не оживляет.
Лимит 60: 61-е действие отклоняется, старые не вытесняются. Два снимка/30 с
больше ничего не завершают.

## 7. Клиент

* `Net` хранит `{code,token,playerId,roomId,epoch,instance,seq}` в
  localStorage под ключом вкладки; F5 сохраняет instance и sequence.
* baseline из `/api/start`/`/api/resume` применяется `Serialize.apply` с
  `smooth:false`; затем `SnapshotBuffer.push` и `ServerClock`.
* `Play.tick` в MP не вызывает `Simulation.step`/`Session.stepVillagers`/
  `Combat.tick`: только `presentNet(dt)` — renderTime, позы, камера, HUD.
* поза ищется по ломаной `motion`, а не по прямой между снимками; rot —
  кратчайшей дугой; phase — от `animStartTimeMs`, не перезапускается каждым
  снимком; экстраполяция ≤100 мс только по `safeExtrapolationTo`, затем hold
  и stale после 500 мс.
* `Serialize.apply` переиспользует объекты по id; `renderer.setBuildings`
  вызывается только при структурном изменении (F13).

## 8. Локальная игра и генератор

Одиночная игра и генератор не подключаются к VPS. `boot.drain` исполняет
только целые шаги `SIM_STEP=0.05`; дробный остаток ждёт. `game/index.html`
грузит `navigation.js`, поэтому локальный шаг тоже использует порционный A*;
`mapgen2/index.html` оставлен на старом синхронном `findPath` (генератору он
не нужен). Цены/константы читаются из `GameplayConfig` в игре; `play.js`
пока сохраняет `BUILD_MENU` как UI-описание, но серверные цены — из конфига.

## 9. Пределы и настройки

Из `game/shared/net-config.js`:

```
protocol 4, commandProtocol 3, tickMs 50, snapshotEveryTicks 2,
interpolationDelayMs 150, maxExtrapolationMs 100, snapshotBufferSize 32,
staleAfterMs 500, schedulerMaxStepsPerTurn 4, schedulerBudgetMs 8,
heartbeatMs 2000, commandBodyMaxBytes 16384, commandMaxIds 200,
buildLineMaxItems 64, commandQueuePerPlayer 64, commandQueuePerRoom 256,
commandsPerTick 64, pendingMax 60, controlQueueMaxBytes 262144,
streamQueueMaxBytes 2097152, slowClientTimeoutMs 5000,
checkpointEveryTicks 200, emptyRoomGraceMs 600000
```

`MAX_ACTIVE_ROOMS` (env, по умолчанию 1) — предел комнат, не игроков. Отказ
`server_capacity` явный. `STATE_DIR` — env; файлы вне web-root, раздача
статики их не видит.

## 10. Развёртывание (без выполнения)

Порядок из `docs/DEPLOY.md` сохраняется: staging только из `game/` и
`mapgen2/`, dry-run rsync, backup, выкладка, `COMMIT`, рестарт только
`4tox.service`; Caddy не перезапускать (он обслуживает VPN). Для новой схемы
дополнительно:

* `STATE_DIR=/opt/4tox-var/rooms` (или другой volume) с владельцем `4tox`,
  права 0700; не класть внутрь `/opt/4tox/game` и не отдавать статикой;
* reverse proxy: SSE без буферизации (`flush_interval -1`), API без кеша;
* обновлять server+client+cache-версию согласованно; старый браузерный
  снимок нельзя объявлять checkpoint нового формата;
* откат бинарного кода к protocol 3/2 должен идти со СТАРОЙ копией
  STATE_DIR: новый журнал/checkpoint старый код не прочитает. Это отдельная
  копия и потеря только новой тестовой партии, если обратной миграции нет.

## 11. Рендер: F14 и F15

**F14.** `Renderer.natureIndex()` строит чанки 16×16 по `world.objectRev`
(растёт в `Villages.fell`, `Buildings.dropObjects`, инициализируется
`WorldGen.generate`). Внутри чанка порядок — `x+y`, затем исходный `id`.
`natureStream(box)` выбирает пересекающиеся чанки и делает k-way merge
двоичной кучей; `drawObjects` передаёт `{cull:true, box}` с запасом
`naturePad()` из `meta.cell/res`, а экспорт вызывает `eachSprite` без culling.
Полный и chunk-iterator дают одинаковый порядок (`render-chunks.test.js`).
`coverMask`, treeShake/sway/dead/hidden и tie-break не меняются.

**F15.** `game/js/quality.js` — auto/low/high: coarse DPR≤1.5, desktop≤2,
low=1, high=min(devicePixelRatio,2); CSS/input не меняются. `render.js`
берёт `dprCap` из Quality, `setQuality` не поднимает выше 2. Для фактически
загружаемых атласов (`sprites, waves, villager, armored_villager, townhall,
starter_house, lumbercamp, barracks, warcamp, ruins`) собран
half-resolution вариант: кадры режутся по отдельности, resize, повторная
упаковка с padding, `ppu×0.5`, `w/h/anchor×0.5`, `footprint`/`ground` не
меняются. `mapgen2/tools/build-mobile-atlases.py --check` проверяет
воспроизводимость. Loader через `atlas-tags.js` выбирает ровно один tier; missing mobile metadata
даёт desktop fallback с `console.warn`, а не пропавших персонажей. Руины
загружаются лениво при первом `rubble`. `Renderer.assetStats()` отдельно
показывает decoded estimate и main/cache canvas.

## 12. Что осталось вне этого релиза

* 180-секундные окна (три повтора) и 30-минутный soak комнаты проведены;
  те же окна с 100/200 активными сущностями — нет. Отдельно снят CPU-бенч
  движения/работы/боя на 100/200.
* Реальное mobile-устройство и 30 FPS — NOT_RUN; low-tier проверен в
  headless Chrome, это не заменяет телефон.
* Локальные build, buildLine, order/stop, edit rotate/delete/move и
  train/hire/fire (включая пакетные) идут через `Play.localCommand` →
  `applyNetCommandNow` — та же логика, что у серверной команды. Остались
  только UI-превью (ведение дома за курсором) и откат `B.restore` при
  «Отменить»; они не являются отдельными правилами мира. Команда применяется
  синхронно в обработчике ввода между тиками; мир в этот момент уже committed,
  а шаг симуляции не исполняется, поэтому это граница локального тика.
  Отдельной очереди нет — при однопоточном UI она не нужна.
* `mapgen2/tools/ground.js` имеет 3 FAIL и на исходном HEAD (см. validation);
  это не регрессия миграции.
