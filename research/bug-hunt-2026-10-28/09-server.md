# 09 · Сервер, комнаты, персистентность, статика, безопасность

Аудит браузерной версии (protocol 4), коммит `610db26`. Читались целиком
`game/server/server.js`, `room-runtime.js`, `room-worker.js`, `persistence.js`,
`tunnel.js`, `upnp.js`, `game/shared/net-config.js`, `docs/MP_IMPLEMENTATION.md`,
`game/server/README.md`, `game/js/net.js`/`lobby.js` (только для оценки
достижимости серверных путей). Тесты — свой `STATE_DIR` (`mktemp -d`), свой
порт 18787, `--local`; в репозиторий не писалось ничего, кроме этого отчёта.
Браузерные приёмки не запускались (их гоняет координатор).

## Сводка

Сервер в основном честно держит контракт «accept → fsync → 202» и
«tickCommit → fsync → committed»: тик 20/с держится (замер 19.8–20.1 tps),
SSE с gzip и `Z_SYNC_FLUSH` реально отдаёт кадры ровно по ~100 мс, F5 после
`kill -9` поднимает мир с последнего checkpoint (tick 62 → 64, epoch 1 → 2),
команда после resume принимается. Но найдены две дыры, отдающие наружу чужие
данные (обход статики и `lobby.json` с токенами внутри `/game/`), один
блокирующий сценарий старта (два POST `/api/start` → два мира пишут один
журнал) и персистентность, которая после второго падения с оборванной
записью не поднимает комнату вообще.

Топ по важности: **09-03** (порча журнала/два мира), **09-01/09-02**
(утечка репозитория и токенов), **09-04** (комната мертва после второго
падения), **09-05/09-06** (DoS и вечно занятый слот комнаты).

## Находки

### BUG-09-01 · Обход статики через `%2e%2e`: наружу отдаётся весь репозиторий · critical
- Файл: `game/server/server.js:1998-2010` (`serveStatic`), `:1996`
  (`STATIC_ROOTS`), `:2295` (`new URL(req.url, …)` в `handleRequest`).
- Что происходит. `handleRequest` разбирает `req.url` через `new URL` — тот
  нормализует ТОЛЬКО литеральные `..`, а `serveStatic` затем декодирует
  **исходный** `req.url` (`:2000`) и проверяет префикс по декодированной
  строке (`:2004`). `%2e%2e`/`..%2f` в URL не нормализуются `new URL`, но
  декодируются в `..`; префикс `/game/` при этом на месте, а от выхода за
  ROOT защищает только `file.startsWith(ROOT + sep)` (`:2007-2010`) — то есть
  за пределы репозитория выйти нельзя, а **внутри репозитория можно читать
  что угодно**, хотя документация обещает обратное
  (`MP_IMPLEMENTATION.md:254-255`, `game/server/README.md:112-114`:
  «Наружу отдаются только `game/` и `mapgen2/`: корень репозитория (`.git`,
  документы, инструменты) по сети не ходит»).
- Репро (живой сервер, `--local`, порт 18787):
  ```
  GET /game/../AGENTS.md                 -> 404   (new URL нормализовал)
  GET /game/%2e%2e/AGENTS.md             -> 200   113323 B  "# 4tox — правила работы агента"
  GET /game/%2e%2e/.git/config           -> 200   467 B     "[core] … bare = false"
  GET /game/%2e%2e/.git/HEAD             -> 200   "ref: refs/heads/patch/4tox-stabilization"
  GET /mapgen2/%2e%2e/docs/DEPLOY.md     -> 200   8024 B
  GET /game/%2e%2e%2f..%2f..%2fetc/passwd-> 403   (граница ROOT держит)
  ```
- Доказательство:
  ```js
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]); // :2000
  if (!STATIC_ROOTS.some(r => urlPath.startsWith(r))) { 404; }     // :2004
  const file = path.resolve(ROOT, '.' + urlPath);                   // :2007 → ROOT/docs/…
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { 403; }  // :2008 — уже внутри ROOT
  ```
  Какая приёмка НЕ ловит: `mp-acceptance.js` проверяет 403/404 только для
  «обычных» путей (и `409 server_authoritative`), traversal-вектор там не
  фигурирует; `game/tools/http.js` — низкоуровневый клиент, нормализующий URL
  на своей стороне, так что `%2e%2e` через него не отправить.
- Уверенность: высокая (живой 200 с содержимым).
- Правка: нормализовать **после** декодирования и проверять результат, а не
  строку: `const rel = path.posix.normalize(decodeURIComponent(urlPath));
  if (rel.includes('\0') || rel.split('/').includes('..')) return 404;`
  затем `const file = path.join(ROOT, rel)` и сравнивать с
  `path.join(ROOT, 'game')` / `path.join(ROOT, 'mapgen2')` как каталогами
  (`file === dir || file.startsWith(dir + path.sep)`); предпочтительно —
  раздавать из отдельного web-root, где лежат только публичные файлы.

### BUG-09-02 · `lobby.json` с токенами игроков лежит внутри раздаваемого `/game/` · critical
- Файл: `game/server/server.js:530-532` (`STATE_DIR` по умолчанию
  `cwd/game/server/var/rooms`), `game/server/room-runtime.js:39-43`
  (`defaultDir`), `game/server/server.js:551-572` (`saveLobbyMeta`, токены в
  `:561`), `:1996` (`STATIC_ROOTS = ['/game/', '/mapgen2/']`).
- Что происходит. Каталог состояния по умолчанию — **внутри** раздаваемого
  `/game/`. `lobby.json` содержит `token` каждого игрока (это единственный
  credential: `playerByToken`, `:1481`), а `chmod 0600` на HTTP никак не
  влияет. Достаточно знать адрес игры (LAN/ Hamachi / `--tunnel` ссылка) и код
  комнаты (он же `roomId`, он виден в ссылке лобби) — токены читаются без
  всякой аутентификации. Документация прямо утверждает обратное
  (`MP_IMPLEMENTATION.md:254`: «`STATE_DIR` — env; файлы вне web-root, раздача
  статики их не видит»; `README.md:110-112`).
- Репро (сервер на своём порту; в репозитории уже лежат файлы предыдущего
  прогона координатора, поэтому писать ничего не пришлось):
  ```
  GET /game/server/var/rooms/KF2Y7/lobby.json -> 200
  { "code": "KF2Y7", …, "players": [
      {"id":0,"name":"Старый клиент","token":"9fa9…(36 hex)"},
      {"id":1,"name":"Напарник","token":"a566…"} ] }
  ```
  С этим токеном: `GET /api/events?code=…&token=…` (поток снимков и команд
  чужого игрока), `POST /api/command` с его `owner`, `GET /api/resume`
  (полный снимок мира), у хоста ещё `POST /api/start`, `GET /api/diag`,
  `POST /api/recover`.
- Доказательство:
  ```js
  const STATE_DIR = process.env.STATE_DIR ? path.resolve(...)
    : path.resolve(process.cwd(), 'game', 'server', 'var', 'rooms'); // :530
  ...
  const file = lobbyMetaPath(lobby.code);       // STATE_DIR/<code>/lobby.json
  fs.writeFileSync(file, JSON.stringify(meta…{token: p.token}…)); // :561
  ...
  const STATIC_ROOTS = ['/game/', '/mapgen2/']; // :1996 — а STATE_DIR внутри /game/
  ```
  Какая приёмка НЕ ловит: `mp-acceptance.js` поднимает сервер с временным
  `STATE_DIR` **вне** репозитория, поэтому утечки не видит; и она не проверяет
  статику на секреты вообще.
- Уверенность: высокая (файл реально отдан по HTTP).
- Правка: держать состояние вне web-root (например `<repo>/var/rooms` —
  каталог, которого нет в `STATIC_ROOTS`, или `os.tmpdir()/4tox-rooms`) и
  дополнительно запретить раздачу `/game/server/`, `/game/tools/` и любых
  `*.json`, кроме явного allowlist (атласы/конфиги). Плюс тест-приёмка:
  `GET /game/server/var/rooms/<code>/lobby.json` обязан быть 404, а токен в
  ответе статики — отсутствовать.

### BUG-09-03 · Двойной `POST /api/start` → два `init` в один worker, затем второй worker при живом первом: два мира пишут один журнал · blocker
- Файл: `game/server/server.js:788-849` (`startRoom`), `:672-783`
  (`createRoomWorker`), `:812-829` (init и «уборка» при ошибке),
  `game/server/room-worker.js:77-110` (`init` можно вызвать повторно),
  `game/server/room-runtime.js:144-207` (`start` пишет `room-start` и нулевой
  checkpoint), `game/js/lobby.js:429-437, 485-501` (у кнопки нет блокировки).
- Что происходит.
  1. `startRoom` проверяет «уже начали» по `lobby.started && lobby.startPayload`
     (`:789`), а оба поля выставляются только **после** `await` готовности
     worker'а (`:818-838`). Второй одновременный POST проходит ту же проверку.
  2. `createRoomWorker` на второй вызов возвращает существующую запись
     (`:673`), и `startRoom` **второй раз** отправляет `init` тому же worker'у
     (`:812`). В worker'е `init` не идемпотентен: `runtime = new RoomRuntime(…)`
     затирает первый рантайм (`room-worker.js:79`), а новый `runtime.start()`
     создаёт **второй мир**, пишет второй `control room-start` и второй
     нулевой checkpoint.
  3. Два `Persistence` с разными file handle пишут в один
     `journal-000001.log`; одновременные `writeCheckpoint` используют один и
     тот же `checkpoint-….tmp-<pid>` → один из рантаймов падает
     (`room_fault`), оба HTTP-старта получают 409.
  4. `startRoom` в catch удаляет `roomRecords[code]` (`:827`) и шлёт
     `shutdown` **последнему** (второму) рантайму. Первый рантайм остаётся
     жить со своим `pump`-таймером: worker не завершается, а запись о нём уже
     удалена. Повторная кнопка создаёт **новый worker** на тот же
     `STATE_DIR/<code>` — и два живых мира продолжают писать один журнал.
- Репро: создать лобби на 2, оба «Готов», затем
  ```js
  Promise.all([POST /api/start (host), POST /api/start (host)])
  ```
  (или два клика по «Начать игру»: кнопка не блокируется на время запроса,
  а старт занимает 1-3 с — worldgen 192 + checkpoint 3 МБ).
- Доказательство (дамп журнала комнаты после двух стартов и одного повтора):
  ```
  off 0    control room-start  seed «вольная-пойма-700»   epoch 1
  off 302  control room-start  seed «мшистая-долина-562»  epoch 1
  off 606  control close        tick 0                    epoch 1
  off 722  tickCommit tick 1 epoch 1
  off 864  tickCommit tick 2 epoch 1        ← два рантайма
  off 1006 tickCommit tick 2 epoch 2        ← пишут один файл
  …  по паре на каждый тик до 730 …
  off 213448 tickCommit tick 731 epoch 1
  off 213594 tickCommit tick 731 epoch 2
  ```
  и два checkpoint'а на один тик от разных поколений, каждый со своим
  `journal.offset`:
  `checkpoint-0000001120-0000001120-000001.json` и `…-000002.json`
  (prune каждого рантайма удаляет файлы другого — гонка на удаление).
  Оба `POST /api/start` вернули `409 {"reason":"комната не поднялась: room_fault"}`,
  а мир при этом шёл (731 тик) без единого клиента.
  Какая приёмка НЕ ловит: `mp-acceptance.js` жмёт старт один раз и ждёт ответ;
  двойного старта нет и в `game/tools/mp.js` (там один клик по кнопке).
- Уверенность: высокая (воспроизведено дважды, журнал и файлы на диске).
- Правка: (а) в `startRoom` — сериализовать старт на лобби
  (`if (lobby.startPromise) return lobby.startPromise`), проверять
  `lobby.started` синхронно **до** первого `await`, ставить `lobby.started`
  сразу после создания записи; (б) в worker'е — `init` только если
  `runtime === null`, иначе отвечать `ready` текущим состоянием; (в) при
  провале старта не удалять запись, не погасив worker (`await` реального
  `shutdown`/`terminate`), иначе появляется «зомби»-мир; (г) кнопке в
  `lobby.js` — `disabled` на время запроса.

### BUG-09-04 · Оборванный хвост журнала не отсекается: после второго падения комната не поднимается вообще · critical
- Файл: `game/server/persistence.js:98-120` (`openSegment`, режим `'a+'`),
  `:37-54` (`decodeRecords`, `allowTruncatedTail`), `:290-316`
  (`readJournal`), `:244-286` (`loadLatest`), `game/server/room-runtime.js:149-154`
  (`enterFault('load')`).
- Что происходит. Оборванную последнюю запись `readJournal` **терпит** (не
  бросает), но файл не усекается: следующий `append` дописывает новые записи
  **после мусора**. На следующем старте тот же мусор оказывается уже в
  середине файла → `journal_checksum` → `loadLatest` бросает (отката на
  checkpoint нет), `start()` уходит в `fault('load')`. `/api/recover` тоже
  вызывает `loadLatest` и падает так же. Документация обещает обратное:
  «При загрузке оборванный последний record отсекается» (`MP_IMPLEMENTATION.md:173`).
- Репро (standalone, `persistence.js`):
  ```
  append(accept) ; append(tickCommit 1) ; close
  appendFileSync(file, encodeRecord(tickCommit 2).subarray(0, len/2))  // имитация падения
  reopen → loadLatest → ok, truncated=true, end={offset:107}          // хвост терпится
  append(tickCommit 3) ; append(tickCommit 4) ; close                 // пишем ПОСЛЕ мусора
  reopen → loadLatest → FAIL journal_corrupt:journal-000001.log:journal_checksum
  ```
  Второй запуск после падения — это ровно тот случай, ради которого
  checkpoint+журнал и делались.
  Какая приёмка НЕ ловит: `mp-acceptance.js` перезапускает сервер **чисто**
  (SIGTERM/обычный exit), обрыва записи не моделирует; `--test` на
  `testFault` (injected fault) тоже не режет файл.
- Уверенность: высокая (воспроизведено).
- Правка: при `open()` — если `loadLatest` вернул `journalTruncated`,
  `ftruncate` последнего сегмента до `journalEnd.offset` и `fsync` до открытия
  на запись (или открывать не `'a+'`, а `'r+'` и писать по явному offset).
  Плюс в `loadLatest` при ошибке чтения журнала после checkpoint — не
  падать, а стартовать с состояния checkpoint (потеря ≤40 тиков) и писать
  явный `control journal-corrupt` в новый сегмент, иначе комната
  невосстановима.

### BUG-09-05 · `POST /api/lobby` без аутентификации и лимита; лобби, к которому ни разу не подключились, не удаляется никогда · major (DoS)
- Файл: `game/server/server.js:2335-2353` (`POST /api/lobby`), `:475-517`
  (`makeLobby`), `:1558-1592` (`dropPlayer`, единственное удаление —
  `lobbies.delete` на `:1573`), `:1594-1636` (`markOffline` — единственный
  путь, который ставит таймер на 45 с, и он вызывается только из
  `onStreamClosed`).
- Что происходит. Каждый POST создаёт лобби + игрока (`online: true`,
  `lastSeen: now`) и кладёт в `lobbies` (`Map`). Таймера на «создано, но
  никто не пришёл» нет: `p.timer`/`lobby.hostTimer` ставятся только при
  закрытии SSE, а если SSE не открывали — не ставятся вообще. Предела
  `lobbies.size` нет (`MAX_ACTIVE_ROOMS` ограничивает только worker'ы,
  `:674`). Ни аутентификации, ни rate limit на `/api/lobby` и `/api/join`.
- Репро/доказательство:
  ```
  3000 POST /api/lobby  ->  331 мс  (≈9000 запросов/с, все 200)
  RSS 283 МБ  →  +20 000 лобби  →  341 МБ   (≈2.9 КБ на лобби, не убывает)
  ```
  Через 45+/60+ с лобби на месте (таймеров нет). 1 млн лобби ≈ 3 ГБ → OOM;
  тот же цикл может заранее съесть коды (`code()` — 5 символов из 32, 33.5
  млн, коллизии перебираются в `while`).
  Какая приёмка НЕ ловит: `mp-acceptance.js` создаёт одно лобби и не смотрит
  на повторные создания/память.
- Уверенность: высокая (замер RSS).
- Правка: предел числа лобби (`MAX_LOBBIES`, 503 `server_capacity`), token
  bucket на IP для `/api/lobby` и `/api/join`, и `setTimeout(…, TTL)` при
  создании: лобби без SSE/старта дольше N минут — удалить (и снять с
  `roomRecords`, если комната поднималась).

### BUG-09-06 · Faulted-комната навсегда занимает единственный слот, а `/api/recover` недоступен из UI · major
- Файл: `game/server/server.js:654-670` (`roomWorkerFault`), `:672-678`
  (`createRoomWorker`: `roomRecords.size >= MAX_ACTIVE_ROOMS` → 503),
  `:695-698` (`rec.ready` — one-shot promise), `:2427-2449` (`/api/recover`),
  `game/js/play.js:802` (на `room-fault` только бейдж), в `game/js/*.js`
  вызовов `/api/recover` нет.
- Что происходит. При логической ошибке комната уходит в `faulted`, но запись
  из `roomRecords` не удаляется и worker не останавливается. `MAX_ACTIVE_ROOMS`
  по умолчанию 1, поэтому **любой новый старт получает
  `503 server_capacity`** до перезапуска сервера. Восстановление
  предусмотрено только через `POST /api/recover`, но клиент его не вызывает
  (в UI кнопки нет) — то есть обычный игрок после `room-fault` не может ни
  продолжить, ни начать новую игру. Дополнительно `rec.ready` — промис,
  который нельзя переиспользовать: если fault случился до `ready`, повторный
  `/api/start` для этого лобби навсегда получает уже отклонённый промис.
- Репро: довести комнату до fault (в тесте — двойной старт из 09-03; в
  бою — любое исключение `sim.step`), затем `POST /api/start` из другого
  лобби:
  ```
  {"ok":false,"reason":"на сервере уже идёт другая партия; попробуйте позже",
   "code":"server_capacity"}
  ```
  при том, что играть не в чем (комната faulted).
  Какая приёмка НЕ ловит: fault-путь в `mp-acceptance.js` не инжектится
  (для `testFault` нужен `testMode`, которого сервер не включает).
- Уверенность: высокая по коду и по замеру `server_capacity`; сценарий
  «fault → рестарт сервера — единственный выход» следует из отсутствия
  вызова `/api/recover` в клиенте.
- Правка: при fault освобождать слот (terminate worker, `roomRecords.delete`)
  либо считать «мёртвые» записи отдельно от лимита; `rec.ready` заменить на
  функцию `waitReady()`; добавить в UI кнопку «Восстановить» для хоста либо
  автоматический `recover` с ограничением попыток.

### BUG-09-07 · Checkpoint 3 МБ каждые 2 секунды (40 тиков) · minor (I/O, CPU, износ диска)
- Файл: `game/shared/net-config.js:30` (`checkpointEveryTicks: 40`),
  `game/server/room-runtime.js:611-614` (`await this.writeCheckpoint` внутри
  тика), `game/server/persistence.js:199-241` (`writeCheckpoint`: полный
  `JSON.stringify` + fsync + rename + fsync каталога).
- Что происходит. `exportState()` + запись целого мира каждые 40 тиков = раз в
  2 с. Замер на карте 192: файл `checkpoint-…-240-…json` = **2 966 485 Б**,
  два таких файла, mtime обновляется каждые 2 с → ≈1.5 МБ/с непрерывной
  записи, ≈5.4 ГБ за час партии (плюс журнал ~10 МБ/ч). На macOS с быстрым SSD
  это не дало видимых провалов (SSE-кадры: 92 кадра за 9055 мс, худшие
  промежутки 101–106 мс; тик 20.08/с), но на VPS с сетевым диском 3 МБ
  fsync каждые 2 с — это гарантированные паузы мира и износ.
- Доказательство: `ls -la` показывает `2966485` и `2966464` Б у двух
  чекпоинтов подряд; `checkpoint.journal.offset` растёт на ~6 КБ за те же 2 с.
- Уверенность: высокая (размеры/частота), влияние на VPS — не измерено.
- Правка: чекпоинт по времени/объёму (например раз в 10–15 с или после N КБ
  журнала), а не по фиксированным 40 тикам; либо инкрементальный/сжатый
  (gzip) checkpoint; вынести запись из тика в очередь, но не терять
  контракт «committed после fsync».

### BUG-09-08 · `/api/command-state` отдаёт результаты чужих команд: commandId не привязан к сессии · minor
- Файл: `game/server/server.js:2920-2972` (принимает любые `id`/`commandId`),
  `game/server/room-runtime.js:771-806` (`commandState(sessionId, ids)` ищет в
  общем `byId`, `sessionId` нигде не сверяется), `game/server/server.js:627-635`
  (`buildStartPayload` выдаёт `instance` **всех** игроков каждому).
- Что происходит. Игрок с валидным токеном (любой гость) может читать статус
  и причину любой команды другого игрока, зная `instance:seq`; `instance`
  приходит в старте всем, `seq` — маленькое целое. Проверки владения нет ни в
  HTTP-слое, ни в комнате.
- Репро:
  ```
  GET /api/command-state?code=4VNFE&token=<гость>&id=s0-b6589fc6:1
  → {"results":[{"commandId":"s0-b6589fc6:1","status":"rejected",
      "reasonCode":"not_found","reason":"нет такой постройки или жителя",
      "decidedTick":125,…}]}
  ```
  (запрос сделан токеном гостя, `s0-…` — instance хоста).
  Какая приёмка НЕ ловит: `mp-acceptance.js` опрашивает только свою команду.
- Уверенность: высокая.
- Правка: в `commandState` фильтровать `byId` по `sessionId`
  (`res.sessionId === sessionId`), в HTTP-слое — 404/unknown для чужих id;
  `instance` игрока не рассылать всем (клиенту нужен только его собственный).

## Проверено и НЕ баг

- **Тело команды 16 КиБ и gzip-бомба.** `readJson` считает сырые байты
  (`MAX_BODY = 4 МБ`, `server.js:2061`) и распаковывает с
  `maxOutputLength: MAX_UNZIP = 8 МБ` (`:2136`); `/api/command` отдельно
  режет `JSON.stringify(cmd)` по `commandBodyMaxBytes` (`:2723`). Битый
  JSON/gzip → 400, превышение → 413 + destroy. Ошибка обработчика не
  попадает в ветку «битый JSON» (разбор и вызов разделены, `:2075-2108`) —
  это соответствует описанию в комментарии.
- **Токен = единственный credential, и он не подделывается из payload.**
  `owner`/`playerId` берутся из лобби (`:2742`, `:2762`), `commandId`
  обязан начинаться с выданного сервером `instance` (`:2748`), тело
  `epoch/roomId/protocol` сверяется (`:2754-2760`). Чужой `roomId`/чужой
  `commandId`/протокол отклоняются. `playerByToken` сравнивает 36-символьный
  случайный токен (`:472`).
- **`409 server_authoritative` на `POST /api/snapshot`** (`:2626-2631`) —
  тело не читается и не сохраняется; второй обработчик `:2634-2704` (и
  второй `/api/command`/`/api/command-state`) недостижим — мёртвый код
  старого relay-протокола, не дыра.
- **SSE: gzip и flush.** Живой поток с `Accept-Encoding: gzip` отдал
  `Content-Encoding: gzip`, `Vary: Accept-Encoding`, 92 кадра за 9055 мс
  (10.16/с), худший промежуток 106 мс — `Z_SYNC_FLUSH` работает; смешения
  сырого текста с gzip нет (всё идёт через `streamWrite`/`pushControl`/
  `pushSnapshot`), `setNoDelay` выставлен.
- **Backpressure/память потока.** Очередь управления ограничена 64 событиями
  и 128 КиБ, снимок — слот «последний» (старый заменяется), gzip и сокет
  останавливаются по `write()===false`/`drain`; утечки `res` нет
  (`close`/`req.close`/`error` → `onStreamClosed` → `closeStream` с guard'ом).
  Единственное отличие от документации — `slowClientTimeoutMs`/
  `streamQueueMaxBytes` из `net-config.js` не используются вовсе (см.
  «Не проверено»).
- **Пустая комната.** `markEmpty` вызывается раз в 30 с из
  `server.js:3203-3208`, `online` считается по `p.online !== false`;
  suspend пишет `control suspend` + checkpoint (`room-runtime.js:874-882`),
  возврат через `/api/events` будит комнату (`:2594`). Гонки с `start` не
  нашёл: `markEmpty(false)` ставит `baselinePending`.
- **F5/resume.** После `kill -9` и перезапуска: `/api/resume` поднял мир с
  checkpoint 40 + журнала (tick 62 → 64), `epoch` 1 → 2, `session.instance`
  и `owner` пришли, команда принята (`202`), состояние комнаты
  `running`. `lobby.started`/`saveLobbyMeta` вызываются только после
  успешного старта (`:832-839`), поэтому «несостоявшееся» лобби после
  рестарта просто исчезает (403) — это ожидаемо и не ломает `restoreLobbies`.
- **`resume` чужого токена/чужого лобби.** `playerByToken` по коду лобби,
  иначе 403; `dropPlayer`/`leave` только со своим токеном.
- **upnp/tunnel.** `upnp.js` — `execFileSync('route', …)` с фиксированными
  аргументами и `http.get` к найденному location (SSRF только внутри
  локальной сети, только при включённом UPnP); `tunnel.js` — `spawn('ssh',
  args)` без shell, аргументы фиксированы.
- **Rate limit/token bucket.** `checkRate` (`room-runtime.js:324-333`)
  пополняется 20/с до 40, вызывается после проверок sequence/epoch и до
  очередей — отказ не съедает `clientSequence`, повторы не «залипают».
- **Мёртвые фрагменты, не влияющие на поведение:** `startLobby`
  (`server.js:1936`) не вызывается вовсе; второй `/api/snapshot`
  (`:2634`) недостижим; `lobby.startPayload` после `ensureRoom` несёт
  `sites: []`, а `start.sites` в `game/js/*.js` не читается.

## Не проверено

- **Медленный/мёртвый клиент SSE.** `slowClientTimeoutMs` (5000) и
  `streamQueueMaxBytes` (2 МиБ) из `net-config.js` нигде не используются:
  потока, который перестал читать, сервер не закрывает — он только
  перестаёт в него писать (память ограничена). Не проверял, удерживает ли
  такой «полуоткрытый» клиент `p.online = true` и мешает ли suspend пустой
  комнаты (нужно 10 минут + рваная сеть). Документация при этом обещает
  `slow_client` (`game/server/README.md:161-163`).
- **Поведение `recover`** (in-process `/api/recover`): в нём
  `writeCheckpoint` использует `this.lastJournal` до перезаписи состояния,
  то есть может записать `journal.offset` ПОЗЖЕ своего `tick`; и `recover`
  не восстанавливает `lastJournal` после рестарта. Сценарий требует
  инжекта fault + рестарт в узком окне (2 с) — не воспроизводил; в отчёт не
  включил как находку, но место стоит закрыть (см. правку 09-04: offset
  всегда пересчитывать от `journalEnd` загруженного журнала).
- **Ротация 16 МиБ и удаление старых сегментов.** `persistence.js` не
  удаляет старые `journal-*.log` вовсе (`pruneCheckpoints` есть,
  `pruneSegments` нет), хотя `MP_IMPLEMENTATION.md:172` обещает. Диск растёт
  ~10 МБ/ч, не проверил долгую партию и переход `meta.json`/сегментов после
  рестарта (meta никогда не пишется).
- **DoS тысячами SSE-соединений** (нет лимита на число потоков и на
  `/api/events`): не измерял.
- **Повтор одного `commandId` с другим payload** (`command_id_conflict`):
  сервер вернёт отказ, и клиент после отката `clientSeq` может зациклиться
  на том же ID — воспроизводил только разбором кода (`room-runtime.js:383-394`
  + `game/js/net.js`, откат `clientSeq` в `admitted:false`).
- **`command-state` под флудом**: 4000 параллельных запросов с 200 id — тик
  держался 19.80/с, но долговременный эффект на `rec.pending` и worker не
  мерил (не нашёл пользовательского вреда за короткий тест).
- Долгий soak комнаты, реальный VPS, Windows-клиент — вне области и времени.

## Топ-5

1. **BUG-09-03** — двойной старт: два мира пишут один журнал, зомби-worker,
   гонка prune, 409 у обоих стартов. Триггер — второй клик по кнопке без
   блокировки. Порча данных, а не только отказ.
2. **BUG-09-01** — обход статики через `%2e%2e`: `.git/config`, `.git/HEAD`,
   `docs/`, `AGENTS.md`, `tools/` читаются по HTTP. Обещание «наружу только
   game/ и mapgen2/» ложно.
3. **BUG-09-02** — `lobby.json` с токенами внутри `/game/server/var/rooms/`:
   утечка credential'ов всех комнат по умолчанию (LAN/Hamachi/туннель), и это
   уже лежит в репозитории как артефакт прогона.
4. **BUG-09-04** — оборванный хвост журнала не усекается: первое падение
   терпится, второе делает комнату невосстановимой, `/api/recover` не
   помогает (он тоже зовёт `loadLatest`).
5. **BUG-09-05/06** — `/api/lobby` без лимита (20k лобби ≈ +58 МБ, никогда не
   удаляются) и faulted-комната, которая держит единственный слот → 503 всем
   новым играм до рестарта, а `/api/recover` из UI недоступен.
