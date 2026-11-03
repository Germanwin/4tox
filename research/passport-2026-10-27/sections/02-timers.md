# 02. Игровые и сетевые циклы, часы мира и таймеры

Срез: `HEAD=6b9f06b`. Метод: чтение исходников; игра и браузер в рамках этого раздела не запускались. Все утверждения — со ссылкой `путь:функция:строки`; там, где поведение зависит от браузера или от стоимости шага, это сказано прямо и помечено «не проверено».

Сокращения в ссылках: `boot.js` = `game/js/boot.js`, `play.js` = `game/js/play.js`, `net.js` = `game/js/net.js`, `hud.js` = `game/js/hud.js`, `menu.js` = `game/js/menu.js`, `lobby.js` = `game/js/lobby.js`, `session.js` = `mapgen2/js/session.js`, `villager.js` = `mapgen2/js/villager.js`, `combat.js` = `mapgen2/js/combat.js`, `events.js` = `mapgen2/js/events.js`, `app.js` = `mapgen2/js/app.js`, `render.js` = `mapgen2/js/render.js`. Номер строки без пути относится к последнему названному в абзаце файлу.

Область: `game/js/*.js`, `mapgen2/js/*.js`, клиентская часть сети. Серверные интервалы (`game/server/server.js`) в раздел не входят, кроме порога, который порождает клиентское событие `host-left`; он указан отдельно.

## 1. Короткая сводка

- В игре два независимых цикла: rAF-цикл кадра (`game/js/boot.js:loop:704-715`) и `setInterval(1000)` для скрытой/застрявшей вкладки (`game/js/boot.js:bindClock:624-628`). Оба зовут один и тот же `advance`.
- Мир идёт по стенным часам: `advance` считает `elapsed` от `Date.now()` и режет его на шаги не больше `SIM_STEP=0.05` с (`game/js/boot.js:advance:541-583`, `drain:519-537`).
- Догон ограничен стенным временем: 8 мс в видимой вкладке, 25 мс в скрытой; минимум один шаг делается всегда (`game/js/boot.js:drain:519-537`). Долг мира хранится в `simDebt` и ограничен `MAX_DEBT=120` с (`game/js/boot.js:advance:576-581`).
- Клиент сети мир не считает: `advance` отдаёт ему весь `elapsed` одним `P.tick(elapsed)` (`game/js/boot.js:advance:559-562`), а `Play.tick` в роли клиента только сглаживает позиции и считает тишину (`game/js/play.js:tick:1976-2003`).
- Сеть хоста шлёт снимки не по таймеру, а из шага мира: база `NET_INTERVAL=0.08` с, максимум `NET_INTERVAL_MAX=0.2` с, и только после ответа на предыдущий (`game/js/play.js:netSend:434-532`).
- Предела кадров `FPS_CAP` в коде нет. Есть `state.fpsCap`: 30 на `(pointer: coarse)` по умолчанию (`game/js/play.js:222-225`) и переключатель «экономия» (`game/js/hud.js:toggleEconomy:2489-2503`).

## 2. Константы времени

| Константа | Значение | Ссылка |
|---|---:|---|
| `SIM_STEP` | 0.05 с (максимальный шаг мира) | `game/js/boot.js:75` |
| `BUDGET_MS` | 8 мс стенных на догон в видимой вкладке | `game/js/boot.js:76` |
| `BUDGET_HIDDEN_MS` | 25 мс стенных на догон в скрытой | `game/js/boot.js:77` |
| `MAX_DEBT` | 120 с мира | `game/js/boot.js:78` |
| `JUMP_MS` | 5000 мс — предел тестовой ручки `__game.clock.jump` | `game/js/boot.js:79` |
| `STALL_MS` | 3000 мс без кадров | `game/js/boot.js:80` |
| `CHECKPOINT_MS` | 2000 мс стенных между контрольными точками | `game/js/play.js:84` |
| `EDIT_HOLD_MS` | 500 мс удержания ЛКМ (+ вторая задача 0 мс) | `game/js/play.js:80`, `game/js/play.js:holdStart:3059-3061` |
| `NET_INTERVAL` | 0.08 с | `game/js/play.js:46` |
| `NET_INTERVAL_MAX` | 0.2 с | `game/js/play.js:57` |
| `NET_SLOW_MS` / `NET_FAST_MS` | 420 мс / 170 мс (круг) | `game/js/play.js:58-59` |
| `NET_QUEUE_HIGH` / `NET_QUEUE_LOW` | 24576 Б / 4096 Б | `game/js/play.js:60-61` |
| `NET_SMOOTH` | 0.07 с | `game/js/play.js:62` |
| `NET_SILENCE` | 1.8 с тишины снимков | `game/js/play.js:64` |
| `BIRTH_EVERY` / `BIRTH_RETRY` | 30 с / 5 с игрового времени | `mapgen2/js/session.js:189,192` |
| `TRAIN_TIME` / `VANISH_TIME` / `EMERGE_TIME` | 5 с / 0.35 с / 0.5 с | `mapgen2/js/session.js:157-159` |
| `CHOP_TIME` / `TAKE_TIME` | 5 с / 1 с | `mapgen2/js/villager.js:163,196` |
| `REFRESH` / `HINTS_LIFE` / `GAIN_LIFE` | 0.12 с / 26 с / 950 мс | `game/js/hud.js:52,56,61` |

Пределы `net.js` (`game/js/net.js:35-48`): `request 8000`, `status 5000`, `resume 8000`, `start 10000`, `commandState 4000`, `ping 4000`, `snapshot 6000`, `snapshotPack 1500`, `commandSend 3000`, `commandResult 8000`, `pollMin 200`, `pollMax 1200` мс. Игра их не меняет; `Net.setLimits` вызывают только приёмки (`game/tools/http.js:121,145,305,341,382,414,426`).

## 3. rAF-цикл

`loop` ставит следующий кадр ПЕРВЫМ (`game/js/boot.js:loop:704-708`), затем зовёт `frame(t)` под внешним `try` (`709-714`). Поэтому исключение в кадре не обрывает цепочку rAF; оно уходит в `Play.noteFault(e, 'frame')`.

Порядок одного кадра (`game/js/boot.js:frame:717-743`):

1. `dt = min(0.05, (t - last)/1000) || 0`; `last=t`; `lastFrameAt=Date.now()` (`720-722`). `last` стартует с 0 (`game/js/boot.js:41`), поэтому первый кадр получает `dt=0.05`.
2. `guardFrame('keys', Play.stepKeys(dt))` (`725`).
3. Если мир не остановлен диагностикой (`!P.state.faulted`): `guardFrame('advance', advance(Date.now()))`, затем `guardFrame('draw', Play.draw(t/1000))` (`730-733`).
4. `guardFrame('hud', Hud.tick(dt))` (`737`).
5. `Metrics.frame(wallNow()-frameStart)` (`742`).

`guardFrame(label, fn)` (`game/js/boot.js:guardFrame:693-702`) ловит исключение, зовёт `Play.noteFault(e,label)`; `noteFault` по умолчанию делает ошибку фатальной и ставит `state.faulted=true` (`game/js/play.js:noteFault:1267-1283`). После этого следующие кадры не зовут ни `advance`, ни `draw`, но `Hud.tick` продолжает идти (`game/js/boot.js:730-737`). Ошибка в `advance` в том же кадре ещё успевает дойти до `draw`, потому что проверка `faulted` стоит до `advance`.

Кадр рисует `Play.draw(t/1000)` (`game/js/play.js:draw:2285-2293`): при `state.fpsCap>0` кадр пропускается, если с прошлой отрисовки меньше `1/cap`; вместе с миром рисуются оверлеи боя и войск (`2290-2292`). Мир и HUD от этой проверки не зависят.

## 4. Часы мира

Перед первой партией часов нет: `startClock` вызывается только после загрузки/возврата и сам заводит `simLast`, `simDebt`, `simDropped`, `lastFrameAt`, `bindClock()` и первый `loop(performance.now())` (`game/js/boot.js:startClock:638-645`; вызовы — `normalMenu:647-657`, `begin:659-685`). Время загрузки атласов в партию не входит.

`advance(now)` (`game/js/boot.js:541-583`) по веткам:

| Условие | Что делает |
|---|---|
| `!simLast` | ставит `simLast=now`, возвращает 0 (`542`) |
| `elapsed <= 0` | только переставляет `simLast`, долг не меняет (`544-547`) |
| нет `Play.state.world` | `simDebt=0`, возврат (`549-550`) |
| `P.state.faulted` | `simDebt=0`, возврат (`553`) |
| `netRole==='client'` | `P.tick(elapsed)` одним куском, возврат `elapsed`; долг клиента не касается (`559-562`) |
| `!P.state.running` | `simDebt=0`, один `P.tick(min(elapsed, SIM_STEP))`, возврат `elapsed` (`570-574`) |
| иначе | `simDebt += elapsed`; если больше 120 с — излишек в `dropTime`; `drain(document.hidden ? 25 : 8)` (`576-582`) |

`drain(budgetMs)` (`game/js/boot.js:519-537`):

- если `simDebt <= 1e-9` — 0;
- `step = min(simDebt, SIM_STEP)`; цикл `do...while`, то есть **минимум один шаг** выполняется всегда, даже если он тяжелее бюджета (`525-534`);
- бюджет проверяется ПОСЛЕ шага по `performance.now()` (`wallNow`, `499-502`), поэтому последний шаг может выйти за 25/8 мс на свою длительность;
- `simDebt -= step`, `simulated += step`, `Play.tick(step)`;
- остаток долга остаётся на следующий вызов.

Важное следствие: фактический `dt` шага — не всегда 0.05. В видимой вкладке при 60 к/с долг за кадр ≈0.0167 с, и `drain` обычно делает один шаг `0.0167`. `SIM_STEP=0.05` — верхняя граница, а не постоянный шаг. Хвостовой шаг тоже может быть меньше 0.05: `step = min(simDebt, SIM_STEP)`.

`dropTime(sec)` (`game/js/boot.js:506-514`) увеличивает `simDropped`, при `Metrics.on=true` — `Metrics.counters.dropped`, и зовёт `Play.noteSimDropped`, который шлёт событие `sim-dropped` и растит `Play.state.simDropped` (`game/js/play.js:noteSimDropped:990-994`). HUD показывает «мир пропустил N с» постоянной строкой, если потеряно больше 0.05 с (`game/js/hud.js:paintSimBadge:2425-2443`).

Таймер скрытой вкладки: `setInterval(..., 1000)` (`game/js/boot.js:bindClock:624-628`). Условие `if (!document.hidden && now - lastFrameAt < STALL_MS) return;` — в видимой вкладке с живыми кадрами таймер молчит, чтобы не считать время дважды. Он срабатывает, только если вкладка скрыта или кадров не было 3 с.

`catchUp()` (`game/js/boot.js:588-590`) — тот же `advance` под `guardFrame('catch-up')`. Его зовут все возвраты страницы (`bindClock:597-617`).

## 5. Все периодические вызовы

В `mapgen2/js` нет ни одного `setInterval`/`setTimeout`: единственный цикл там — rAF в `app.loop` (`mapgen2/js/app.js:876-896`), он описан в 9-м разделе.

### 5.1 Оболочка и интерфейс

| Цикл | Файл:строка | Период / условие | Что делает | Кто меняет во время игры |
|---|---|---|---|---|
| rAF-цикл | `game/js/boot.js:loop:704-715` | каждый кадр браузера | ставит следующий кадр, зовёт `frame` | браузер; цепочка стартует в `game/js/boot.js:startClock:644` |
| кадр мира | `game/js/boot.js:frame:717-743` | каждый rAF | keys → advance → draw → hud | `faulted` отключает advance/draw |
| таймер фона | `game/js/boot.js:bindClock:624-628` | 1000 мс; только hidden или нет кадров 3 с | `advance(now)` | `document.hidden`, `lastFrameAt` |
| HUD-обновление | `game/js/hud.js:tick:1053-1085` | каждый кадр; панели раз в `REFRESH=0.12` с кадрового времени | счётчики, журнал, панели, обзор | `dt` кадра; скрытый HUD (`class hidden`) не тикает |
| обзор | `game/js/hud.js:drawMinimap:2019-2080` | каждый HUD-тик, но перерисовка только при смене ключа (камера/жители/версия) | блит обзора | камера, жители, `minimapVersion` |
| скрытие загрузки | `game/js/boot.js:hideBoot:631-634` | 400 мс один раз | убирает экран загрузки | — |
| уход меню | `game/js/menu.js:leave:172-179` | 420 мс | скрывает меню после анимации | — |
| превью размеров | `game/js/menu.js:step:213-218` | 24 мс на карточку | рисует миниатюры по одной | очередь карточек |
| подтверждение копирования | `game/js/lobby.js:copyFromList:319-323` | 1200 мс | возвращает текст кнопки после «скопировано» | кнопка копирования |
| тост | `game/js/hud.js:toast:2517-2529` | `ms` (по умолчанию 2600) + 320 мс | всплывашка; в сети `netSilent()` её не создаёт | вызовы boot/hud |
| «+N» над лагерем | `game/js/hud.js:onDelivery:1988-2007` | 950 мс | удаляет DOM-цифру | сдача брёвен |
| вспышка траты | `game/js/hud.js:paintLogs:1126-1132` | 420 мс | снимает класс `spend` | покупка |
| удержание ЛКМ | `game/js/play.js:holdStart:3048-3146` | 500 мс, затем задача 0 мс | открывает правку/берёт дом | отпускание, сдвиг >18 px, blur, pointercancel |
| контрольная точка | `game/js/play.js:tick:2077-2080` | не чаще 2000 мс стенных | `captureCheckpoint()` | `state.faulted`; вызов только в шаге мира |

`Hud.tick(dt)` получает `dt` кадра (обрезан 0.05), поэтому `REFRESH`, `HINTS_LIFE` и анимации HUD идут по кадровому времени, а не по стенному. При 10 к/с `dt` обрезан до 0.05, и 26 с подсказок в стенных секундах растягиваются.

### 5.2 Сеть

| Цикл | Файл:строка | Период / условие | Что делает | Кто меняет во время игры |
|---|---|---|---|---|
| опрос лобби | `game/js/lobby.js:startPolling:336-340` | `setInterval` 1500 мс, плюс немедленный `poll()` | `GET /api/status` (предел 5000 мс), рендер лобби; останавливается на старте/входе/закрытии | `startPolling` в create/join/open/resumeSaved; `stopPolling` в `enterGame:189-192`, `close:146-151`, по событию `start` (`82-86`) |
| адреса сервера | `game/js/lobby.js:poll:346-370` | в каждом poll, если информации нет/проверяется/старше 8000 мс | `GET /api/server` | `lastInfoAt`; `loadServerInfo:202-212` |
| опрос результатов команд | `game/js/net.js:schedulePump:141-145` | первый через `pollMin=200` мс; далее `pollEvery`, рост +150 до 1200 мс; ошибка +250 мс | `GET /api/command-state` (4000 мс), пока есть `pendingCmds` | `waitResult:270-280`; ответы; `clearPending:121-139` |
| дедлайн команды | `game/js/net.js:pumpResults:183-192` | 8000 мс от `pc.at` | снимает ожидание с ошибкой `timeout` | `LIMITS.commandResult` |
| запрос с таймаутом | `game/js/net.js:request:387-430` | `LIMITS` (по умолчанию 8000 мс) | `AbortController` + таймер на весь ответ, включая тело | только при наличии `AbortController` (`391-408`) |
| отправка команды | `game/js/net.js:command:690-781` | весь POST ≤3000 мс; попытка ≤ `max(700, min(2500, deadline-now+200))`; повтор через 120 мс, попыток 2 | очередь `cmdChain`, команда за командой | `LIMITS.commandSend`, `commandResult` |
| TTL команды у хоста | `game/js/play.js:ingestCommands:1824-1827` | серверный возраст >20000 мс | не выполняет, пишет `expired` | серверный `ageMs` |
| снимок хоста | `game/js/play.js:netSend:434-532` | `netAcc >= netEvery` (0.08…0.2 с) и не `netBusy` | `POST /api/snapshot` (6000 мс) | очередь `queue`, RTT, `netWake`, `netForce` |
| gzip снимка | `game/js/net.js:snapshot:852-875` | 1500 мс на упаковку | при таймауте кадр не уходит, ошибка снимает busy | `LIMITS.snapshotPack` |
| пробуждение по команде | `game/js/play.js:wakeForCommand:803-815` | 120 мс, если снимок уже в пути | force-снимок после ответа | SSE `command`/`command-ready` |
| heartbeat хоста | `game/js/play.js:tick:2021-2029` | 2500 мс, проверка в шаге мира | `GET /api/ping` (4000 мс) | `netPingAt`, `netPingBusy` |
| пинг клиента | `game/js/play.js:tick:1988-2002` | 2000 мс, только видимая вкладка | `GET /api/ping`, событие `net-ping` | `netPingAt`, `netPingBusy` |
| ожидание Resource Timing | `game/js/net.js:ping:1041-1048` | 12 попыток × 60 мс | ждёт сетевую запись, иначе `wall` | `resourceRtt:959-996` |
| диагностика сервера | `game/js/play.js:tick:2033-2041` | 10000 мс, только хост | `GET /api/diag` (5000 мс, `game/js/net.js:1062`) | `serverDiagAt` |
| буфер Resource Timing | `game/js/net.js:932-936` | один раз | размер буфера 4096 | — |

`netEvery` меняется в `pace` (`game/js/play.js:480-492`): `queue > 24 КБ` → +0.04 с (до 0.2); иначе `rtt > 420 мс` → +0.02; иначе `rtt < 170 мс` и (`queue < 4 КБ` или очередь неизвестна, `q < 0`) → −0.01 (до 0.08). `netWake` сбрасывает `netEvery=0.08` (`game/js/play.js:netWake:426-429`). `stopNet` и `startNet` возвращают 0.08 (`game/js/play.js:stopNet:401`, `game/js/play.js:startNet:731`).

### 5.3 Внутри шага мира (по `dt`, не по таймеру)

| Правило | Файл:строка | Период / условие | Что делает |
|---|---|---|---|
| пересбор дружины | `mapgen2/js/session.js:stepVillagers:1954-1958` | накопленный `dt >= 1` с, затем сброс в 0 | `rebalanceGarrison` |
| рождение | `mapgen2/js/session.js:birthDue:226-245` | граница 30 с игрового времени; отложенная попытка через 5 с | `tryBirth` из `game/js/play.js:tick:2107-2110` |
| тренировка | `mapgen2/js/session.js:157`; `mapgen2/js/villager.js:startTraining:2873-2885`, `3032-3033` | 5 с с момента захода в казарму | `trainT -= dt`, затем `finishTraining` |
| рубка | `mapgen2/js/villager.js:163-165` | 5 с = 8 ударов | `chopT`, на восьмом ударе дерево падает (`mapgen2/js/villager.js:2467`) |
| бой: цель | `mapgen2/js/combat.js:782-785` | `think` 0.2 с + `(id % 7)*0.01` | выбор цели |
| бой: удар | `mapgen2/js/combat.js:835-837` | по юниту 0.8 с, по зданию 1.5 с; первый удар не раньше `windup=0.35` с | урон |
| полоса HP | `mapgen2/js/combat.js:53`, `mapgen2/js/combat.js:691` | 5 с после удара (`hpUntil`) | видимость полосы |
| журнал атак/роста | `mapgen2/js/events.js:27-28` | 8 с / 30 с на владельца | троттлинг событий |
| метка угрозы | `game/js/hud.js:98` | 10 с игрового времени | гаснет на обзоре |

Все эти числа — константы движка; в игре их никто не меняет. `Session.stepVillagers` не имеет собственного таймера: он делает ровно то, что успели накопить `dt` (`mapgen2/js/session.js:1940-1988`).

## 6. Жизненный цикл страницы

`bindClock` (`game/js/boot.js:597-629`) регистрирует:

| Событие | Ссылка | Что зовёт | Мир | Сеть |
|---|---|---|---|---|
| `visibilitychange` | `game/js/boot.js:bindClock:598-602` | `catchUp()`; если `!hidden` — `Play.checkCache()` и `Play.netWake()` | догон с бюджетом по `document.hidden`; проверка/перерисовка кэша земли | при возврате в видимую — хост: `netEvery=0.08` |
| `focus` | `game/js/boot.js:bindClock:603-606` | `catchUp()` + `netWake()` | догон | сброс частоты хоста |
| `blur` | `game/js/boot.js:bindClock:607` | только `catchUp()` | догон; бюджет 8 мс, если вкладка видима | не меняет |
| `pageshow` | `game/js/boot.js:bindClock:608-612` | `catchUp()` + `checkCache()` + `netWake()` | догон | сброс частоты |
| `freeze` (Page Lifecycle) | `game/js/boot.js:bindClock:617` | только `catchUp()` | догон | не меняет |
| `resume` (Page Lifecycle) | `game/js/boot.js:bindClock:613-616` | `catchUp()` + `netWake()` | догон; `checkCache` здесь не зовётся | сброс частоты |

`Play.bindInput` добавляет свои обработчики (`game/js/play.js:4109-4178`); дальше в этом абзаце строки без пути — `game/js/play.js`. `blur`, `pagehide` и `visibilitychange` при `hidden` зовут `dropPointer` (`4157-4162`) — это отменяет удержание/сбрасывает указатели и, если дом ведут и `isPlaying()`, **ставит** его (`editAction('place')`, `4153`), а не отменяет. `pointercancel` и `lostpointercapture` наоборот отменяют правку (`4112-4131`). `orientationchange` и `screen.orientation.change` зовут `dropGesture`, которая отменяет перенос (`4166-4178`). `window.blur` также чистит клавиши (`4247`).

События `pause` в коде нет: ни `game/js`, ни `mapgen2/js` не регистрируют `pause`; есть только `freeze`/`resume`. `pagehide` есть только в `play.js`, в `boot.js` его нет.

## 7. Клиент сети: как тикает и что считается потерей связи

Тик клиента — тот же `advance`, но особая ветка: `P.tick(elapsed)` одним куском и без `simDebt` (`game/js/boot.js:559-562`). В `Play.tick` ветка клиента стоит ДО проверок `running`/`faulted` мира и возвращается на `2003`, поэтому камеру, диораму и `Session.stepVillagers` клиент не считает (`game/js/play.js:1976-2003`).

В ветке клиента (строки без пути в списке — `game/js/play.js:tick`, если не указано иное):

- `state.seconds = state.world.time` — часы берутся из снимка (`1977`);
- `state.netLastTick = nowMs()` (`1978`);
- `netSmoothVillagers(dt)` — экспоненциальное сглаживание с `NET_SMOOTH=0.07` (`1979`, `netSmoothVillagers:1179-1193`);
- `state.netSilence += dt` (`1980`);
- если вкладка видима, хост не помечен ушедшим и ещё не `stale`, то при `netSilence > 1.8` ставится `netStale=true` и шлётся `net-stale` (`1981-1985`);
- раз в 2 с — `Net.ping()` (`1988-2002`).

`netSilence` сбрасывается только при применении снимка (`game/js/play.js:applySnapshot:1131`), при `host-back` (`onHostBack:908`) и при старте/остановке сети (`736-737`, `404-405`). Таймера «снимок не пришёл» нет: тишина проверяется только в тиках клиента.

Что считается «связь пропала»:

- **`net-stale`** — 1.8 с накопленного `dt` без снимка, при видимой вкладке; мир при этом продолжает стоять на последнем снимке, `running` не выключается. В HUD это бейдж «нет связи» (`game/js/hud.js:setNetPing:867-884`); тост `net-stale` в сети подавлен, потому что `Hud.toast` при `netRole` возвращается сразу (`game/js/hud.js:netSilent:2512-2518`).
- **`host-left` / `state.netHostGone`** — отдельное событие от сервера; `onHostLeft` ставит `running=false` (`game/js/play.js:893-903`). Порог сервера — `HOST_GRACE=60000` мс (`game/server/server.js:414`), в разделе не разбирается. `onHostBack` снимает `hostGone`, обнуляет `netSilence`/`netStale` и возвращает `running` для `play`/`paused` (`905-920`).
- SSE-ошибка сама по себе не ставит `netStale`: `Net.onerror` только помечает `online=false` и шлёт `net-error` (`game/js/net.js:517-521`); в игре это событие `net-trouble` (`game/js/play.js:838-840`). Но снимки идут по SSE, поэтому мёртвый поток приводит к тишине снимков и к `netStale` через 1.8 с.
- Ошибка POST снимка у хоста не показывается игроку: она пишется в диагностику `snapshot-error` (`game/js/play.js:522-530`); у хоста нет `netStale`.

Снимок применяется только при `seq > netSeq` и совпадении сида (`game/js/play.js:applySnapshot:1077-1085`). Сглаживание включается только если вкладка видима и прошлый тик был меньше 300 мс назад (`1093-1097`); в скрытой вкладке позиция ставится сразу. `netSeq` стартует из `payload.lastSeq`, после F5 продолжается (`729`).

Хост шлёт один снимок в полёте: `netBusy` ставится до `Net.snapshot` и снимается в `.then/.catch` (`434-438`, `493-530`). Поэтому в скрытой вкладке, где все шаги одного `drain` идут синхронно, второй `netSend` внутри того же `drain` видит `netBusy=true` и не уходит; фактическая частота снимков в фоне определяется частотой пробуждения таймера, а не 12.5 Гц (не считая force-снимка после применённых команд, `515-520`).

## 8. FPS и DPR

`FPS_CAP` как символа в коде нет. Предел — поле `state.fpsCap`, которое читает `Play.draw` (`game/js/play.js:2285-2293`), и аргумент `Play.setFpsCap(n)` (`2296-2300`), который ставит `state.fpsCap = n>0 ? n : 0` и сбрасывает `lastDrawAt=-1`.

- По умолчанию: на `(pointer: coarse)` — 30, иначе поле не задано и `draw` рисует каждый rAF (`game/js/play.js:222-225`, `2287-2288`).
- Кнопка «экономия»: `Play.setFpsCap(economy ? 30 : 0)`, `renderer.setQuality(economy ? 0.6 : 1, economy ? 1.5 : (touchUI()?2:3))` (`game/js/hud.js:toggleEconomy:2489-2503`). Выключение экономии ставит `fpsCap=0`, то есть снимает и телефонный предел 30, если он был; `economy` не сохраняется между загрузками (объявлен `false` в `game/js/hud.js:113`).
- Предел действует только на `Play.draw`; `advance`, `Hud.tick`, `stepKeys` и сеть идут с частотой rAF (`game/js/boot.js:725-737`). При 30 к/с мир не замедляется, потому что время считается по стенным часам.

DPR:

- `Renderer` хранит `dprCap`: 2 на `(pointer: coarse)`, иначе 3 (`mapgen2/js/render.js:145-153,175-181`).
- `Renderer.resize` берёт `devicePixelRatio`, зажимает его `dprCap` и задаёт размер полотна `cssW*dpr × cssH*dpr` (`mapgen2/js/render.js:1077-1090`). Вызывается на старте (`game/js/play.js:init:298-310`) и по `window.resize` (`game/js/boot.js:378`; `mapgen2/js/app.js:898-901`). Отдельного слушателя смены DPR нет: без события `resize` полотно не пересчитывается.
- `Renderer.setQuality(quality, dprCap)` меняет `dprCap` и сразу зовёт `resize` (`mapgen2/js/render.js:1110-1116`).
- Обзор HUD: `mmDpr = min(devicePixelRatio, 2)` один раз в `Hud.init` (`game/js/hud.js:231`), `MM=192` (`49`); экономия на `mmDpr` не влияет.

В генераторе карт своего предела FPS нет: `app.js` каждый rAF делает `needFrame=true` при наличии мира и рендерит (`mapgen2/js/app.js:876-896`). `dprCap` там тот же рендеровский.

## 9. Timestep симуляции и зависимость от кадров

`Session.stepVillagers` зовут ровно две точки:

1. Игра: `Play.tick(dt)` → `Session.stepVillagers(..., dt, ...)` (`game/js/play.js:2113`). В `Play.tick` этот вызов стоит после `state.seconds += dt` (`2074`), контрольной точки (`2077-2080`), `Combat.tick` (`2089-2098`) и проверки рождения (`2107-2110`), и только если `state.running && !state.faulted` (`2069-2073`).
2. Генератор: `app.loop` → `stepVillagers(dt)` → `Session.stepVillagers` (`mapgen2/js/app.js:loop:876-896`, `stepVillagers:82-94`).

`dt` в игре приходит из `advance`/`drain`: `step = min(simDebt, 0.05)` (`game/js/boot.js:526`). В видимой вкладке при 60 к/с это обычно ~0.0167 с; при скрытой — пачки по 0.05 с; хвост может быть меньше 0.05. В генераторе `dt = min(0.05, (t-last)/1000) || 0` (`mapgen2/js/app.js:877`), то есть кадровый, без догона по стенным часам.

Зависимость мира от частоты кадров:

- Суммарное игровое время в игре следует стенным часам: `elapsed` берётся из `Date.now`, а не из числа кадров (`game/js/boot.js:541-547,576`). После боя и до первой партии время стоит по флагу `running` (`570-574`).
- Размер и число шагов зависят от кадров и бюджета. Поэтому всё, что накапливает `dt`, идёт по времени, а всё, что считается «раз в шаг», получает разное число вызовов на секунду. Пример по коду: бюджет поиска пути выдаётся один раз на шаг (`mapgen2/js/villager.js:beginFrame:284-303`; вызов `mapgen2/js/session.js:1961`), а пересбор дружины проверяется накоплением `dt` (`mapgen2/js/session.js:1954-1958`).
- `state.seconds` и `world.time` в игре растут на один и тот же `dt` в одном шаге: `seconds += dt` (`game/js/play.js:2074`), `world.time += dt` — в `Combat.tick` (`mapgen2/js/combat.js:735`). `Combat.tick` вызывается только при `running` и не при `faulted`.
- У клиента мира нет: `state.seconds` приходит из снимка (`game/js/play.js:1977`), `Session.stepVillagers` не вызывается.
- В генераторе мир полностью кадровый: скрытая вкладка не получает rAF, догона по стенным часам там нет; мир стоит, пока кадры не вернутся. Это отличается от игры, где для этого есть таймер и `simDebt`.

## 10. Что происходит в скрытой вкладке — по коду

В пунктах 1-4 и 8 строки без пути — `game/js/boot.js`, если не указано иное.

1. rAF-кадры в скрытой вкладке не приходят; на этом построен таймер (`game/js/boot.js:619-623`). `lastFrameAt` перестаёт обновляться. Поведение браузера в разделе не замерялось.
2. `setInterval(1000)` продолжает срабатывать; проверка `!document.hidden && now-lastFrameAt < 3000` даёт `false` при `hidden=true`, поэтому каждый тик идёт `advance(now)` (`624-628`).
3. `advance` берёт `elapsed = (now - simLast)/1000`. `simLast` обновлялся на прошлом тике, поэтому при нормальном секундном таймере `elapsed ≈ 1 с`. Долг: `simDebt += 1` (`game/js/boot.js:advance:576`).
4. `document.hidden=true` → `drain(25)` (`game/js/boot.js:advance:582`). Бюджет — СТЕННЫЕ 25 мс, а не 25 мс мира.
5. `drain` делает шаги `min(simDebt, 0.05)`: сначала 0.05, пока долг не кончится или пока стенные часы не покажут 25 мс. Минимум один шаг гарантирован (`game/js/boot.js:525-534`). У хоста/одиночной при `running` каждый шаг — `Play.tick(шаг)`, обычно 0.05 (хвост может быть меньше): `seconds += шаг` (`game/js/play.js:2074`), `world.time += шаг` (в `Combat.tick`, `mapgen2/js/combat.js:735`), бой, рождение по границе 30 с, `Session.stepVillagers`.
6. Контрольная точка снимается не чаще, чем раз в 2000 мс стенных (`game/js/play.js:2077-2080`), поэтому пачка шагов не сериализует мир на каждом шаге.
7. Сеть хоста живёт в том же `Play.tick` до проверки `running` (`game/js/play.js:2009-2042`): `netAcc += 0.05` за шаг, `netSend` при накоплении; но `netBusy` не даёт отправить второй снимок внутри одного синхронного `drain`. Heartbeat 2.5 с и диагностика 10 с проверяются там же.
8. Остаток долга остаётся в `simDebt` и ждёт следующего тика. Если `simDebt` превысил 120 с, излишек выбрасывается и показывается словами (`game/js/boot.js:advance:577-581`, `game/js/boot.js:dropTime:506-514`).
9. Клиент в скрытой вкладке: `advance` зовёт `P.tick(elapsed)` одним куском (`game/js/boot.js:559-562`); мир не считается, сглаживание выполняется, но кадров для отрисовки нет, `netSilence` растёт на `elapsed`, а проверка `net-stale` пропускается, пока `document.hidden` (`game/js/play.js:1981`). Пинг клиента в скрытой вкладке не шлётся (`game/js/play.js:1989`).
10. Если `state.running=false` (до первой партии или после боя), `advance` обнуляет долг и делает один `P.tick(min(elapsed, 0.05))` (`game/js/boot.js:570-574`): мир не идёт, но хост продолжает слать снимки/heartbeat. Если `faulted`, `advance` сразу обнуляет долг (`game/js/boot.js:553`).
11. Возврат вкладки: `visibilitychange` зовёт `catchUp`; при `document.hidden=false` бюджет уже 8 мс, а не 25 (`game/js/boot.js:582`). Затем `checkCache` и `netWake` (`game/js/boot.js:598-602`); `focus`/`pageshow`/`resume` могут дать ещё вызовы `catchUp`, но между ними `simLast` уже сдвинут, и второй вызов получает почти нулевой `elapsed`. Остаток долга догоняется кадрами по 8 мс на вызов.
12. Заморозка страницы: обработчик `freeze` делает один `catchUp` (`game/js/boot.js:617`), после разморозки `resume` — ещё один плюс `netWake` (`game/js/boot.js:613-616`). Если между ними прошло много времени, `elapsed` большой, но в `simDebt` останется не больше 120 с; остальное будет выброшено.
13. Опрос лобби и опрос результатов команд не смотрят на `document.hidden` (`game/js/lobby.js:poll:346-370`, `game/js/net.js:schedulePump:141-145`): пока экран лобби открыт, его `setInterval` продолжает ставиться, а опрос команд ставит `setTimeout`; редеет их только браузер. В разделе это не замерялось.

### Сколько мира даёт один вызов `drain(25)` при долге 1 с

Долг ровно 1.000 с — это 20 полных шагов по 0.05 с. `drain` делает `N` шагов, где `N` ограничено и долгом, и стенным бюджетом. При постоянной стоимости шага `c` мс число шагов по коду: `N = min(ceil(D/0.05), max(1, ceil(25 / c)))`, где `D` — долг в секундах; для `D=1.000` это `N = min(20, max(1, ceil(25/c)))`. Цикл проверяет `wallNow()-started < 25` ПОСЛЕ шага (`game/js/boot.js:525-534`), а первый шаг гарантирован. Мир за вызов: `0.05 * N` секунд. Если `elapsed` чуть больше 1.000 с, к 20 полным шагам добавится хвостовой шаг размером с остаток, и мир догонит ровно `elapsed`.

- `c <= 1.25` мс → `N=20`, мир +1.00 с (весь секундный долг).
- `c = 9.96` мс (число из комментария к коду `game/js/boot.js:69-70`, не замер этого раздела) → `ceil(25/9.96)=3`, мир +0.15 с.
- `c >= 25` мс → `N=1`, мир +0.05 с; остальные 0.95 с остаются в долге.

Отсюда ответ на вопрос «25 мс бюджета и 50 мс шага»: **считать `25/50 = 0.5` нельзя** — 25 мс это стенный бюджет, 50 мс это шаг МИРА (0.05 с). Даже если бы 25 было временем мира, `25/50 = 0.5` шага, и минимум один шаг дал бы 0.05 с, а не 0.5 с. Если старого долга не было, за 1 секунду стенных часов скрытая вкладка может посчитать от **0.05 с** (гарантированный один шаг) до **1.00 с** мира (все 20 шагов), а точное число зависит от стоимости шага `c`; без замера `c` оно не проверено. Полный догон за один вызов возможен только при среднем шаге не дороже 1.25 мс. При старом долге за ту же секунду можно прогнать и больше 1 с мира: предел вызова — 25 мс стенных, а не 1 с мира, поэтому число шагов ограничено долгом (`ceil(D/0.05)`), а не секундой.

Если `N < 20`, долг растёт на `(20-N)*0.05` с за каждую секунду фона. При `N=1` это +0.95 с/с, и `MAX_DEBT=120` достигается примерно за 126 с фона; после этого каждый новый вызов начинает выбрасывать излишек. При таймере «раз в минуту» (комментарий `game/js/boot.js:51-52`; браузерное поведение не замерялось) за вызов приходит 60 с долга, а мир за минуту получает `0.05*N` секунд, то есть меньше 60 с при любом `N < 1200`.

## 11. Что не проверено

- Фактическая стоимость одного шага `Play.tick` на карте 192 и 200 существах: в разделе не замерялась. Числа 9.96 мс/8 мс взяты из комментария `game/js/boot.js:69-70` и использованы только как иллюстрация.
- Точные моменты и частота пробуждения `setInterval` в скрытой/глубоко фоновой вкладке: код рассчитывает на 1 раз в секунду и 1 раз в минуту (`game/js/boot.js:50-55`, `619-623`), но браузер в разделе не измерялся.
- Порядок доставки `visibilitychange`/`focus`/`pageshow`/`resume` при возврате: обработчики идемпотентны по `simLast`, но фактический порядок событий в браузере не проверялся.
- Поведение `freeze`/`resume` Page Lifecycle в конкретном браузере: обработчики зарегистрированы, факт доставки не проверен.
- Серверные интервалы (`game/server/server.js`) и `HOST_GRACE` в этом разделе не разбирались; приведён только порог, порождающий `host-left`.
