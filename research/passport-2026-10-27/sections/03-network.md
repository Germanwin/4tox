# 03. Сеть: транспорт и протокол

Срез: `HEAD=6b9f06b`. Ссылки — `путь:функция:строки`; для маршрутов внутри
общего обработчика — `game/server/server.js:handleRequest:/api/…:строки`.
Все примеры в §5 **собраны по коду, не перехвачены**: имена и порядок полей
взяты из литералов, значения времени/кода/координат условные. Токен везде
`<token>`.

## 1. Роли и каналы

- Мир считает только браузер хоста; сервер не симулирует и не правит
  состояние (`game/server/server.js:1-38`). Гость рисует снимки и шлёт команды.
- Вниз — SSE `GET /api/events` (`game/server/server.js:openEventStream:818-923`),
  вверх — обычные POST (`game/server/server.js:handleRequest:1849-2361`).
- Второй, страховочный канал лобби — опрос `GET /api/status` раз в 1.5 с
  (`game/js/lobby.js:startPolling:336-340`); он же доносит уже случившийся
  старт, если SSE умер (`game/server/server.js:statusView:1728-1736`).
- Пропуск — пара `code`+`token`; токен выдаётся при создании/входе
  (`game/server/server.js:addPlayer:1056-1070`) и проверяется в каждом запросе
  (`playerByToken:1043-1047`). Роль клиента — `state.netRole === 'host' |
  'client'` (`game/js/play.js:startNet:687`); снимки шлёт только хост
  (`game/js/play.js:netSend:435`), команды в основном гость.

## 2. Endpoint'ы

| Endpoint | Метод | Кто | Частота и её источник | Клиентский таймаут |
|---|---|---|---|---|
| `/api/lobby` | POST | хост | клик «Создать» (`lobby.js:createLobby:374-388`) | `LIMITS.request` 8000 мс (`net.js:36`) |
| `/api/join` | POST | гость | клик «Войти» (`lobby.js:joinLobby:390-406`) | 8000 |
| `/api/ready` | POST | все | клик «Готов» (`lobby.js:toggleReady:408-425`) | 8000 |
| `/api/start` | POST | только хост | клик «Начать игру» (`lobby.js:startGame:429-437`) | `LIMITS.start` 10000 (`net.js:39`) |
| `/api/status` | GET | все в лобби | `setInterval(…,1500)` (`lobby.js:338`) + сразу после ready (`:418`) | `LIMITS.status` 5000 (`net.js:37`) |
| `/api/events` | GET | все | один EventSource на клиента; реконнект браузера по `retry: 1500` (`server.js:2068`) | — (поток) |
| `/api/snapshot` | POST | только хост | из `Play.tick`, база 80 мс, адаптивно 80–200 мс (`play.js:46,57,2009-2016`), один POST в полёте | `LIMITS.snapshot` 6000 (`net.js:42`) |
| `/api/command` | POST | игрок (обычно гость) | на каждое действие, строго по одной (`net.js:92,719-727`) | 3000 на весь POST с повтором (`net.js:44`) |
| `/api/command-state` | GET | отправитель команды | пока есть pending: 200 мс, рост +150 до 1200 (`net.js:114,227`) | `LIMITS.commandState` 4000 (`net.js:40`) |
| `/api/ping` | GET | все | гость 2000 мс (видимая вкладка), хост 2500 мс (`play.js:1990,2021`) | `LIMITS.ping` 4000 (`net.js:41`) |
| `/api/resume` | GET | все | один раз на загрузку/F5 при сохранённой сессии (`net.js:resume:615-659`) | `LIMITS.resume` 8000 (`net.js:38`) |
| `/api/diag` | GET | только хост | 10 000 мс в `Play.tick` (`play.js:2033-2041`) + при выгрузке (`play.js:1437-1443`) | 5000 (`net.js:1062`) |
| `/api/stream-stats` | GET | только хост | игра не зовёт; только приёмка (`game/tools/stream.js:263`) | — |
| `/api/server` | GET | все | при загрузке (`boot.js:401-406`), в лобби при проверке сети и раз в 8 с (`lobby.js:354-358`) | 8000 |
| `/api/build` | GET | — | игра не зовёт; только тесты (`game/tools/http.js:507`) | — |
| `/api/leave` | POST | все | выход/в меню/новый остров (`net.js:leave:1068-1074`) | 8000 |

Детали по маршрутам (метод, кто и частота — в таблице выше; номера строк без имени файла — `game/server/server.js`).

**`/api/snapshot`** — только хост, иначе 403 (`:2098-2101`); пустой снимок → 400
(`:2102-2104`). Запрос `{code, token, snapshot}` (`net.js:832`), тело может быть
gzip (`net.js:891`). Ответ `{ok, commands, cmdSeq, gzip, serverNow, build,
protocol, queue, queueWire, queueAge, streams, snapshotBytes}` (`:2143-2147`);
устаревший `seq` → `{ok, stale:true, …}` без `snapshotBytes` (`:2123-2130`), но
команды в ответе есть. Busy: один POST в полёте — `state.netBusy`
(`play.js:435,438`, снятие `:494,523`); таймаут 6000 мс — кадр пропускается
(`play.js:522-529`). Подтверждение: сам POST обновляет `lastSeen`/`lastSnapAt` и
снимает `hostGone` (`:2105-2113`); `commands` — очередь на исполнение (`:2118`),
`lastSnapshot`/`lastSnapSeq` — для `/api/resume` (`:2131-2135`).

**`/api/command`** — любой участник; `from`/`owner` ставит сервер (`:2205-2206`),
`sn` — номер приёма (`:2252`), `at`/`ageMs` — часы сервера (`:2253-2254,1439-1445`).
Запрос `{code, token, command}`: обязательны `n>0` и `type` (`:2181-2186`), у
`buildLine` — `x,y,x2,y2` и `buildingType` (`:2189-2199`), `items>20` → 400
(`:2200-2204`). Ответ `{ok,n,commandId,sn,state:'pending',ageMs:0,serverNow,
build,protocol,pending}` (`:2262-2266`); повтор в очереди → `duplicate:true`,
повтор решённой → её результат (`:2210-2229`). Очередь 200, вытеснение старейшей
неотданной с `expired` (`:434,2233-2250`), TTL 15/60 с (`:433,442,1358-1376`).
Подтверждение — не 200, а `cmdDone`/`cmdAck` в снимке (`:1384-1425`) и
`/api/command-state`; на клиенте до 2 попыток в 3000 мс с тем же `n`
(`net.js:702-716`).

**`/api/command-state`** — только свои результаты (`:2297-2314`); `n` можно
повторить и перечислить (`:2291-2296`). Ответ: один `n` → `{n,commandId,sn,
state,reason,at,decidedAt,ids,appliedSeq,ageMs,compact,ok,serverNow}`
(`:2297-2320`), несколько → `{ok,now,serverNow,results}` ≤ 20 (`:2321-2324`), без
`n` — своя очередь + последние 20 (`:2325-2346`). Состояния `pending|applied|
rejected|expired`, `unknown` — «не знаю» (`:2311-2313`). Busy: один опрос в
полёте, снятие в `finally` (`net.js:196-198,229-233`); 4000 мс, при сбое сети
интервал +250 мс (`net.js:257-266`), опрос 200→1200 мс (`:114,227`).

**`/api/ping`** — `{ok:true, t}`; с кодом и токеном обновляет `lastSeen` и
возвращает `host-back`, если хост считался потерянным (`:1988-1996`).
`ms/msWall/measuredBy` добавляет клиент (`net.js:1013-1017`); 4000 мс, без
повторов, один запрос в полёте (`play.js:2021-2028`).

**`/api/resume`** — по сохранённому токену; `join` после старта закрыт (`:1915`).
Ответ `{ok,started,host,lobby,start,snapshot,seq,build,protocol,cmdProto,
protocolWarning,serverNow,snapshotBytes}` (`:2013-2030`); хосту `lastSnapSeq`
переставляется на `seq` снимка (`:2007-2012`). 8000 мс; при ошибке клиент
закрывает SSE и не даёт старту подняться без снимка (`net.js:648-657`).

**`/api/events`** — участник лобби, иначе `403` текстом (`:2041`); при открытии
отменяется вылет, игрок снова `online` (`:2043-2052`), старый поток закрывается
жёстко (`:2054-2065`); сразу пишутся `retry: 1500`, `hello`, `start`, последний
снимок, `host-left` (`:2068-2083`). Cleanup — `closeStream`: heartbeat, очереди,
gzip, слушатели, `lobby.streams` (`:927-970`).

**Остальные** — `/api/status` `{ok,lobby,started,start,block}` (`:1728-1736`),
403 без токена (`:1975`); `/api/start` только хост (`:1959`), ответ
`{ok,already,start}` (`:1965`), отказ `startBlock` → 409 (`:1962-1964`);
`/api/diag` и `/api/stream-stats` только хосту (`:1865-1871,1879-1888`), тела —
`diagView:1802-1827` и `streamStatsView:1829-1846`, оба зовут `touchPlayer`
(`:1872,1886`). Подтверждение у этих POST — сам ответ; `/api/leave` зовёт
`dropPlayer` (`:2349-2357`), пустое лобби удаляется из карты (`:1133-1136`).

## 3. SSE

- `openEventStream` (`server.js:818-923`): заголовки `text/event-stream;
  charset=utf-8`, `no-cache, no-transform`, `keep-alive`,
  `X-Accel-Buffering: no`, `Vary: Accept-Encoding` (`:820-826`), при
  `Accept-Encoding: gzip` — ещё `Content-Encoding: gzip` (`:819,827`); сразу
  `res.socket.setNoDelay(true)` (`:831`).
- Каждое событие — одна строка `event: <тип>\ndata: <JSON>\n\n`
  (`eventText:545-547`). Все записи идут через `streamWrite` → `pushControl`
  (`:995-999`); сырой `res.write` в обход запрещён комментарием `:905-906`.
  Heartbeat — комментарий `: ping\n\n` раз в 15 000 мс, тоже через очередь
  (`:907-911`).
- Снимки не идут в общую очередь: у потока один слот `pendingSnapshot`
  (`pushSnapshot:759-776`); новый снимок заменяет ещё не записанный старый,
  `coalesced`/`dropped` растут (`:762-768`). Управляющие события стоят
  отдельно и снимками не вытесняются (`:736-754`); очередь управления — 64
  события и 128 КБ (`:594-595`), при переполнении выбрасывается САМОЕ СТАРОЕ
  с записью в `errors` (`:739-746`).
- Backpressure: предел сокета 64 КБ `res.writableLength` и 64 КБ
  `gz.writableLength + gz.readableLength` (`:592-593,629-634`); `write()`
  вернул `false` — звено помечается `blocked` до `drain` (`:683,699,886-894`);
  при заполненном сокете gzip ставится на паузу (`:863-867`).
- Типы событий:

| Тип | Кто получает | Данные | Смысл |
|---|---|---|---|
| `hello` | вошедший | `{playerId, hostId, lobby}` (`:2069`) | поток жив, состав лобби |
| `lobby` | все | `lobbyView` (`:528-543`) | состав/готовность/`canStart` |
| `start` | все | стартовый пакет (`:1511-1534`) | партия началась |
| `snapshot` | все, кроме хоста (`:2148`) | тело снимка | кадр мира |
| `command` | все, кроме автора (`:2271-2276`) | `type,n,sn,from,owner,x,y,x2,y2,buildingType,variant,rot,ids,at,ageMs` | только «разбудить» хоста |
| `command-result` | автор команды (`:1319-1327`) | `n,sn,state,reason,commandId,ageMs,ids,appliedSeq` | быстрый путь результата |
| `peer-left` | все | `{id,name,owner,host}` (`:983-987`) | игрок вышел/пропал |
| `peer-back` | все | `{id,name,owner}` (`:2086-2089`) | игрок вернулся |
| `host-left` | все | `{id,name,owner,host:true}` (`:1096-1098`) | хост потерян |
| `host-back` | все | `{id,name,owner,host:true}` (`:1113-1115`) | хост вернулся |
| `: ping` | все | — | keepalive, клиент его не видит |

- Клиент (`game/js/net.js:connect:470-522`): `new EventSource('/api/events?code&token')`
  (`:473-474`), подписка на десять имён (`:476-477`), каждое событие парсится
  и проверяется на поколение партии и тот же `EventSource` (`:482-484`).
  `hello` обновляет `playerId/hostId/lobby` и эмитит `net-ok` (`:485-491`);
  `start` уходит в `handleStart`, который глушит повтор того же острова по
  ключу `seed|size|ids` (`:448-462`); `command` эмитит `command-ready`, но НЕ
  выполняет команду (`:498-501`); `snapshot` просто эмитится (`:509`) и
  ловится в `play.js:835`; `onerror` ставит `online=false` и эмитит
  `net-error` (`:517-521`). Пакеты `lobby` и `start` — те же объекты, что
  `hello.lobby` в 5.1 и `start` в 5.7.

## 4. Форматы

### Снимок — `mapgen2/js/serialize.js:world:208-227`

| Поле | Что пишется | Источник |
|---|---|---|
| `t` | игровое время, 3 знака | `:211` |
| `seed`, `size` | сид и размер острова | `:212` |
| `towns[]` | `id, owner, name, color, alive, isBot, logs, deliveries, felled, inTransit, lost, birthNext, vid` | `townSnap:54-72` |
| `buildings[]` | `id, type, variant, rot, x, y, owner, town, hp, maxHp, hpUntil, flinch, rubble` | `buildingSnap:74-81` |
| `villagers[]` | `id, x, y` + только отличия от умолчания | `villagerSnap:113-151` |
| `objectTotal` | сколько объектов природы было | `:155-164` |
| `removed` | hex-битовая карта убранного | `removedHex:169-184` |
| `seq` | номер кадра, если передан | `:219` |
| `notes` | ответы хоста `[{to,n,reason}]`, если непусто | `:220`, `play.js:netReject:536-542` |
| `over`, `winner` | итог партии | `:224-225` |
| `cmdDone`, `cmdAck` | дописывает `play.js` после `Serialize.world` | `play.js:448-472` |

- Жители: `owner/town` — только если не 0 (`:115-116`), `rot` — если не 0
  (`:117`), `anim` — если не `idle` (`:118`), `state` — если не `wander`
  (`:121`), `warrior/trainee/hidden/carrying/dead` — только `1`
  (`:122-124,137,144`), `hp` — только у раненого (`:133`), `orderX/orderY` —
  только у воина с невыполненным приказом (`:145-149`). `maxHp` не пишется
  вообще — клиент берёт его из типа (`:133,266-268`).
- `removed` — не массив, а строка hex длиной `2·ceil(objectTotal/8)`; массив
  принимается только как старый формат при чтении (`:186-204`).
- Снимок **полный**, не дельта: каждый кадр несёт все постройки и всех
  жителей; карта не едет — лес у всех одинаков по сиду (`:1-6`).
- Клиент применяет только `seq > netSeq` (`play.js:applySnapshot:1082-1085`),
  сверяет объекты по id (`serialize.js:apply:470-637`), сглаживает позиции
  (`updateVillager:233-244`, `play.js:netSmoothVillagers:1179-1193`). Хост
  после F5 восстанавливает не только отображение: `hydrate` собирает каждого
  жителя через `Villagers.blank` (`serialize.js:322-466`).

### Команда — `game/js/net.js:command:690-781`

- Клиент копирует объект и ставит `n = nextCmdSeq()` (`:693-697`); `n` —
  монотонный номер на базе `Date.now()`, переживает F5 (`:94-103`).
- Типы и поля, которые реально кладут вызывающие:
  `build {buildingType,variant,rot,x,y}` (`play.js:3564-3567`),
  `buildLine {buildingType,variant,rot,x,y,x2,y2}` (`play.js:3475-3478`),
  `edit {action:'move'|'rotate'|'delete', id, x, y}` (`play.js:2935-2952`),
  `order {ids,x,y}` (`play.js:3660-3662`), `stop {ids|null}` (`play.js:3690`),
  `train|hire|fire {campId,villagerId}` (`hud.js:1838-1845,1897-1925`).
- `from` и `owner` добавляет сервер: `from` — id игрока в лобби, `owner` —
  номер его деревни (`server.js:2205-2206`); это разные числа, если кто-то
  выходил до старта (`play.js:1641-1643`).
- `sn` — порядковый номер ПРИЁМА в лобби (`server.js:2252`), по нему хост
  сортирует команды одного отправителя (`play.js:1803-1811`).
- `at` — часы сервера, `ageMs` — возраст по часам сервера на момент выдачи
  (`server.js:2253-2254,1439-1445`). Поле `msn` клиент читает как приоритет,
  но сервер его нигде не пишет (`play.js:1806-1807`).

### Результат — `cmdDone` / `cmdAck` / `command-state`

- `cmdDone` (хост → сервер): `[{from,n,status,reason,ids,appliedSeq}]`
  (`play.js:recordCommandResult:1845-1853`), не больше 20 за кадр
  (`play.js:448-449`), сервер принимает не больше 64 (`server.js:456-457`);
  `status` — `applied|rejected|unknown` (`play.js:1558-1567,1834`).
- `cmdAck` (хост → сервер): `{ "<from>": <последний решённый n> }`
  (`play.js:463-472`) — водяной знак, снимает только уже отданные команды
  (`server.js:1408-1425`).
- Сервер хранит результат по ключу `from:n` (`cmdKey:1215-1217`), окончательные
  состояния — `applied|rejected|expired` (`:460`), первое решение окончательно
  (`:1261-1278`), вытесненные ответы живут «надгробиями» до 5 минут
  (`:450-452,1301-1312`).
- `appliedSeq` — `seq` мира на момент применения (`play.js:1559`), `ids` — id
  созданных построек (`play.js:1691,1730`); по ним клиент заменяет ожидание
  настоящим объектом (`game/js/pending.js:260-271`).
- `revision` в коде нет ни у снимка, ни у команды; версии — `protocol: 3` и
  `cmdProto: 2` (`server.js:84-85`) плюс `build` (`buildId:98-122`).
- Дедупликация команд — пара `(from, n)`: на хосте
  `state.netCmdApplied[from+':'+n]` плюс восстановленный после F5 водяной знак
  (`play.js:1601-1614`), на сервере — `findQueued`/`cmdResultOf`
  (`server.js:2210-2229`). Дедупликация снимков — `seq`; дедупликация `notes`
  — ключ `to|n` (`play.js:1149-1157`).

## 5. Примеры сообщений (собраны по коду, не перехвачены)

### 5.1 SSE: открытие и `hello`

```
GET /api/events?code=AB7KQ&token=<token> HTTP/1.1
Accept: text/event-stream
Accept-Encoding: gzip

HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Vary: Accept-Encoding
Content-Encoding: gzip

retry: 1500

event: hello
data: {"playerId":0,"hostId":0,"lobby":{"code":"AB7KQ","max":2,"started":false,"seed":null,"size":192,"hostId":0,"hostGone":false,"protocol":3,"build":"6b9f06b","protocolWarning":null,"canStart":false,"players":[{"id":0,"name":"Хозяин","ready":false,"host":true,"color":"#4a90d9","online":true},{"id":1,"name":"Гость","ready":false,"host":false,"color":"#d94a4a","online":true}],"hostOnline":true}}
```

### 5.2 `snapshot`: SSE-событие и POST тела

`hex` сокращён для записи; в проводе 1800 символов при `objectTotal: 7200`.

```
event: snapshot
data: {"t":312.45,"seed":"тихая-пойма-417","size":192,"towns":[{"id":0,"owner":0,"name":"Хозяин","color":"#4a90d9","alive":true,"isBot":false,"logs":36,"deliveries":9,"felled":12,"inTransit":1,"lost":0,"birthNext":330,"vid":7}],"buildings":[{"id":"p0:b1000","type":"townhall","variant":"a","rot":90,"x":34,"y":57,"owner":0,"town":0,"hp":600,"maxHp":600,"hpUntil":0,"flinch":0,"rubble":false}],"villagers":[{"id":1,"x":35.42,"y":58.1,"rot":90,"anim":"walk","phase":0.125,"state":"toTree"}],"objectTotal":7200,"removed":"0000000000000000…","seq":412,"notes":[{"to":1,"n":1761234567890,"reason":"не хватает брёвен: нужно 12, у деревни 4"}],"over":false,"winner":null,"cmdDone":[{"from":1,"n":1761234567890,"status":"applied","reason":"","ids":["p1:b1042"],"appliedSeq":410}],"cmdAck":{"1":1761234567890}}
```

Чего в этом сообщении нет и почему: `maxHp` у жителя (`serialize.js:133`),
`owner/town` у жителя нулевой деревни (`:115-116`), `speed/rng/anchor`
(`:37-43`), массива `removed` (`:27-31`).

`POST /api/snapshot` шлёт то же тело в обёртке:

```
POST /api/snapshot
content-type: application/json
content-encoding: gzip          ← только если браузер сжал (net.js:891)

{"code":"AB7KQ","token":"<token>","snapshot":{ …см. выше без обёртки… }}
```

Ответ на свежий кадр:

```
{"ok":true,"commands":[{"type":"build","buildingType":"house","variant":"a","rot":0,"x":40,"y":61,"n":1761234567890,"from":1,"owner":1,"sn":17,"at":1761234567905,"ageMs":178}],"cmdSeq":17,"gzip":true,"serverNow":1761234568083,"build":"6b9f06b","protocol":3,"queue":0,"queueWire":0,"queueAge":0,"streams":1,"snapshotBytes":5210}
```

### 5.4 `POST /api/command` и его ответ

```
POST /api/command
{"code":"AB7KQ","token":"<token>","command":{"type":"build","buildingType":"house","variant":"a","rot":0,"x":40,"y":61,"n":1761234567890}}

{"ok":true,"n":1761234567890,"commandId":1761234567890,"sn":17,"state":"pending","ageMs":0,"serverNow":1761234567990,"build":"6b9f06b","protocol":3,"pending":1}
```

### 5.5 `command` (SSE) и `command-result` (SSE)

```
event: command
data: {"type":"build","n":1761234567890,"sn":17,"from":1,"owner":1,"x":40,"y":61,"buildingType":"house","variant":"a","rot":0,"at":1761234567905,"ageMs":3}

event: command-result
data: {"n":1761234567890,"sn":17,"state":"applied","reason":"","commandId":1761234567890,"ageMs":215,"ids":["p1:b1042"],"appliedSeq":412}
```

В `command` нет `id/action/campId/villagerId/items` — сервер их не кладёт в
событие (`server.js:2271-2276`); undefined-поля `JSON.stringify` выбрасывает.

### 5.6 `GET /api/command-state?…&n=1761234567890`

```
{"n":1761234567890,"commandId":1761234567890,"sn":17,"state":"applied","reason":"","at":1761234567905,"decidedAt":1761234568120,"ids":["p1:b1042"],"appliedSeq":412,"ageMs":215,"compact":false,"ok":true,"serverNow":1761234568200}
```

### 5.7 Остальные сообщения

`[…]` и `…` — сокращение повторяющихся вложений (состав лобби/игроков, длинные
списки), не выдуманные поля; номера строк без имени файла — `game/server/server.js`.

| Сообщение | Пример (собрано по коду, не перехвачено) |
|---|---|
| `POST /api/lobby` → | `{"ok":true,"code":"AB7KQ","token":"<token>","playerId":0,"hostId":0,"max":2,"players":[…],"build":"6b9f06b","protocol":3,"cmdProto":2,"protocolWarning":null}` (`server.js:1896-1901`) |
| `POST /api/join` → | то же, но `playerId:1`, `hostId:0` (`:1921-1926`) |
| `POST /api/ready` → | `{"ok":true,"ready":true,"canStart":false}` (`:1948`) |
| `POST /api/start` → | `{"ok":true,"already":false,"start":{"seed":"тихая-пойма-417","size":192,"sites":[…],"hostId":0,"snapGzip":true,"cmdProto":2,"protocol":3,"build":"6b9f06b","protocolWarning":null,"serverNow":1761234568000,"cmdTtl":15000,"players":[{"id":0,"name":"Хозяин","owner":0,"color":"#4a90d9"},{"id":1,"name":"Гость","owner":1,"color":"#d94a4a"}]}}` (`:1511-1534,1965`) |
| `GET /api/status` → | `{"ok":true,"lobby":{…},"started":false,"start":null,"block":{"reason":"не все готовы: Гость","waiting":1}}` (`:1728-1736,1488-1493`) |
| `GET /api/ping` → | `{"ok":true,"t":1761234569000}` (`:1996`) |
| `GET /api/resume` → | `{"ok":true,"started":true,"host":false,"lobby":{…},"start":{…},"snapshot":{…},"seq":412,"build":"6b9f06b","protocol":3,"cmdProto":2,"protocolWarning":null,"serverNow":1761234569000,"snapshotBytes":5210}` (`:2013-2030`) |
| `GET /api/build` → | `{"ok":true,"build":"6b9f06b","protocol":3,"cmdProto":2,"node":"v22.x","pid":12345,"uptimeMs":900000,"startedAt":"2026-10-27T11:00:00.000Z"}` (`buildInfo:123-131`) |
| `GET /api/server` → | `{…,"ok":true,"port":8787,"local":"http://127.0.0.1:8787/game/","urls":[…],"build":"6b9f06b","protocol":3,"net":{…}}` (`serverView:350-398`) |
| `GET /api/stream-stats` → | `{"ok":true,"build":"6b9f06b","protocol":3,"now":…,"streams":[{"playerId":1,"gzip":true,"rawBytes":812340,"gzipBytes":101233,"wireBytes":101233,"queue":0,"wireQueue":0,"ageMs":0,"dropped":0,"coalesced":3,"snapshotsSent":300,"heartbeats":20,…}],"streamsCount":1,"queue":0,"queueWire":0,"queueAgeMs":0,"totals":{…}}` (`streamStatsView:1829-1846`) |
| `GET /api/diag` → | `{"ok":true,"build":"6b9f06b","protocol":3,"cmdProto":2,"node":…,"heap":{…},"eventLoopDelay":{…},"lobby":{"players":[…],"cmdQueue":0,"cmdResults":2,"cmdSeen":2,"streams":[…],"queue":0,"queueWire":0,"queueAgeMs":0,"totals":{…}},"limits":{…},"log":[…],"serverLog":[…]}` (`diagView:1802-1827`) |
| `POST /api/leave` → | `{"ok":true}` (`:2349-2357`) |

## 6. Backpressure и очереди

- Частота снимков — не таймер, а игровой цикл: `netSend` из `Play.tick`, только
  если `netAcc >= netEvery` и не занято (`play.js:434-436,2009-2016`); `netAcc`
  копит `dt` тика. Второй ограничитель — один POST в полёте: `state.netBusy`
  ставится до `Net.snapshot` и снимается в обоих исходах (`:438,494,523`), в том
  числе при синхронной ошибке сериализации (`:455-459`).
- `NET_INTERVAL = 0.08`, `NET_INTERVAL_MAX = 0.2`, `NET_SLOW_MS = 420`,
  `NET_FAST_MS = 170`, `NET_QUEUE_HIGH = 24 КБ`, `NET_QUEUE_LOW = 4 КБ`
  (`play.js:46-61`). Правило: `queue > HIGH` → `+0.04`; иначе круг `> SLOW` →
  `+0.02`; иначе круг `< FAST` и `queue < LOW` → `−0.01` (`pace:480-492`).
  `netWake` возвращает базу 0.08 при возврате вкладки (`:426-429`, вызовы
  `boot.js:601,605,611,615`).
- Серверная очередь на поток: один слот снимка (`pendingSnapshot`) + очередь
  управления 64/128 КБ; лимиты сокета и gzip по 64 КБ
  (`server.js:592-595,629-634`). Снимок, не влезший в провод, не копится: его
  заменяет следующий (`:759-776`).
- `queue` в ответе — максимум по потокам от `streamQueueBytes =
  res.writableLength + gz.writable+readable + очередь` (`streamBacklog:1025-1041`,
  `streamQueueBytes:612-614`); считается ДО рассылки кадра (`server.js:2119-2122`)
  и описывает уже отправленное. `queueWire` — оценка провода по коэффициенту
  сжатия (`streamWireQueued:619-628`), `queueAge` — возраст старейшего
  ожидающего снимка (`:1032-1033`); хост берёт только `queue` и `gzip`
  (`play.js:482-484`).
- Очередь команд на сервере — 200 (`:434`), просрочка 15 с / 60 с
  (`:433,442`), вытеснение с `expired` (`:2233-2250`).
- На клиенте команды идут цепочкой по одной (`net.js:92,719-727`), опрос
  результатов — один в полёте (`pumpBusy`, `:196-198`), опрос лобби — один в
  полёте (`pollBusy`, `lobby.js:350-351`), ping — один в полёте
  (`play.js:2021-2023`).
- Таймаут клиента покрывает весь ответ, включая тело (`net.js:387-430`); без
  `AbortController` таймера нет вовсе (`:391-402`). Таймаут снимка — не отказ
  мира: кадр пропускается (`play.js:522-529`). Таймаут команды — `unknown`, а
  не `rejected` (`play.js:1513-1531`); повторной отправки после этого нет.
- Потеря хоста: сервер ждёт `HOST_GRACE = 60 000` мс и требует, чтобы не было
  НИ SSE, НИ снимков, НИ `ping` (`server.js:406-414`); проверка `lastSeen` —
  `markOffline:1174-1186`. Тогда — `host-left` (`hostLeft:1079-1101`). Клиент
  по `host-left` останавливает время, но мир оставляет на экране
  (`play.js:onHostLeft:893-903`); по `host-back` или первому снимку продолжает
  (`onHostBack:905-920`, `applySnapshot:1087-1089`). Свой признак тишины —
  `NET_SILENCE = 1.8` с (`play.js:64,1980-1985`); уход игрока — `peer-left`
  (`onStreamClosed:975-992`), в лобби — `OFFLINE_GRACE` 45 000 мс (`server.js:403-405,1189-1197`).

## 7. Сжатие

- SSE включается по `Accept-Encoding: gzip`: `Content-Encoding: gzip`,
  `zlib.createGzip({level: 1, flush: Z_SYNC_FLUSH})` (`server.js:819,827,850`);
  `Z_SYNC_FLUSH` обязателен, иначе zlib копит блок (`:564-566`), а
  `Vary: Accept-Encoding` стоит там же (`:825`). Без `gzip` в заголовке запроса
  `Content-Encoding` нет, поток пишется сырым текстом (`:819,827,686-699`).
- Тело снимка ВВЕРХ сжимает браузер: `CompressionStream('gzip')` над
  `new Response(text).body` (`net.js:gzipBody:806-816`), только если старт нёс
  `snapGzip` (`:876`, флаг сервера `server.js:1518`).
- Нет `CompressionStream`/`Response` или упаковка сразу упала — уходит обычный
  JSON (`net.js:807,876-898`). Упаковка дольше `LIMITS.snapshotPack` = 1500 мс
  — ошибка `snapshot-pack`, кадр пропускается, а не шлётся распакованным
  (`:852-875`).
- Сервер принимает `Content-Encoding: gzip` у любого POST: `gunzip` с
  `maxOutputLength` 8 МБ (`server.js:1692-1709`), тело до распаковки ограничено
  4 МБ (`:1623,1675-1685`); ответ на снимок несёт `gzip: true|false`, по нему
  хост пишет `state.netGzip` (`server.js:2109,2144`, `play.js:484`).

## 8. Чего в коде нет

- Полей `revision` нет (версия мира — только `seq`), `msn` клиент читает как
  приоритет сортировки (`play.js:1806-1807`), но сервер его не пишет.
- `broadcast(…, {drop:true})` (`server.js:2148`) — пятый аргумент `opts` в
  `broadcast` не читается (`:1008-1018`); пропуск снимков обеспечивает слот
  `pendingSnapshot`, а не этот флаг.
- `/api/stream-stats` игра не вызывает; это маршрут приёмки.
- Отдельного «drop при writableLength > 256 КБ» в коде нет: порог 64 КБ (`server.js:592-593`), и он останавливает конвейер, а не режет событие.
