# Проверено координатором (живые прогоны)

Дата: 2026-10-28. Коммит 610db26. Браузерная версия (game/ + mapgen2/), Chrome headless.

## V-01 · blocker · Часы protocol 4: два разных нуля (hrtime vs performance.now)

- `game/server/server.js:536` — `monoMs()` = `process.hrtime.bigint()/1e6` (база — аптайм машины, на замере 381 973 162 мс).
- `game/server/room-runtime.js:16` — `nowDefault()` = `performance.now()` (в worker — от старта процесса, ~10-30 мс).
- `/api/ping` отдаёт `serverReceiveAtMs/serverSendAtMs` из первого (`server.js:2491-2492`), снимок несёт `serverGeneratedAtMs` из второго (`room-runtime.js:491`).
- Клиент складывает их в один offset: `game/js/play.js:986-992` → `game/js/server-clock.js:38,95`.
- Живой прогон (сервер + 2 страницы, `/tmp/mpclock.js`):
  - PING: `clientSendAtMs=7082.2`, `serverReceiveAtMs=381973162`, `revision=62`.
  - GUEST: `renderTime=381966718.65`, `netStale=true`, `state.seconds=381966.7`, `clockErr=2.25`, бейдж «1 мс».
  - HOST в тот же момент: `renderTime=2050`, `stale=false` (у хоста ещё не было пробы; после первой пробы ломается так же).
- Следствия: интерполяции нет (позы `held`), жители ступеньками 12/с; `net-stale` навсегда; часы партии в меню паузы ~6370 минут.
- Приёмка `game/tools/mp.js` проверяет только наличие модулей и что позы «сдвинулись» за 1.2 с — ступеньки проходят.

## V-02 · critical · Одна потерянная команда навсегда гасит все команды (sequence_gap)

- `game/js/net.js:812` — `seq = ++clientSeq` до отправки; при сетевой ошибке (не admitted) отката нет (`net.js:868-880`).
- `game/js/net.js:848-851` — на `admitted:false` ставит `clientSeq = seq - 1`, игнорируя `body.nextClientSequence`.
- Живой прогон (`/tmp/mpseq.js`): первый POST команды уронен (`Failed to fetch`), затем три команды подряд:
  - RETRY1..3: `state=rejected`, `reasonCode=sequence_gap`, `n=2` — все три, всегда.
- Клиент застревает на n=2; F5 не лечит (clientSeq в localStorage).

## V-03 · minor · `stepDeliveries` ключует счётчики по ИНДЕКСУ массива, а не по id

- `game/js/play.js:2591-2594`: `deliveredSeen[i]` / `deliveredSeen[i] = now`.
- Удаление жителя (смерть воина; фильтр в `play.js:2470-2478`) сдвигает индексы.
- Живой прогон (`/tmp/probe3.js`): 3 лесоруба, 56 брёвен; помечаем `villagers[0].dead=true`, один тик:
  `{"vid":3,"amount":0,"total":56}` — событие сдачи с `+0` при неизменном счёте.
- `game/js/hud.js:2016,2023`: на такое событие показывается «+0»; если это случилось до первой настоящей сдачи — ложное «Первое бревно в деревне» и `firstDelivery` сгорает.

## V-04 · minor (инструменты) · `node game/tools/http.js` падает на HEAD

- 4 FAIL + `TypeError` в `commandTests`: тесты ждут старый host-authority (`/api/snapshot` 200, `cmdProto=2`), а сервер с protocol 4 отдаёт 409 (`server.js:2623-2631`).
- Значит приёмочный файл не обновлён после миграции; `docs/MP_VALIDATION.md` его не перечисляет.
- Тот же файл — единственное место, где видно расхождение `Net.commandState(n)` с новым поведением (`http.js:31` FAIL).

## V-05 · cosmetic (мёртвый код) · Второй обработчик `/api/snapshot` недостижим

- `game/server/server.js:2623-2631` — безусловный 409 + `return`; сразу за ним `2634` — старый полный обработчик снимка (~100 строк), который уже никогда не выполнится.
- Признак незавершённой миграции; при правке легко поправить «не тот» обработчик.

## V-06 · cosmetic (доки) · game/README обещает военный лагерь на старте

- `game/README.md:98` — «четыре постройки: ратуша, дом, лагерь лесоруба и военный лагерь».
- Факт: `mapgen2/js/session.js:55-58` VILLAGE = house + lumbercamp (плюс ратуша), warcamp покупается. Живой прогон: 3 постройки.

## V-07 · дизайн/наблюдение · «Против деревни»: враг не нападает

- 10 минут мира: у врага 10 воинов стоят на кольце своего лагеря (`state='patrol'`), бои не начинаются, ратуша игрока цела; враг только рубит лес.
- `Session.startBotCore` (`session.js:741-758`) ставит воинов на патруль и больше никто их не двигает; `Combat` умеет «защиту своего города», приказа идти на игрока нет.
- Не факт, что баг: возможно, режим задуман как «игрок штурмует деревню». Пометить как вопрос к заказчику, не как дефект.
