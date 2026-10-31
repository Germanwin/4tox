# Аудит №08 — сетевой клиент и его стык с игрой

Коммит `610db26`, браузерная версия (`game/`, `mapgen2/`). Читаны целиком:
`game/js/net.js`, `snapshot-buffer.js`, `server-clock.js`, `pending.js`,
`lobby.js`, `game/shared/net-config.js`; в `play.js` — `startServerNet`,
`applyServerSnapshot`, `applyServerBaseline`, `presentNet`, `startNet`
(legacy), `netSend`, `restoreFromSnapshot`, `normalizeResumedVillagers`,
`ingestCommands`; в `boot.js` — `advance`/`drain`/`bindClock`/`begin`. Сервер
(`game/server/*`) читался только как контракт для стыка. Ничего в репозитории
не менял; проверки — node-скриптами в `/tmp`.

## Сводка

Три настоящие поломки, две из них видны игроку сразу.

1. **Часы рендера сломаны на всём протоколе 4 (blocker).** Сервер отдаёт
   `serverGeneratedAtMs` из `performance.now()` комнаты (время жизни
   процесса), а `s1/s2` в `/api/ping` — из `process.hrtime()` (время с
   загрузки машины). Клиент складывает их в один offset, и `renderTime`
   уезжает вперёд на всё время аптайма сервера: живой замер — **+4,42 суток**
   (381 738 684 мс). Следствие: интерполяции нет вовсе (все позы `held`,
   12 ступенек в секунду), `state.netStale` навсегда `true` (бейдж «нет
   связи» при живой связи), часы партии показывают 6379 минут. Приёмка
   `mp.js` про часы не проверяет ничего, кроме наличия объектов.
2. **Одна потерянная POST-команда навсегда убивает все команды (critical).**
   На `sequence_gap` клиент откатывает `clientSeq` на единицу, а не на
   серверный `nextClientSequence`; счётчик и сервер расходятся навсегда —
   каждая следующая команда получает 409, и так по кругу. Живой замер: три
   попытки подряд → 409 `sequence_gap`, `next=1`, клиент каждый раз
   возвращается к `seq=2`.
3. **Смена epoch без доехавшего baseline навсегда замораживает клиента
   (major).** `SnapshotBuffer.push` выбрасывает снимок нового epoch без флага
   `baseline`, а сервер как раз умеет **дропать** снимки медленному потоку
   (`{drop:true}`); второго baseline в потоке не будет и попытки
   перезапросить его у клиента нет.

Плюс два мелких дефекта вокруг stale-состояния (маскировка события и
отсутствие «связь вернулась» в v4).

## Находки

### BUG-08-01 · Часы рендера протокола 4 считаются по двум разным нулям · blocker

- Файл: `game/js/server-clock.js:36-39`, `:93-96`, `:123-125`;
  `game/js/play.js:986-992`, `:950-960`, `:973`;
  `game/js/snapshot-buffer.js:192-207`; стык:
  `game/server/server.js:536-538`, `:2491-2492`,
  `game/server/room-runtime.js:16-19`, `:491`; бейдж:
  `game/js/hud.js:868-882`; часы партии: `game/js/play.js:4868-4872`.

- Что происходит. Клиент считает `offset = ((s1-c0)+(s2-c3))/2`, где `s1/s2`
  — ответ `/api/ping`, а потом строит
  `simTime = simulationTimeMs + (clientNow + offset - serverGeneratedAtMs)`.
  Формула верна только если `serverGeneratedAtMs` и `s1/s2` живут на одной
  оси. Они не живут:

  ```js
  // game/server/server.js:536
  function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }  // с загрузки машины
  // game/server/room-runtime.js:16
  function nowDefault() { return performance.now(); }                       // с старта процесса
  // game/server/room-runtime.js:491
  serverGeneratedAtMs: Math.round(this.clock.now())
  ```

  Ожидалось: `renderTime` на 150 мс позади `simulationTimeMs`, позы жителей
  интерполируются по `motion`. Фактически: `renderTime` на аптайм сервера
  впереди. Живой замер на настоящем сервере (`/tmp/clockprobe.js`,
  `node game/server/server.js --local`, полный цикл лобби→старт):

  ```
  baseline.serverGeneratedAtMs = 494
  ping.serverReceiveAtMs       = 381739178
  РАЗНИЦА баз (s1 - serverGeneratedAtMs) = 381738684 мс = 6362.31 мин
  ```

  Прогон этих чисел через настоящие `server-clock.js` +
  `snapshot-buffer.js` (`/tmp/renderprobe.js`):

  ```
  offset, мс        = 381738178
  renderTime, мс    = 381740544 = 106.04 ч
  stale             = true  mode= running
  pose              = {"x":1.1,...,"mode":"held","underflow":true,"stale":true}
  state.seconds станет = 381741 с ≈ 4.42 суток
  ```

  Что это значит по частям:
  * `SnapshotBuffer.pose`: `renderTime > last.t` и `renderTime > safe`
    (safeExtrapolationTo — в шкале симуляции) → ветка `'held'`
    (`snapshot-buffer.js:207`). Жители двигаются рывками по 12 раз в секунду,
    ломаная `motion` (единственное, ради чего буфер существует) не
    используется никогда;
  * `ServerClock.renderTime:123-125`: `age` = `clientNow - (serverGenerated —
    offset)` ≈ +4,4 суток → `stale:true` **всегда**. `presentNet` пишет это в
    `state.netStale` (`play.js:960`), а `Hud.setNetPing` по этому флагу каждые
    2 с ставит бейдж **«нет связи»** (`hud.js:872-880`) — при полностью живой
    связи. При этом настоящее пропадание связи этот индикатор уже не
    отличает: флаг и так всегда `true`;
  * `play.js:973` (`if (t/1000 > state.seconds) state.seconds = t/1000`) —
    часы партии показывают 381741 с, то есть «6379 мин 01 с» в меню паузы
    (`timeText`), а `state.seconds` уходит в экспорт диагностики;
  * `stale:true` в позе включает `p.stale`, но главное — `state.netStale`
    глушит штатное событие `net-stale` (`play.js:975`: условие
    `!state.netStale`), то есть тост «Связь с хостом пропала — ждём» не
    появится никогда;
  * `animOf` (`snapshot-buffer.js:138-151`) считает фазу от `renderTime`
    тоже в этой сдвинутой шкале: у не-зацикленных анимаций (`loop:false`)
    фаза прижата к 1, то есть последний кадр.

  Почему это не заметили: приёмка `game/tools/mp.js` проверяет только
  наличие `SnapshotBuffer`/`ServerClock` в окне (`mp.js:139`) и что снимки
  идут; ни `renderTime`, ни `netStale`, ни поза жителей не проверяются.
  Документ `docs/MP_IMPLEMENTATION.md:137-145` прямо пишет «монотонный
  `hrtime`» рядом с `serverGeneratedAtMs`, не замечая, что это разные нули.

- Репро (роли: хост + гость; сеть обычная). Открыть лобби, начать партию,
  зайти гостем. Через ~2 с бейдж связи — «нет связи»; жители идут ступеньками
  ~12 шагов/с и замирают между снимками; меню паузы показывает время в
  тысячах минут. В консоли:
  `Play.state.netStale === true`, `Play.state.netRenderTime ≈ 3.8e8`,
  `Play.state.seconds ≈ 3.8e5`. На свежем сервере (аптайм 10 с) сдвиг всего
  10 с — интерполяция формально работает, но renderTime уже на 10 с впереди,
  а `stale` тоже `true` — то есть баг виден и сразу после запуска.

- Доказательство. Замер выше — вывод живого сервера, не рассуждение.
  Ключевые строки, которые не сходятся:

  ```js
  // client-side: всё это одна и та же "серверная монотонная" шкала
  offset  = ((s1 - c0) + (s2 - c3)) / 2;         // s1,s2 — hrtime
  simTime = simulationTimeMs + (c + offset - latest.serverGeneratedAtMs); // perf.now
  ```
  Приёмка НЕ ловит: `node game/tools/mp.js` про часы не спрашивает;
  `game/tools/http.js` грузит `net.js` со стабами, но `ServerClock`/буфер в
  нём не участвуют.

- Уверенность: высокая (живой замер + прогон модулей).

- Правка. Одна ось на сервере — обязательно:
  1. `game/server/server.js:536`: `monoMs()` → `performance.now()` (в Node
     main-thread и worker_threads `performance.now()` имеют один нуль — я
     проверил: main 15.19 мс, worker 30.43 мс при `hrtime` 381 388 011 мс).
     Либо, наоборот, `room-runtime.js` → `serverGeneratedAtMs` из
     `process.hrtime`; главное — один источник для `s1/s2` и
     `serverGeneratedAtMs`. `hrtime` в `monoMs` больше нигде не используется
     (проверено: только две строки ping), поэтому замена безопасна.
  2. Защита в клиенте, чтобы такая рассинхронизация не «молчала»:
     в `ServerClock.addSample` отбрасывать пробу, если
     `|offset| > MAX_SANE_OFFSET` (например 86 400 000 мс) или если
     вычисленный `simTime` отличается от `latest.simulationTimeMs` больше чем
     на 2 с; в `renderTime` при таком расхождении
     `simTime = latest.simulationTimeMs` (как в ветке «нет проб») и один раз
     `emit('net-note')`/`traceDiag('clock-skew')`.
  3. Приёмка: в `mp.js` добавить проверку `state.netRenderTime` попадает в
     `[simulationTimeMs-2000, simulationTimeMs+500]` и что `netStale` у
     живого клиента `false`; плюс `pose.mode !== 'held'` на движущемся
     жителе.

---

### BUG-08-02 · `sequence_gap` не лечится: одна потерянная команда гасит все следующие · critical

- Файл: `game/js/net.js:807-814` (выдача `seq`), `:827-851` (отправка и
  откат), `:864-869`; стык: `game/server/server.js:2773-2782`,
  `game/server/room-runtime.js:393-401`.

- Что происходит. `clientSequence` выдаётся ДО отправки
  (`var seq = ++clientSeq`, `net.js:812`). Если POST не дошёл (обрыв, таймаут
  `LIMITS.commandSend`, abort) — ответа нет, откат не выполняется, и
  `clientSeq` остаётся потраченным. Сервер же двигает свой
  `p.nextClientSequence` только на принятых командах. Дальше клиент шлёт
  `seq+1`, сервер отвечает `409 admitted:false code:'sequence_gap'
  nextClientSequence: seq`, клиент делает

  ```js
  // net.js:848-851
  if (clientSeq === seq) {
    clientSeq = Math.max(0, seq - 1);   // <-- на единицу, а не на next
    saveSession();
  }
  ```

  и следующая команда снова получает `++clientSeq` = тот же `seq`. Серверный
  `nextClientSequence` из тела ответа не читается вообще (он читается только
  в успешной ветке `:835-839` и в `waitCommandV4:782-786`, причём там синк
  **только вверх**: `if (j.nextClientSequence - 1 > clientSeq)`).

  Ожидалось: клиент доводит счётчик до серверного (`nextClientSequence - 1`)
  и повторяет; фактически расхождение на 1 становится вечным. F5 не лечит:
  `clientSeq` восстанавливается из `localStorage` (`net.js:353`) и остаётся
  тем же неверным; `resume()` не берёт `session.nextClientSequence`.

- Репро. Гость, сеть с обрывом: нажать «построить дом» в момент, когда POST
  `/api/command` не доходит (DevTools → Offline на 3 с, либо throttle с
  таймаутом). Команда уходит в `command-error`, дом в pending остаётся
  «результат уточняется». После возврата сети ЛЮБОЕ следующее действие
  (дом, найм, приказ, снос) отклоняется: в журнале «приказ не выполнен:
  sequence_gap». Повтор не помогает, F5 тоже.

- Доказательство. Живой прогон против настоящего сервера
  (`/tmp/seqprobe.js`, лобби на 2, старт, команда с завышенным номером —
  ровно то, что клиент шлёт после потери):

  ```
  instance = s0-b6589fc6  server next = 1
  seq 2 -> HTTP 409 code= sequence_gap admitted= false next= 1
     клиент откатился на 1 → следующая команда уйдёт с seq 2
  seq 2 -> HTTP 409 code= sequence_gap admitted= false next= 1
  seq 2 -> HTTP 409 code= sequence_gap admitted= false next= 1
  ```

  Приёмка НЕ ловит: `game/tools/http.js` проверяет повтор с ТЕМ ЖЕ `n` и
  дедуп, но не сценарий «номер потерян, следующий завышен»; `mp.js` играет
  без обрывов POST команд.

- Уверенность: высокая (живой 409 + арифметика клиента).

- Правка. В `net.js:845-862` в ветке `admitted === false`, если в теле есть
  число `nextClientSequence`, ставить
  `clientSeq = Math.max(0, e.body.nextClientSequence - 1)` (и для
  `sequence_gap`, и для `history_expired`); текущий откат на единицу оставить
  только как fallback. В `waitCommandV4` синкать в обе стороны
  (`clientSeq = nextClientSequence - 1`, если оно меньше). Приёмка: добавить
  в `game/tools/mp.js` (или `http.js`) сценарий «у команды украли seq» →
  следующая команда applied, а не 409.

---

### BUG-08-03 · Epoch сменился, baseline не доехал — клиент замерзает навсегда · major

- Файл: `game/js/snapshot-buffer.js:74-82`; `game/js/play.js:862-871`;
  стык: `game/server/server.js:2687` (`{drop:true}`),
  `game/server/room-runtime.js:155-178`, `:718-768`.

- Что происходит. При росте epoch буфер принимает снимок только с флагом
  `baseline`:

  ```js
  if (se > epoch) {
    if (!snap.baseline) return { accepted: false, reason: 'epoch_without_baseline' };
    clear(); epoch = se; reset = true;
  }
  ```

  `applyServerSnapshot` на `!accepted && !reset` выходит молча
  (`play.js:867`). Сервер после recover/restore поднимает epoch и публикует
  ровно один baseline-снимок (`room-runtime.js:176-178`, `:766`), но
  рассылка снимков идёт с `{ drop: true }` — при `writableLength > 256 КБ`
  сервер **выбрасывает** снимок (`server.js:2687`), а следующий за ним уже
  `baseline:false` (флаг снимается в `makeSnapshot`: `if (snap.baseline)
  this.baselinePending = false`). Клиент остаётся со старым epoch и
  отбрасывает ВСЕ последующие снимки; запроса «дай baseline заново» у него
  нет (`/api/resume` есть, но в игре его никто не зовёт). Мир замирает до F5.

  Ожидалось: пропуск снимка безопасен («следующий снимок абсолютный» —
  так и написано в `AGENTS.md`), но это верно только внутри одного epoch;
  на границе epoch пропуск единственного baseline — конец потока.

- Репро. Любая перезагрузка комнаты (fault → «Продолжить с контрольной
  точки», либо рестарт сервера с восстановлением из checkpoint) при
  медленном/забитом канале гостя: `queue > 256 КБ` на его потоке в момент
  публикации baseline → гость застывает, а хост и остальные живут. Ещё
  проще воспроизвести точечно: подменить SSE-событие baseline на обычный
  снимок нового epoch (в DevTools — нечего; в приёмке — выкинуть первое
  событие `snapshot` с `baseline:true` и следующим `epoch+1`).

- Доказательство. Порядок состояний буфера (модуль без стабов):

  ```
  push({epoch:2, baseline:true,  revision:100}) -> accepted:true, reset:true
  push({epoch:3,                revision:1})   -> epoch_without_baseline
  push({epoch:3,                revision:2})   -> epoch_without_baseline
  ... навсегда
  ```

  Приёмка НЕ ловит: `mp.js` не меняет epoch и не проверяет drop; сценарий
  recover в браузерной приёмке не играется.

- Уверенность: высокая по логике буфера; средняя по частоте (нужен дроп
  именно baseline-снимка).

- Правка. (1) Сервер: не дропать снимки с `baseline:true`
  (`server.js:2687` — передавать `drop: snap.baseline !== true`), это
  единственный кадр, потеря которого невосстановима. (2) Клиент: на
  `reason === 'epoch_without_baseline'` не молчать, а перезапросить базу —
  `Net.resume()` уже отдаёт `baseline: rec.latest` и текущий `start`
  (`server.js:2531-2534`), после чего `startServerNet` создаёт буфер с
  актуальным epoch и baseline примется. Пока этого нет — хотя бы
  `emit('net-note')` + бейдж, чтобы игрок знал, что нужен F5. Приёмка:
  выбросить baseline из потока и проверить, что клиент восстановился сам.

---

### BUG-08-04 · В v4 клиент навсегда «нет связи»: событие stale заглушено, а «связь вернулась» не приходит · minor

- Файл: `game/js/play.js:958-960`, `:974-978`; сравнить с legacy
  `play.js:1461-1469`; `game/js/boot.js:359-367`.

- Что происходит. В `presentNet` порядок такой: сначала
  `state.netStale = !!rt.stale`, потом проверка
  `if (state.netSilence > NET_SILENCE && !state.netStale)`. Если часы уже
  сказали `stale` (снимков нет > 500 мс), условие ложно и событие
  `net-stale` не испускается — нет ни тоста, ни `Hud.setNetPing(0,{stale})`.
  Обратной дороги тоже нет: `applyServerSnapshot` просто присваивает
  `state.netStale = false` (`play.js:879`), а аналога `emit({type:'net-ok'})`
  из legacy-ветки (`play.js:1462-1469`) в v4 нет. Бейдж чинится только
  следующим `net-ping` (до 2 с), а «Связь вернулась» не показывается вовсе.

  Ожидалось: пропажа и возврат обновлений видны игроку (правило 2026-10-24:
  в сети вместо всплывашек — бейдж, но он должен быть правдой). Фактически:
  бейдж врёт в обе стороны, а с BUG-08-01 — врёт постоянно.

- Репро. Заморозить вкладку сервера/сеть на 3 с: тоста нет, бейдж остаётся
  прежним до следующего пинга; после возврата — «Связь вернулась» не
  появляется (в 4-м протоколе).

- Доказательство.

  ```js
  state.netStale = !!rt.stale;                      // 960: уже true
  if (state.netSilence > NET_SILENCE && !state.netStale) {  // 975: не сработает
    state.netStale = true; emit({ type: 'net-stale' });
  }
  ```
  Приёмка НЕ ловит: `mp.js` держит связь живой; события stale/ok в ней не
  проверяются.

- Уверенность: высокая (чтение кода, порядок присваиваний очевиден).

- Правка. Запоминать прежний флаг и испускать переходы:
  `var was = state.netStale; state.netStale = !!rt.stale || silence > NET_SILENCE; if (state.netStale !== was) emit(state.netStale ? 'net-stale' : 'net-ok');`
  (`net-ok` уже обрабатывается в `boot.js:366`).

---

### BUG-08-05 · `Pending` держит резерв вечно, если результат команды потерян, а дом уже виден · minor

- Файл: `game/js/pending.js:263-296` (визуальное согласование без
  `finish`), `:159-168` (`reserved` считает все действия), `:100-103`
  (потолок 60); `game/js/play.js:3922-3935`, `:2559`.

- Что происходит. Если результат команды не пришёл, но постройка в снимке
  появилась, `reconcile` ставит `visualSettled = true` — и **не вызывает
  `finish`** (это нарочно, комментарий `:276-279`). Резерв при этом остаётся:
  `reserved()` суммирует `cost` всех `build`/`line` независимо от статуса.
  Дальше дом уже в `seenIds`, новых кандидатов нет, а `finish` может прийти
  только из точного результата. Итог: `availableLogs() = logs - reserved`
  навсегда меньше настоящего на цену этого дома («построено, а брёвен не
  прибавилось»), а после 60 таких ожиданий `add()` вообще отказывает в новых
  постройках без сообщения (`:100-103`).

  Насколько достижимо: сервер дублирует результаты в `snap.commandResults`
  до client ack (`room-runtime.js:497-521`), поэтому обычно действие
  закрывается следующим снимком. Дыра открывается, когда снимки идут (дом
  виден), а персональный блок результата до клиента не доехал или команда
  попала в `history_expired` — `Pending.result` для `history_expired` не
  предусматривает закрытия (`pending.js:226-237`: только `rejected`/
  `expired`), статус остаётся `unknown`.

- Репро. Гость строит дом; POST принят, но ответ на `waitCommandV4`
  потерян (>8 с недоступен `/api/command-state`), затем связь вернулась:
  дом в снимке, `Pending.status().unresolved = 1`, `reserved() = цена дома`,
  и он там остаётся.

- Доказательство.

  ```js
  if (cand.length === act.items.length) {
    act.visualSettled = true;              // 291: резерв НЕ снимается
    act.visualIds = cand.map(...);
    trace({kind:'visual-settled', ...});   // и finish() нет
  }
  ```
  Приёмка НЕ ловит: `mp.js` смотрит счётчик брёвен у гостя после УСПЕШНОЙ
  стройки; сценария «результат потерян» нет.

- Уверенность: средняя (путь редкий, но детерминированный; код читается
  однозначно).

- Правка. Добавить срок для ожиданий: в `reconcile`/`status` закрывать
  действие, у которого `visualSettled` и возраст > `LIMITS.commandResult +
  5000`, с записью в trace («согласовано по снимку, результат потерян»).
  Второй вариант — `Pending.result` для `history_expired` не оставлять
  `unknown`, а закрывать по видимому id/по возрасту.

## Проверено и НЕ баг

- **legacy `startNet` недостижим на протоколе 4** (`play.js:1002-1005`):
  сервер всегда кладёт `roomId` и `protocol: 4` в старт
  (`server.js:608-628`), а `/api/snapshot` для v4 отвечает 409
  (`server.js:2626-2633`); `netSend` и `ingestCommands` в v4 не работают
  (`play.js:448`, `:2134`). Старый путь остаётся только для сервера < 4 и
  ничего не ломает.
- **Токен в query-строке** (`/api/ping`, `/api/status`, `/api/resume`,
  `/api/command-state`, `/api/events`) — не утечка в логи: сервер пишет
  только путь без query (`server.js:2000`, `:2083`, `:2097`, `:2140`), а
  EventSource не умеет заголовки. В `localStorage` токен лежит по ключу
  вкладки (`net.js:296-318`) — две вкладки не затирают сессии, это
  проверяется приёмкой F5.
- **Гонка «SSE start без снимка после F5»** закрыта: `handleStart` при
  `resuming` кладёт старт в `pendingStart`, а `/api/resume` склеивает его с
  `baseline`/`snapshot` (`net.js:484`, `:658-681`).
- **Поздние ответы старой партии** не применяются: `generation`/`isCurrent`
  проверяются в `status`, `resume`, `command`, `command-state`, `snapshot`
  (`net.js:34`, `:212-215`, `:625`, `:770-771`, `:1002`, `:1063`).
- **Экстраполяция ограничена**: не больше 100 мс и только до
  `safeExtrapolationTo`, иначе `held` (`snapshot-buffer.js:192-207`);
  «резиновости» сверх этого нет (кроме BUG-08-01, где `held` — всегда).
- **Дыры в буфере внутри одного epoch безопасны**: снимки абсолютные,
  `revision` только растёт, старый/дубль отбрасывается
  (`snapshot-buffer.js:83-88`).
- **gzip снимка**: нет `CompressionStream` — уходит обычный JSON; ошибка
  упаковки не теряет кадр; таймаут упаковки снимает busy
  (`net.js:1021-1031`, `:1075-1121`).
- **`stopNet` и слушатели**: все подписки `Net.on` складываются в
  `state.netOff` и снимаются (`play.js:397-432`), `leave()` чистит
  `localStorage` (`net.js:1299-1305`), утечки EventSource нет — старый
  закрывается в `connect()` и `reset()`.
- **`Ping` берёт число из Resource Timing**, а не из `performance.now()`
  вокруг промиса (`net.js:1182-1219`, `:1244-1248`); индикатор `ms` честный,
  сломана только привязка часов (BUG-08-01).

## Не проверено

- Браузерные приёмки (`menu.js`, `mp.js`, `mapgen2/tools/game.js`) — по
  заданию их гоняет координатор; вывод «приёмка НЕ ловит» сделан по чтению
  кода проверок.
- Реальный дроп baseline на границе epoch в живом сервере: проверена логика
  буфера и наличие `{drop:true}` в рассылке, но не воспроизведён забитый
  канал (`writableLength > 256 КБ`) — нужен браузер/медленный клиент.
- Влияние BUG-08-01 на не-зацикленные анимации (`loop:false`) — по коду
  фаза прижимается к 1, но какие именно анимации не зациклены, я не
  разбирал (это зона агента по рендеру).
- Гонки `ready`/`start` в лобби при туннеле (`lobby.js:540-548`) — читал, но
  не воспроизводил задержки в секунды.
- Поведение при 500/битом JSON в `/api/command-state`: разбор ошибок есть
  (`net.js:238-271`), но старый сервер/404-ветка живой проверкой не
  покрыта.

## Топ-5

1. **BUG-08-01** (blocker) — часы рендера: `hrtime` против
   `performance.now`, `renderTime` +4,42 суток, интерполяции нет, «нет
   связи» навсегда, время партии в днях. Правится одной строкой на сервере
   плюс защитой в `ServerClock`.
2. **BUG-08-02** (critical) — потерянная POST-команда навсегда гасит все
   команды: откат `clientSeq` на единицу вместо серверного
   `nextClientSequence`; F5 не лечит.
3. **BUG-08-03** (major) — смена epoch без доехавшего baseline: снимки
   нового поколения отбрасываются вечно, мир замирает до F5; сервер к тому
   же умеет дропать именно этот кадр.
4. **BUG-08-05** (minor) — «визуально построено, ресурсов нет»: резерв
   `Pending` не снимается, если результат потерян, а дом уже виден;
   накапливается до отказа в новых постройках.
5. **BUG-08-04** (minor) — переходы stale/ok в v4 не испускаются: бейдж и
   тост не отражают ни пропажу, ни возврат обновлений.
