# Аудит №01 — ядро симуляции и протокол команд

Дата: 2026-10-28. Коммит `610db26`. Область: `mapgen2/js/simulation/*` (simulation, commands,
navigation, checkpoint, replication, gameplay-config), `mapgen2/js/{rng,noise}.js`,
`game/shared/net-config.js`, `mapgen2/tools/build-gameplay-config.js` — и то, как они стыкуются с
комнатой (`game/server/room-runtime.js`) и клиентом (`game/js/play.js`, `mapgen2/js/render.js`,
`mapgen2/js/serialize.js`). Браузерные приёмки не запускались (по заданию); все прогоны — node на
чистых модулях через `game/tools/tests/load-engine.js`, скрипты в `/tmp/audit/`. В репозитории
ничего не менялось, кроме этого файла.

## Сводка

| severity | шт. |
|---|---|
| blocker | 1 |
| critical | 1 |
| major | 1 |
| minor | 1 |

Существующая node-приёмка `node --test game/tools/tests/*.test.js` — **66/66 зелёная**, то есть
ни одну из находок ниже она не ловит.

---

## Находки

### BUG-01-01 · `buildingType` из цепочки прототипа: бесплатные постройки, NaN в казне и невосстановимая комната · blocker

- Файл: `mapgen2/js/simulation/commands.js:67-72`, `:152-175`, `:177-214` · `mapgen2/js/simulation/checkpoint.js:97-100` · `game/server/room-runtime.js:611-613`, `:760-762`
- Что происходит. Цена постройки берётся из общего объекта без проверки своего ключа:

  ```js
  function buildPrice(type) {
    var G = global.GameplayConfig;
    if (G && G.prices && G.prices[type] !== undefined) return G.prices[type];  // ← нет hasOwnProperty
    ...
  ```

  `GameplayConfig.prices` — обычный литерал (`{"barracks":28,"house":12,...}`), у него есть
  прототип. Поэтому `buildPrice('constructor')` (и `'toString'`, `'valueOf'`, `'hasOwnProperty'`)
  возвращает **встроенную функцию**, а не `undefined`. Дальше в `build`:

  * `if (!price) return reason('unknown_building')` — функция truthy, проверка «неизвестная
    постройка» **пройдена**;
  * `if ((town.logs || 0) < price)` — сравнение числа с функцией даёт `NaN`, `NaN < ...` = false →
    **проверка ресурсов пройдена** даже при `logs = 0`;
  * `town.logs -= price` → `NaN`;
  * `buildOne(...)` → `Buildings.make({type:'constructor'})`: `footprint()`/`typeOf()` неизвестный
    тип трактуют как ратушу (`FALLBACK_FP[DEFAULT_TYPE]`), `canPlace` проверяет пятно 4×3 и место
    года → **постройка встаёт в мир бесплатно**.

  Последствия:
  1. Из нуля брёвен можно поставить сколько угодно построек — проверка повторяется столько же раз
     (`(NaN||0)=0`, `0 < функция` = false), то есть это не одноразовая дыра, а бесконечный чит.
  2. Казна деревни навсегда становится `NaN`: сдача брёвен (`villager.js:2605 vill.logs += 4`)
     NaN не лечит, обычная постройка после этого отклоняется «не хватает брёвен» навсегда, а
     клиенту уезжает `0` (`serialize.js:58` — `logs: t.logs || 0`), поэтому поломка не видна.
  3. `Checkpoint.encode` обязан отвергать не-числа (`checkpoint.js:97-100`), поэтому
     `sim.exportState()` бросает `non_finite_number at root.world.towns[0].logs`. Комната зовёт
     `writeCheckpoint` каждые 40 тиков (`room-runtime.js:611`), ловит это как `enterFault(e,
     'checkpoint')` — **матч падает целиком** (статус `faulted`, у всех клиентов `room-fault`).
  4. `recover()` не помогает: он поднимает последний чекпоинт и **заново проигрывает журнал**
     (`replayJournal` → `sim.step(r.commands)`), команда применяется снова, NaN возвращается, и
     финальный `writeCheckpoint` внутри `recover` снова бросает → `{ok:false}`.

- Репро (node, воспроизводится на сгенерированном острове, боевой мир не нужен):

  1. `makeSim({players:2})`, `towns[0].logs = 0`.
  2. Найти годную клетку: `Buildings.canPlace(world, buildings, make({type:'house',rot:0,x,y}))`.
  3. Три раза: `Commands.apply(state, {type:'build', owner:0, payload:{buildingType:'constructor',
     rot:0, x, y}})` — каждый раз другой свободный участок.
  4. `sim.exportState()`.
  5. Через комнату: `RoomRuntime({...checkpointEveryTicks:1})` → `submit(cmd)` →
     `executeAndCommitOneTick()` → `recover('audit')`.

- Доказательство (вывод `/tmp/audit/probe1.js`, `probe10.js`):

  ```
  TYPE constructor => {"status":"applied","reasonCode":null,"reason":"","ids":["p0:b1000"]} logs NaN buildings 6 -> 7
    built type= "constructor" variant= a id= p0:b1000
  CHECKPOINT THREW: non_finite_number non_finite_number at root.world.towns[0].logs
  normal build after NaN => {"status":"rejected","reasonCode":"no_resources",...}

  free build 0 applied logs NaN buildings 7      # logs было 0
  free build 1 applied logs NaN buildings 8
  free build 2 applied logs NaN buildings 9

  # комната, checkpointEveryTicks:1
  after tick: logs NaN buildings 7 status faulted fault phase checkpoint
  recover => {"ok":false,"reason":"non_finite_number at root.world.towns[0].logs"}
  ```

  Цитата кода комнаты, где это становится фатальным:

  ```js
  if (this.tick % this.checkpointEvery === 0) {
    try { await this.writeCheckpoint(this.tick); }
    catch (e) { this.enterFault(e, 'checkpoint'); throw e; }
  }
  ```

  Какая приёмка это НЕ ловит: `game/tools/tests/mp-commands.test.js` посылает только `house`;
  `gameplay-config.test.js` сверяет цены с `BUILD_MENU`, но не сам поиск по ключу; ни один тест не
  подаёт тип вне `TYPES` и не проверяет, что казна осталась числом. `--check` генератора тоже
  смотрит только на файл конфига.

- Уверенность: **высокая** (воспроизведено полностью: чит, NaN, fault комнаты, отказ recover).
- Правка (1–3 строки):

  ```js
  function buildPrice(type) {
    var G = global.GameplayConfig;
    if (G && G.prices && Object.prototype.hasOwnProperty.call(G.prices, type)) return G.prices[type];
    ...
  ```

  и в `buildOne` — белый список: `if (!global.Buildings.TYPES || !Object.prototype.hasOwnProperty.call(global.Buildings.TYPES, type)) return { ok:false, reason:'неизвестная постройка' }` (одна строка закрывает BUG-01-01 и BUG-01-02 заодно).

---

### BUG-01-02 · постройка с типом вне `TYPES` валит отрисовку у ВСЕХ клиентов комнаты · critical

- Файл: `mapgen2/js/render.js:277-282` (spritesFor), `:400-405` (buildingBox), `:2518-2521` (drawBuilding) · `mapgen2/js/buildings.js:907-912` (sprite) · `mapgen2/js/serialize.js:74-81` (buildingSnap отдаёт `type` как есть) · `game/js/play.js:1597-1613` (noteFault)
- Что происходит. Тот же вход, что в BUG-01-01 (тип `constructor`), но другая сторона: принятая
  постройка уезжает в снимок без проверки типа и попадает в отрисовку клиента.

  ```js
  Renderer.prototype.spritesFor = function (type, ruined) {
    var id = (B && B.typeOf) ? B.typeOf({ type: type }) : (type || 'townhall');
    if (ruined && this.ruinSets[id]) return this.ruinSets[id];
    return this.buildingSets[id] || null;          // buildingSets = {} (render.js:161)
  };
  ...
  var set = this.spritesFor(b.type, b.rubble);
  if (!B || !set) return null;                     // здесь set = функция Object!
  var spr = B.sprite(set, b.rubble ? B.typeOf(b) : b.variant, b.rot);
  ```

  `this.buildingSets['constructor']` — это `Object` из прототипа, то есть truthy. Защита
  `if (!set) return null` не срабатывает, и `Buildings.sprite(Object, ...)` читает
  `set.frames[variant]` у функции → `TypeError: Cannot read properties of undefined (reading 'a')`.
  `drawBuilding` ничем не защищён; `boot.js` ловит кадр в `guardFrame` → `Play.noteFault(e, label)`
  без `fatal:false` → `state.faulted = true` → шаг мира у клиента останавливается
  (`boot.js:574`, `play.js:2421`). То есть одна команда любого участника гасит рендер/шаг у всех
  гостей и у хоста-клиента.

- Репро: после BUG-01-01 (или отдельно — вписать в `buildings` мира постройку `{type:'constructor'}`)
  вызвать отрисовку любого кадра. Минимально — прямой вызов:

  ```
  node -e "...; const set = ({}).constructor; Buildings.sprite(set, 'a', 0)"
  → THREW: TypeError Cannot read properties of undefined (reading 'a')
  ```

  Полный кадр в браузере не гонялся (запрет на браузерные приёмки), но путь
  `spritesFor → sprite → buildingBox → drawBuilding → guardFrame → noteFault(fatal)` прочитан
  построчно.

- Доказательство: вывод выше; код `sprite`:

  ```js
  function sprite(set, variant, rot) {
    if (!set) return null;                      // функция Object — не null
    var v = set.frames[variant] || set.frames.a;  // set.frames === undefined → TypeError
    if (!v) return null;
    return v[((rot % 360) + 360) % 360] || v[0];
  }
  ```

  Какая приёмка это НЕ ловит: `node --test` не грузит `render.js` вовсе (движок грузится без
  DOM/Canvas), а браузерные `mp.js`/`menu.js` строят только из меню, где типы всегда настоящие.

- Уверенность: **высокая** в механизме; средняя в том, что кадр падает именно фатально (это
  прочитанный код `guardFrame`/`noteFault`, не прогон в Chrome).
- Правка: `if (!Object.prototype.hasOwnProperty.call(this.buildingSets, id)) return null;` в
  `spritesFor`, и белый список типов на сервере (см. BUG-01-01). DTO — граница доверия, поэтому
  клиентская защита нужна отдельно от серверной.

---

### BUG-01-03 · `variant` не проверяется: военный лагерь без варианта невидим, но занимает 5×5 и получает урон · minor

- Файл: `mapgen2/js/simulation/commands.js:108-117` (`variant: variant || 'a'`), `:177-214` (buildLine) · `mapgen2/js/buildings.js:907-912` · `mapgen2/assets/warcamp/atlas.json` (`variants: {"x":[5,5]}`)
- Что происходит. У военного лагеря в атласе **единственный** вариант `x` (в меню он и стоит:
  `game/js/play.js:96`). Но команда подставляет `'a'` по умолчанию и вариант никак не сверяется с
  атласом. Постройка с `variant:'a'` для warcamp: `sprite()` → `frames['a']` нет, `frames.a` нет →
  `null` → `buildingBox` → `null` → **не рисуется ни у кого**, при этом `footprint` = 5×5, у неё есть
  HP, она блокирует ходьбу, её можно двигать/поворачивать (и она невидима для того, кто её двигает).
  Штатный клиент вариант посылает, поэтому нужен нештатный/старый клиент (протокол допускает
  `protocolWarning`, а не отказ) или команда, набранная руками.
- Репро:

  ```
  Commands.apply(state, {type:'build', owner:0, payload:{buildingType:'warcamp', rot:0, x, y}})
  → applied; b.variant === 'a'
  Buildings.sprite(setWarcamp, 'a', 0) → undefined
  ```

  (Проверено и обратное: `sprite(set,'constructor',0)` тоже возвращает `undefined` — простое
  «варианта нет» деградирует в невидимость, а не в ошибку.)

- Доказательство: `assets/warcamp/atlas.json` — `"variants":{"x":[5,5]}`, кадры только `"variant":"x"`;
  `buildOne` — `variant: variant || 'a'`.
  Какая приёмка это НЕ ловит: `place.js` ставит лагерь из атласа (вариант настоящий);
  `mp-commands.test.js` строит `house`; ни один тест не подаёт warcamp без варианта.

- Уверенность: **высокая** в механизме, **средняя** в достижимости штатным клиентом.
- Правка: сверять `variant` с `meta.variants` типа (или с `Buildings.sprite(...) !== null`) и
  отклонять `invalid_variant`; убрать `|| 'a'` для типов, у которых такого варианта нет.

---

### BUG-01-04 · `town_gone` проверяется только в `build`/`buildLine`: выбывший игрок продолжает править деревню и нанимать · major

- Файл: `mapgen2/js/simulation/commands.js:156` и `:181` (единственные проверки `town_gone`) против `:216-240` (`edit`), `:242-255` (`train`/`hire`/`fire`), `:132-151` (`order`/`stop`).
- Что происходит. Когда ратуша пала, `Session.handleTownFallen` (simulation.js:50-59) ставит
  `town.alive = false`. После этого:

  * `build` отвечает `town_gone` — «ваша деревня больше не в игре»;
  * `edit` (`move`/`rotate`/`delete`) — **applied**;
  * `hire` — **applied** (и лесорубы продолжают сдавать брёвна в мёртвую деревню: `deposit`
    ищет город по `v.town` и про `alive` не спрашивает, `villager.js:2604-2610`);
  * `order`/`stop` — **applied** (воины выбывшего продолжают воевать).

  То есть «выбывание по ратуше» (AGENTS.md, раздел про бой) выполнено только для стройки: игрок
  без ратуши сохраняет экономику, наём и армию, хотя его собственная команда `build` уже говорит,
  что деревня не в игре. В партии на 4 это не косметика: выбывший продолжает тянуть брёвна и
  нанимать рабочих.

- Репро (`/tmp/audit/probe11.js`): `makeSim({players:4})`, открыть мир, поставить дом, затем
  `world.towns[0].alive = false` и послать команды с `owner:0`.

- Доказательство:

  ```
  build after death       => {"status":"rejected","reasonCode":"town_gone",...}
  edit move after death   => {"status":"applied",...}
  edit rotate after death => {"status":"applied",...}
  edit delete after death => {"status":"applied",...}
  hire after death        => {"status":"applied",...}
  ```

  Какая приёмка это НЕ ловит: ни `mp-commands.test.js`, ни `game.js`/`mp.js` не проверяют команды
  выбывшего игрока (партия обычно заканчивается сразу, потому что в тестах 2 игрока и
  `standing.over` наступает на том же тике).

- Уверенность: **высокая** в факте; **средняя** в том, какое поведение задумано (в правилах
  заказчика сказано «выбывание по ратуше», но не расписано, что именно гаснет). Поэтому major, а
  не critical.
- Правка: одна проверка в начале `Commands.apply` —

  ```js
  var town = townOf(sim, cmd.owner);
  if (cmd.type !== 'stop' && town && town.alive === false) return reason('town_gone', 'ваша деревня больше не в игре');
  ```

  (для `stop` оставить, чтобы выбывший мог остановить своих воинов, если это нужно правилу).

---

## Проверено и НЕ баг

1. **У только что построенной постройки нет `hp`/`maxHp`** (`Commands.build` → `Buildings.make`, в
   DTO уезжает `hp: undefined`). Не баг: `Combat.tick` в начале каждого тика зовёт `init`, который
   заполняет `maxHp`/`hp` до первого удара (`combat.js:387-395`, `:741`). Замер: сразу после
   команды `hp undefined`, после одного `sim.step([])` — `hp 50 maxHp 50`.
2. **«Отложенное рождение в одном городе рожает во всех»** — гипотеза не подтвердилась:
   `clock.due` снимается в конце `tryBirthCore` (`session.js:563`), поэтому повтор по `pending`
   касается только своего города. Замер (`probe5.js`): при `pending` города 0 на 35-й секунде
   население `{0:5, 1:4}` — прибавка только у города 0.
3. **Полный roundtrip checkpoint** `exportState → fromState`: на тиках 0, 1, 5, 37, 40, 41, 200, 600
   `canonicalHash` совпал, и после +200 тиков обе ветки снова совпали (жители, рубли, навигация).
   Отдельно проверены циклы, `$ref`, алиасы, `Map`/`Set`, `ArrayBuffer`+view со смещением,
   `undefined`, RNG — тестом T07 и прогоном `probe2.js`.
4. **«Зомби» после переполнения `waiting`** (navigation.js:313-319) недостижим: `requestPath`
   отказывается ставить job в очередь, когда `waiting.length >= maxWaiting` (`:399-402`), поэтому
   ветка `waiting.length > maxWaiting` — мёртвый код. При искусственных `maxActive=1`,
   `maxWaiting=1`, `maxPopsPerTick=1` и четырёх дальних запросах: 1 active + 1 waiting + 2
   `deferred/navigation_queue_full`, `queueFull`-дроп не срабатывает, вечных `cancelled`-job нет.
   Сама ветка всё же заслуживает удаления: если появится второй путь наполнения `waiting`, она
   оставит job в `s.jobs` навсегда.
5. **`order` с дикими координатами** (`1e9`, `-1e9`, `MAX_SAFE_INTEGER`, дробные) не бросает:
   `Army.order` отвечает `order_failed: «туда не дойти: другой берег»`. 800 случайных команд
   (типы, `NaN`/`Infinity`/строки/массивы/`null` в каждом поле payload, владельцы 0/1/2/99) — **0
   исключений** (`probe12.js`), то есть валидация команд от мусора держится.
6. **`edit move` не зовёт `canEdit(b,'move')`** (в отличие от `rotate`/`delete`) — сегодня без
   последствий: у всех пяти типов `EDIT.move = true` (`buildings.js:193-202`). Латентная дыра на
   случай, когда у типа появится `move:false`.
7. **Атомарность `buildLine`**: `planLine` проверяет каждого кандидата против
   `list.concat(accepted)` (`buildings.js:1681`), поэтому «два новых дома запирают выход» ловится
   до списания; команда затем перепроверяет те же места теми же опциями. Частичной серии нет.
8. **`line_too_long` в Commands (`plan.items.length > 64`) — мёртвая проверка**: `planLine` и так
   режет серию по `LINE_MAX = 20`, а `NetConfig.buildLineMaxItems = 64`. Косметика/рассинхрон
   конфига, не поведение.
9. **`Simulation.step` бросает `too_many_commands` при >64 командах** — из протокола недостижимо:
   `RoomRuntime.commandsPerTick = 64` и `selectCommands` режет очередь (`room-runtime.js:460`).
10. **`gameplay-config` сходится с источниками**: `node mapgen2/tools/build-gameplay-config.js
    --check` → exit 0, hash `9258f5c1…`; вручную сверены `SPEED = 1.26·1.1/2.2 = 0.63`,
    `CHOP_HIT_EVERY = 5/8 = 0.625`, `LOGS_PER_TRIP = 4`, `WARCAMP_CAP = 20`,
    `BARRACKS_YARD_CAP = 10`, `TRAIN_SLOTS = 3`, `LINE_MAX = 20`, `YARD = 1`, цены = `BUILD_MENU`,
    `variant 'x'` warcamp есть в атласе. Расхождения нет.
11. **Детерминизм в шаге**: в пути симуляции нет `Math.random`/`Date.now` — только `rng.js:79`
    (генерация сида для меню) и `worldgen.js:221/552` (замер времени, `genTimeMs = 0` в симуляции).
    Порядок `Map`/`Set` в шаге не используется; сортировки стабильные, компараторы без NaN.
12. **`town.logs` в снимке как `t.logs || 0`** — само по себе правильно (JSON не умеет NaN), но
    именно это прячет поломку из BUG-01-01 от игрока и от приёмок; отдельным багом не считаю.

## Не проверено

- **Браузерные приёмки** (`game/tools/menu.js`, `game/tools/mp.js`, `mapgen2/tools/game.js`) — по
  заданию их гоняет координатор. Поэтому полный путь кадра для BUG-01-02 (`guardFrame` →
  `noteFault` → `state.faulted`) прочитан, а не выполнен в Chrome; доказан только сам бросок
  `Buildings.sprite` на функции-«наборе».
- **Persistence за пределами `recover()`**: ротация сегментов журнала, падение процесса, повторный
  `start()` комнаты после fault (в прогонах `checkpointEveryTicks:1` вместо боевых 40).
- **Реальный бой после выбывания** (BUG-01-04): проверено применение команд, но не то, что воины
  выбывшего продолжают наносить урон — для этого нужен сценарий боя на несколько минут.
- **Долгая память навигации**: посчитана цена одного job (20 байт/клетка + 24 КБ: ~146 КБ на карте
  78×78, ~1,3 МБ на 256×256) и теоретический потолок `maxWaiting = 4096`, но живой прогон 192/256 с
  200 жителями, который показал бы реальное заполнение `waiting`, не делался — это гипотеза о
  риске OOM, а не находка.
- **Режимы `Simulation.create` `home`/`bot`**: комната всегда создаёт `mode:'multi'`
  (`room-runtime.js:187`), поэтому ветки `home`/`bot` (и `state.players` для них) не аудировались —
  из браузерной игры они недостижимы.
- **Сеть/DTO за пределами полей**: `epoch`/`revision`/`baseline` и SSE — область аудита №08, не
  дублировал.

---

## Топ-5 по важности

1. **BUG-01-01 (blocker)** — `buildingType: "constructor"` даёт бесплатные постройки из нуля брёвен,
   навсегда отравляет казну `NaN` и валит комнату на чекпоинте; `recover()` не помогает, потому что
   журнал проигрывает ту же команду. Фикс — `hasOwnProperty` в `buildPrice` + белый список типов.
2. **BUG-01-02 (critical)** — та же постройка уезжает в снимок и валит отрисовку у всех клиентов
   (`spritesFor` возвращает `Object` из прототипа, `sprite` бросает `TypeError`, `noteFault` делает
   fault фатальным). Фикс — `hasOwnProperty` в `spritesFor` + белый список на сервере (DTO — граница
   доверия).
3. **BUG-01-04 (major)** — `town_gone` есть только у `build`/`buildLine`: выбывший по ратуше игрок
   продолжает править постройки, нанимать рабочих и командовать воинами, а его лесорубы сдают
   брёвна в мёртвую деревню. Нужна одна проверка в начале `apply` (или явное правило заказчика).
4. **BUG-01-03 (minor)** — `variant` не сверяется с атласом, а `buildOne` подставляет `'a'`;
   военный лагерь (единственный вариант `x`) в таком случае невидим, но занимает 5×5, имеет HP и
   блокирует ходьбу.
5. **Мёртвая ветка переполнения `waiting`** (navigation.js:313-319) — не баг сегодня (недостижима),
   но именно она оставила бы вечный `cancelled`-job в `s.jobs`, если появится второй путь наполнения
   очереди. Удалить или починить превентивно; заодно пересмотреть `maxWaiting = 4096` при цене
   ~1,3 МБ на job для карты 256.
