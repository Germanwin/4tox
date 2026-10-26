/* mp.js — приёмка мультиплеера: лобби, «готов», старт, снапшоты.

   Поднимает настоящий game/server/server.js, Chrome и ДВЕ страницы: хост
   создаёт лобби, гость входит по коду и жмёт «Готов». Проверяется, что оба
   оказались в одной партии, что у обоих одинаковые стартовые деревни и что
   постройка, появившаяся у хоста, доезжает до гостя снапшотом. Отдельный
   раздел — войска: у каждого своя панель и свой приказ, чужой лагерь в неё не
   попадает.

   Запуск: node game/tools/mp.js */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const CHROME = require('../../mapgen2/tools/chrome.js');
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 8800 + (process.pid % 90);
const CDP = 9100 + (process.pid % 90);
const PROF = '/tmp/dsh-4tox-mp-' + process.pid;
let fails = 0;
function check(ok, text) { console.log((ok ? '  ok   ' : '  FAIL ') + text); if (!ok) fails++; }
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const BASE = 'http://127.0.0.1:' + PORT;
function postJSON(path, body) {
  return fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(r => r.json());
}
/* SSE-поток до первого события: нужен, чтобы проверить, что игрок не
   вылетает из лобби, когда поток закрылся, и возвращается с тем же токеном. */
async function sseOnce(code, token, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(BASE + '/api/events?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), { signal: ctrl.signal });
    const rd = r.body.getReader();
    while (!(await rd.read()).done) { /* читаем, пока не оборвём */ }
  } catch (e) { /* обрыв — это и есть сценарий */ }
  clearTimeout(timer);
}

/* Открыть поток и оставить его живым: проверяем состояние, пока он ещё
   подключён, а не после обрыва. */
function sseStart(code, token) {
  const ctrl = new AbortController();
  const ready = fetch(BASE + '/api/events?code=' + encodeURIComponent(code) +
    '&token=' + encodeURIComponent(token), { signal: ctrl.signal })
    .then(r => r.body.getReader().read().then(() => true).catch(() => true))
    .catch(() => false);
  return { ready, abort: () => ctrl.abort() };
}

function newTab(url) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: CDP, path: '/json/new?' + encodeURIComponent(url), method: 'PUT' }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  return { ws, send, js };
}

/* Проверки без браузера и без SSE: ровно тот случай, из-за которого «оба
   нажали готов, а игра не началась» — события не доходят, а POST и опрос
   доходят. */
async function serverOnly() {
  const srv = await getJSON(BASE + '/api/server');
  check(srv.ok && (srv.urls || []).some(u => u.kind === 'lan'),
    'сервер отдаёт адреса по IP: ' + (srv.urls || []).map(u => u.url).join(', '));
  check((srv.urls || []).every(u => !/trycloudflare|cloudflared/i.test(u.url)),
    'в адресах нет туннелей');

  const a = await postJSON('/api/lobby', { max: 3, name: 'Хост-без-SSE' });
  const b = await postJSON('/api/join', { code: a.code, name: 'Гость-без-SSE' });
  check(a.ok && b.ok, 'лобби создаётся и принимает второго без SSE');
  const st0 = await getJSON(BASE + '/api/status?code=' + a.code + '&token=' + a.token);
  check(st0.ok && st0.started === false && st0.block, 'до «готов» партия не начата');

  await postJSON('/api/ready', { code: a.code, token: a.token, ready: true });
  const st1 = await getJSON(BASE + '/api/status?code=' + a.code + '&token=' + a.token);
  check(st1.started === false && st1.block && /не все готовы/.test(st1.block.reason),
    'сервер говорит, кого ждём: ' + (st1.block && st1.block.reason));

  await postJSON('/api/ready', { code: a.code, token: b.token, ready: true });
  const st2a = await getJSON(BASE + '/api/status?code=' + a.code + '&token=' + a.token);
  check(st2a.started === false && st2a.lobby && st2a.lobby.canStart === true,
    'оба готовы — но старт ждёт кнопки хоста');
  const started = await postJSON('/api/start', { code: a.code, token: a.token });
  check(started.ok && !!started.start, 'хост нажал «Начать» — партия началась без SSE');
  const st2 = await getJSON(BASE + '/api/status?code=' + a.code + '&token=' + a.token);
  check(st2.started === true && !!st2.start, 'старт виден и опросом');
  check(st2.start && st2.start.players.map(p => p.owner).join(',') === '0,1',
    'владельцы городов в стартовом пакете: 0,1');

  /* Третий друг не должен остаться за бортом: двое готовы, третий ещё
     открывает ссылку — автоматика стартовала бы вдвоём. */
  const t = await postJSON('/api/lobby', { max: 3, name: 'Хост-троих' });
  const t2 = await postJSON('/api/join', { code: t.code, name: 'Второй' });
  await postJSON('/api/ready', { code: t.code, token: t.token, ready: true });
  await postJSON('/api/ready', { code: t.code, token: t2.token, ready: true });
  const t3 = await postJSON('/api/join', { code: t.code, name: 'Третий' });
  const tw = await getJSON(BASE + '/api/status?code=' + t.code + '&token=' + t.token);
  check(t3.ok && tw.started === false && tw.lobby.canStart === false,
    'двое готовы, третий вошёл — старт не случился сам');
  await postJSON('/api/ready', { code: t.code, token: t3.token, ready: true });
  const tw2 = await getJSON(BASE + '/api/status?code=' + t.code + '&token=' + t.token);
  check(tw2.started === false && tw2.lobby.canStart === true,
    'все трое готовы — кнопка хоста доступна');
  const tStart = await postJSON('/api/start', { code: t.code, token: t.token });
  check(tStart.ok && tStart.start.players.length === 3,
    'старт на трёх: все три деревни в пакете');

  /* Обрыв SSE: игрок не вылетает и возвращается той же записью. */
  const c = await postJSON('/api/lobby', { max: 4, name: 'Хост-связи' });
  const d = await postJSON('/api/join', { code: c.code, name: 'Моргнул' });
  await sseOnce(c.code, d.token, 400);
  await sleep(350);
  const off = await getJSON(BASE + '/api/status?code=' + c.code + '&token=' + c.token);
  const dOff = (off.lobby.players || []).find(p => p.id === d.playerId);
  check(!!dOff && dOff.online === false, 'обрыв потока не выкидывает игрока из лобби');
  const live = sseStart(c.code, d.token);
  await live.ready;
  await sleep(150);
  const on = await getJSON(BASE + '/api/status?code=' + c.code + '&token=' + c.token);
  const dOn = (on.lobby.players || []).find(p => p.id === d.playerId);
  check(!!dOn && dOn.online === true && dOn.id === d.playerId,
    'после переподключения тот же id и снова на связи');
  live.abort();
  await sleep(200);

  /* Уход хоста: комната не умирает, id не переиспользуется. */
  await postJSON('/api/leave', { code: c.code, token: c.token });
  const hosted = await getJSON(BASE + '/api/status?code=' + c.code + '&token=' + d.token);
  check(hosted.lobby.hostId === d.playerId, 'хост передан следующему игроку');
  const e = await postJSON('/api/join', { code: c.code, name: 'Новый' });
  check(e.playerId > d.playerId, 'id нового игрока не совпал с живым: ' + e.playerId);
  await postJSON('/api/ready', { code: c.code, token: d.token, ready: true });
  await postJSON('/api/ready', { code: c.code, token: e.token, ready: true });
  await postJSON('/api/start', { code: c.code, token: d.token });
  const st3 = await getJSON(BASE + '/api/status?code=' + c.code + '&token=' + d.token);
  check(st3.started === true && st3.start &&
    st3.start.players.map(p => p.id).join(',') === d.playerId + ',' + e.playerId,
    'старт с «дырой» в id: владельцы считаются по порядку');
  check(st3.start && st3.start.players.map(p => p.owner).join(',') === '0,1',
    'дыра в id не сдвигает деревни: owner 0,1');

  /* Heartbeat хоста. Раньше хост считался пропавшим через 8 секунд без SSE и
     снимков — один долгий кадр или моргнувшая сеть выглядели как уход, и
     клиентов выбрасывало из живой партии. Теперь любой запрос игрока
     (включая GET /api/ping?code&token) доказывает жизнь, а запас — 20 с.
     Проверяем ровно старый порог: 10+ секунд без SSE и снимков, но с
     heartbeat, — партия не объявлена потерянной. */
  const hb = await postJSON('/api/lobby', { max: 2, name: 'Хост-сердце' });
  const hg = await postJSON('/api/join', { code: hb.code, name: 'Гость-сердце' });
  await postJSON('/api/ready', { code: hb.code, token: hb.token, ready: true });
  await postJSON('/api/ready', { code: hb.code, token: hg.token, ready: true });
  await postJSON('/api/start', { code: hb.code, token: hb.token });
  const hbStream = sseStart(hb.code, hb.token);
  await hbStream.ready;
  hbStream.abort();
  await sleep(400);
  for (let i = 0; i < 6; i++) {
    await getJSON(BASE + '/api/ping?code=' + encodeURIComponent(hb.code) +
      '&token=' + encodeURIComponent(hb.token));
    await sleep(1800);
  }
  const hbState = await getJSON(BASE + '/api/status?code=' + hb.code + '&token=' + hg.token);
  check(hbState.lobby.hostGone === false && hbState.lobby.hostOnline === false,
    'heartbeat держит живого хоста без SSE дольше старых 8 с');

  /* Команда не теряется без SSE хоста: она ждёт в очереди лобби и уезжает в
     ОТВЕТЕ на снимок. Это и была причина «здание встало через полминуты»:
     команды шли только событием SSE, а снимки — POST-ом; обрыв SSE терял клик
     молча, клиент получал 200 и ждал постройку, которой никто не видел. */
  const q = await postJSON('/api/lobby', { max: 2, name: 'Хост-очереди' });
  const qg = await postJSON('/api/join', { code: q.code, name: 'Гость-очереди' });
  await postJSON('/api/ready', { code: q.code, token: q.token, ready: true });
  await postJSON('/api/ready', { code: q.code, token: qg.token, ready: true });
  await postJSON('/api/start', { code: q.code, token: q.token });
  const qcmd = await postJSON('/api/command', { code: q.code, token: qg.token,
    command: { type: 'build', buildingType: 'house', x: 10, y: 20, rot: 90, n: 7001 } });
  check(qcmd.ok && qcmd.pending === 1, 'команда легла в очередь лобби: ' +
    JSON.stringify(qcmd));
  /* У хоста здесь НЕТ ни одного SSE-потока — ровно сломанный случай. */
  const qsnap1 = await postJSON('/api/snapshot', { code: q.code, token: q.token,
    snapshot: { seq: 1, t: 1 } });
  const qcmds = qsnap1.commands || [];
  check(qcmds.length === 1 && qcmds[0].type === 'build' &&
    qcmds[0].from === qg.playerId && qcmds[0].owner === 1 && qcmds[0].n === 7001,
    'снимок без SSE хоста приносит команду: ' + JSON.stringify(qcmds));
  /* Повтор после обрыва несёт тот же n — второго дома быть не должно. */
  const qdup = await postJSON('/api/command', { code: q.code, token: qg.token,
    command: { type: 'build', buildingType: 'house', x: 10, y: 20, rot: 90, n: 7001 } });
  const qsnap2 = await postJSON('/api/snapshot', { code: q.code, token: q.token,
    snapshot: { seq: 2, t: 2 } });
  check(qdup.ok && (qsnap2.commands || []).length === 1,
    'повтор с тем же n не задваивает команду');
  /* Хост подтвердил выполнение — очередь чистится. */
  const qsnap3 = await postJSON('/api/snapshot', { code: q.code, token: q.token,
    snapshot: { seq: 3, t: 3, cmdAck: { [qg.playerId]: 7001 } } });
  check((qsnap3.commands || []).length === 0,
    'подтверждённая команда ушла из очереди');
  check(typeof qsnap3.queue === 'number',
    'в ответе на снимок есть очередь друзей: ' + qsnap3.queue + ' Б');
}

/* --------------------------- команды: протокол ------------------------- *
 *
 * Заказчик 2026-10-26: «здание встало через полминуты», «иногда быстрее»,
 * «отказ без молчаливых потерь». Проверяем не «сервер ответил 200», а весь
 * путь: приём → sn → доставка снимком → результат cmdDone → command-state.
 *
 * Один путь выполнения: SSE-событие `command` только будит хост (снимок
 * уходит сразу), а выполняется команда из массива `commands` ответа на
 * POST /api/snapshot, отсортированного сервером по sn. Поэтому SSE-команда
 * без снимка обязана остаться pending — это и проверяется.
 * ---------------------------------------------------------------------- */
function sseWatch(code, token) {
  const out = { events: [] };
  const u = new URL(BASE + '/api/events?code=' + encodeURIComponent(code) +
    '&token=' + encodeURIComponent(token));
  const req = http.request({ host: u.hostname, port: u.port,
    path: u.pathname + u.search, method: 'GET',
    headers: { accept: 'text/event-stream' } }, res => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let type = '', data = '';
        raw.split('\n').forEach(line => {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        });
        if (!type || !data) continue;
        let j = null;
        try { j = JSON.parse(data); } catch (e) { continue; }
        out.events.push({ type: type, data: j });
      }
    });
  });
  req.on('error', () => {});
  req.end();
  out.waitFor = (type, pred, ms) => new Promise(resolve => {
    const t0 = Date.now();
    (function tick() {
      const hit = out.events.find(e => e.type === type && (!pred || pred(e.data)));
      if (hit) return resolve(hit.data);
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(tick, 20);
    })();
  });
  out.close = () => { try { req.destroy(); } catch (e) {} };
  return out;
}

async function commandsTest() {
  console.log('\n== команды: два канала, порядок, результаты ==');
  const h = await postJSON('/api/lobby', { max: 2, name: 'Хост-команд' });
  const g = await postJSON('/api/join', { code: h.code, name: 'Гость-команд' });
  const hA = { code: h.code, token: h.token };
  const gA = { code: h.code, token: g.token };
  await postJSON('/api/ready', { ...hA, ready: true });
  await postJSON('/api/ready', { ...gA, ready: true });
  const started = await postJSON('/api/start', hA);
  check(started.ok && started.start && started.start.cmdProto === 2,
    'старт несёт cmdProto:2 — клиент знает про конечный результат');
  const watch = sseWatch(h.code, h.token);
  await sleep(150);
  let seq = 1;
  const snap = extra => postJSON('/api/snapshot', { ...hA,
    snapshot: Object.assign({ seq: seq++, t: 1 }, extra || {}) });
  const stateOf = n => getJSON(BASE + '/api/command-state?code=' +
    encodeURIComponent(h.code) + '&token=' + encodeURIComponent(g.token) +
    '&n=' + encodeURIComponent(n));

  /* (a/b) Команда без POST-снимков: SSE её приносит, но не выполняет. */
  const c1 = await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 5, y: 5, rot: 0, n: 7001 } });
  check(c1.ok && c1.state === 'pending' && typeof c1.sn === 'number',
    'POST /api/command = {pending, sn}: ' + JSON.stringify(c1));
  const ev = await watch.waitFor('command', d => d && d.n === 7001, 1000);
  check(!!ev, 'SSE-команда доехала до хоста без единого снимка');
  check((await stateOf(7001)).state === 'pending',
    'без снимка команда pending: SSE только будит, а не выполняет');
  await sleep(2000);                       // пауза снимков, как при задумке хоста
  check((await stateOf(7001)).state === 'pending',
    'через 2 с без снимков команда всё ещё pending, а не потеряна');
  const snap1 = await snap();
  const got1 = (snap1.commands || []).filter(c => c.n === 7001);
  check(got1.length === 1 && got1[0].sn === c1.sn,
    'снимок принёс команду с порядком приёма sn=' + c1.sn);
  const c1dup = await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 5, y: 5, rot: 0, n: 7001 } });
  check(c1dup.duplicate === true && c1dup.state === 'pending',
    'повтор в очереди — duplicate pending, второй копии нет');
  await snap({ cmdDone: [{ from: g.playerId, n: 7001, status: 'applied',
    reason: '' }] });
  check((await stateOf(7001)).state === 'applied',
    'cmdDone applied → command-state applied');
  const snap2 = await snap();
  check(!(snap2.commands || []).some(c => c.n === 7001),
    'cmdDone очистил очередь');
  const after1 = await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 5, y: 5, rot: 0, n: 7001 } });
  check(after1.duplicate === true && after1.state === 'applied',
    'повтор после результата отдаёт applied, а не кладёт в очередь');

  /* (d) Перестановка доставки: обе команды в одной пачке, порядок — по sn
     (порядок приёма), более ранняя не теряется. */
  await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 6, y: 5, rot: 0, n: 7102 } });
  await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 7, y: 5, rot: 0, n: 7101 } });
  const snap3 = await snap();
  const pair = (snap3.commands || []).filter(c => c.n === 7102 || c.n === 7101);
  check(pair.length === 2 && pair[0].sn < pair[1].sn,
    'обе команды в одной пачке, sn возрастает: ' +
    pair.map(c => c.n + '/sn' + c.sn).join(', '));
  await snap({ cmdAck: { [g.playerId]: 7102 } });   // обе уже отданы хосту
  /* Поздняя команда с МЕНЬШИМ n, принятая после ack: водяной знак не должен
     съесть её, пока хост её не видел. */
  await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 8, y: 5, rot: 0, n: 7100 } });
  const snap4 = await snap({ cmdAck: { [g.playerId]: 7102 } });
  check((snap4.commands || []).some(c => c.n === 7100),
    'ack 7102 не съел невиденную n=7100 — нет молчаливой потери');
  await snap({ cmdAck: { [g.playerId]: 7100 } });
  check((await stateOf(7100)).state === 'applied',
    'поздняя 7100 доехала и подтверждена');

  /* (g) Отказ мира — это результат, а не сетевой сбой. */
  await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 9, y: 5, rot: 0, n: 7200 } });
  await snap();
  await snap({ cmdDone: [{ from: g.playerId, n: 7200, status: 'rejected',
    reason: 'не хватает брёвен: нужно 10' }] });
  const rejected = await stateOf(7200);
  check(rejected.state === 'rejected' && /брёвен/.test(rejected.reason || ''),
    'rejected доезжает с причиной: ' + JSON.stringify(rejected));

  /* (h) buildLine: повтор с тем же n не создаёт серию дважды. */
  const line = { type: 'buildLine', buildingType: 'house', variant: 'a',
    rot: 0, x: 20, y: 20, x2: 26, y2: 20, n: 7300 };
  const b1 = await postJSON('/api/command', { ...gA, command: line });
  const b2 = await postJSON('/api/command', { ...gA, command: line });
  check(b1.state === 'pending' && b2.duplicate === true,
    'buildLine: повтор с тем же n — duplicate pending');
  const snap5 = await snap();
  check((snap5.commands || []).filter(c => c.n === 7300).length === 1,
    'buildLine в снимке ровно один раз');
  await snap({ cmdDone: [{ from: g.playerId, n: 7300, status: 'applied' }] });
  check((await stateOf(7300)).state === 'applied', 'buildLine applied');
  const b3 = await postJSON('/api/command', { ...gA, command: line });
  check(b3.duplicate === true && b3.state === 'applied',
    'повтор buildLine после результата не создаёт дубль');

  /* (e) Просрочка: без снимков команда получает expired, а не молчание. */
  await postJSON('/api/command', { ...gA, command: {
    type: 'build', buildingType: 'house', x: 10, y: 5, rot: 0, n: 7400 } });
  await sleep(15600);
  const expired = await stateOf(7400);
  check(expired.state === 'expired' && /просрочена/.test(expired.reason || ''),
    'TTL 15 с → expired с причиной: ' + JSON.stringify(expired));
  const snap6 = await snap();
  check(!(snap6.commands || []).some(c => c.n === 7400),
    'просроченная ушла из очереди, а не висит вечно');

  /* Лимит очереди: вытеснение — тоже expired, а не молчаливый shift. */
  const h2 = await postJSON('/api/lobby', { max: 2, name: 'Хост-лимита' });
  const g2 = await postJSON('/api/join', { code: h2.code, name: 'Гость-лимита' });
  const h2A = { code: h2.code, token: h2.token };
  const g2A = { code: h2.code, token: g2.token };
  await postJSON('/api/ready', { ...h2A, ready: true });
  await postJSON('/api/ready', { ...g2A, ready: true });
  await postJSON('/api/start', h2A);
  let last = null;
  for (let i = 0; i < 205; i++) {
    last = await postJSON('/api/command', { ...g2A, command: {
      type: 'build', buildingType: 'house', x: 1, y: 1, rot: 0, n: 8000 + i } });
  }
  check(last && last.pending === 200,
    'очередь ограничена 200: последний pending=' + (last && last.pending));
  const old = await getJSON(BASE + '/api/command-state?code=' +
    encodeURIComponent(h2.code) + '&token=' + encodeURIComponent(g2.token) +
    '&n=8000');
  check(old.state === 'expired' && /вытеснена/.test(old.reason || ''),
    'вытесненная команда получила expired: ' + JSON.stringify(old));

  /* Дешёвые отказы протокола: без n и без концов линии. */
  const noN = await fetch(BASE + '/api/command', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...gA, command: { type: 'build',
      buildingType: 'house', x: 1, y: 1 } }) });
  check(noN.status === 400, 'команда без n отвергается 400');
  const noEnds = await fetch(BASE + '/api/command', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...gA, command: { type: 'buildLine',
      buildingType: 'house', n: 7500 } }) });
  check(noEnds.status === 400, 'buildLine без концов линии отвергается 400');

  watch.close();
}

/* ------------------------- сжатие потока SSE -------------------------- *
 *
 * Заказчик 2026-10-25: «каждую игру игра лагает и у друзей огромный пинг».
 * Причина — не правила игры, а вес потока: снимок 5,2 КБ, 12,5 кадров в
 * секунду, то есть ~520 Кбит/с на друга. Канал вверх у домашнего интернета
 * общий, 2–3 таких потока заполняли его, и круг рос очередью в роутере.
 *
 * Теперь SSE сжимается gzip прямо в потоке (server.js: openEventStream).
 * Проверка не «curl увидел gzip», а замер: тот же набор снимков едет двум
 * клиентам — со сжатием и без, — и считаются байты провода.
 *
 * Снимок здесь собирается руками: приёмке не нужен мир, ей нужен вес того,
 * что реально уходит друзьям (восемь жителей, шесть построек, hex-карта на
 * 7200 объектов). Так проверка остаётся быстрой и не зависит от генератора.
 * ---------------------------------------------------------------------- */
function snapshotFor(i) {
  const villagers = [];
  for (let v = 0; v < 8; v++) {
    villagers.push({
      id: v + 1, owner: v % 2, town: v % 2,
      x: +(40 + v * 3 + i * 0.02).toFixed(3), y: +(60 + v * 2).toFixed(3),
      rot: 90, anim: 'walk', phase: 0.5, frozen: false, state: 'chop',
      warrior: v % 3 === 0, trainee: false, hidden: false, trainingId: null,
      trainT: 0, homeId: 10 + v, employerId: 20 + v, campId: null,
      stationId: null, hp: 15, maxHp: 15, hpUntil: 0, flinch: 0,
      attackT: 0, carrying: true, appearT: 0, appearDur: 0,
      vanishT: 0, emergeT: 0, dead: false
    });
  }
  const buildings = [];
  for (let b = 0; b < 6; b++) {
    buildings.push({
      id: 10 + b,
      type: ['townhall', 'house', 'lumbercamp', 'barracks', 'warcamp', 'house'][b],
      variant: 0, rot: 90, x: 40 + b * 3, y: 60, owner: b % 2, town: b % 2,
      hp: 100, maxHp: 100, hpUntil: 0, flinch: 0, rubble: false
    });
  }
  /* Hex-карта не случайная, но и не одинаковая: рубка идёт, биты меняются. */
  let hex = '';
  for (let h = 0; h < 1800; h++) hex += ((i * 7 + h * 13) % 16).toString(16);
  return {
    seq: i + 1, t: i / 10, seed: 'тест-сжатия', size: 192,
    towns: [
      { id: 0, owner: 0, name: 'Хоста', color: '#4a90d9', alive: true,
        isBot: false, logs: i, deliveries: i, felled: i * 2, inTransit: 0 },
      { id: 1, owner: 1, name: 'Гостя', color: '#d94a4a', alive: true,
        isBot: false, logs: 10, deliveries: 3, felled: 4, inTransit: 1 }
    ],
    buildings: buildings, villagers: villagers,
    objectTotal: 7200, removed: hex
  };
}

/* Открыть сырой SSE и считать БАЙТЫ ПРОВОДА. Node-fetch распаковывает
   автоматически и спрятал бы сжатие; здесь http.get и свой gunzip. */
function openRaw(code, token, encoding) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (encoding) headers['accept-encoding'] = encoding;
    const req = http.get(BASE + '/api/events?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), { headers }, res => {
      const out = { headers: res.headers, bytes: 0, events: [], text: '' };
      /* Считаем именно сжатые байты: data на самом res срабатывает до
         распаковки. */
      res.on('data', chunk => { out.bytes += chunk.length; });
      let src = res;
      if (/gzip/.test(res.headers['content-encoding'] || '')) {
        const gz = zlib.createGunzip();
        gz.on('error', () => { /* поток оборвали вручную — это не ошибка теста */ });
        res.pipe(gz);
        src = gz;
      }
      res.on('error', () => {});
      src.on('error', () => {});
      src.on('data', chunk => {
        out.text += chunk.toString();
        let i;
        while ((i = out.text.indexOf('\n\n')) >= 0) {
          const ev = out.text.slice(0, i);
          out.text = out.text.slice(i + 2);
          const m = /^event: ([a-z-]+)/m.exec(ev);
          if (m) out.events.push(m[1]);
        }
      });
      out.close = () => {
        try { req.destroy(); } catch (e) {}
        try { res.destroy(); } catch (e) {}
      };
      resolve(out);
    });
    req.on('error', reject);
  });
}

async function transportTest() {
  const a = await postJSON('/api/lobby', { max: 3, name: 'Хост-сжатия' });
  const b = await postJSON('/api/join', { code: a.code, name: 'Гость-сжатия' });
  /* Второй гость без сжатия: /api/join после старта закрыт, поэтому оба
     входят и готовятся ДО кнопки хоста. */
  const c = await postJSON('/api/join', { code: a.code, name: 'Гость-без-сжатия' });
  await postJSON('/api/ready', { code: a.code, token: a.token, ready: true });
  await postJSON('/api/ready', { code: a.code, token: b.token, ready: true });
  await postJSON('/api/ready', { code: a.code, token: c.token, ready: true });
  const started = await postJSON('/api/start', { code: a.code, token: a.token });
  check(started.ok && started.start && started.start.players.length === 3,
    'лобби на трёх для замера сжатия собрано');

  const gz = await openRaw(a.code, b.token, 'gzip');
  const plain = await openRaw(a.code, c.token, 'identity');
  await sleep(300);
  check(gz.headers['content-encoding'] === 'gzip',
    'SSE уходит сжатым: content-encoding ' + gz.headers['content-encoding']);
  check(!plain.headers['content-encoding'],
    'без Accept-Encoding — обычный SSE, без сжатия');

  const snaps = [];
  for (let i = 0; i < 30; i++) snaps.push(snapshotFor(i));
  const rawBytes = snaps.reduce((n, s) => n + JSON.stringify(s).length, 0);
  const gz0 = gz.bytes, plain0 = plain.bytes;
  for (const s of snaps) {
    await postJSON('/api/snapshot', { code: a.code, token: a.token, snapshot: s });
  }
  await sleep(800);
  const gzWire = gz.bytes - gz0, plainWire = plain.bytes - plain0;
  const gotSnaps = gz.events.filter(e => e === 'snapshot').length;
  check(gotSnaps >= 30, 'сжатый поток не застревает: ' + gotSnaps + ' снимков доехали');
  check(plainWire > rawBytes * 0.8,
    'без сжатия снимки идут как есть: ' + Math.round(plainWire / 1024) + ' КБ');
  check(gzWire < rawBytes * 0.4,
    'сжатие режет поток в разы: ' + (gzWire / rawBytes).toFixed(2) + ' от исходного (' +
    Math.round(gzWire / 1024) + ' КБ вместо ' + Math.round(rawBytes / 1024) + ')');
  check(gzWire < plainWire * 0.5,
    'на одном и том же наборе сжатый канал легче: ' + Math.round(gzWire / 1024) +
    ' КБ против ' + Math.round(plainWire / 1024));

  /* Вторая половина канала — снимок ВВЕРХ (VPS-режим: с домашнего интернета
     хоста на релей). Сервер обязан принимать сжатое тело, а хост — получать
     подтверждение, что оно действительно было сжатым. */
  const body = Buffer.from(JSON.stringify({ code: a.code, token: a.token,
    snapshot: snapshotFor(99) }));
  const packed = zlib.gzipSync(body);
  const zres = await fetch(BASE + '/api/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: packed
  }).then(r => r.json());
  check(zres.ok === true && zres.gzip === true,
    'сжатое тело снимка принято: ' + packed.length + ' Б вместо ' + body.length +
    ' Б (' + (packed.length / body.length).toFixed(2) + ' от исходного)');
  const plainBody = await fetch(BASE + '/api/snapshot', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ code: a.code, token: a.token,
      snapshot: { seq: 101, t: 11 } }))
  }).then(r => r.json());
  check(plainBody.ok === true && plainBody.gzip === false,
    'обычное тело снимка по-прежнему принимается');
  gz.close();
  plain.close();
  await sleep(200);
}


const server = spawn(process.execPath, [path.join(REPO, 'game/server/server.js'), '--port', String(PORT), '--no-upnp'], { cwd: REPO, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP,
  '--user-data-dir=' + PROF, '--no-first-run', '--hide-scrollbars', '--window-size=1440,900',
  'about:blank'], { detached: true, stdio: 'ignore' });

function killAll() {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
  try { server.kill('SIGTERM'); } catch (e) {}
}
process.on('SIGINT', () => { killAll(); process.exit(130); });

(async () => {
  for (let i = 0; i < 100; i++) {
    try { await getJSON('http://127.0.0.1:' + PORT + '/api/events?code=X'); } catch (e) { /* 403 = сервер жив */ }
    try { await getJSON('http://127.0.0.1:' + PORT + '/game/'); break; } catch (e) { await sleep(100); }
  }
  await serverOnly();
  await commandsTest();
  await transportTest();
  let tabs = [];
  for (let i = 0; i < 100; i++) {
    try { tabs = await getJSON('http://127.0.0.1:' + CDP + '/json/list'); break; } catch (e) { await sleep(100); }
  }
  const first = tabs.find(t => t.type === 'page' && t.url === 'about:blank') || tabs.find(t => t.type === 'page');
  const A = await connect(first.webSocketDebuggerUrl);
  await A.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/game/' });
  await sleep(6000);
  check(await A.js('!!window.__game'), 'игра загрузилась у хоста');
  await A.js(`window.Lobby.open(); document.getElementById('lobbyName').value='Хост'; document.getElementById('lobbyCreate').click(); 1`);
  await sleep(1400);
  const code = await A.js('window.Net.code()');
  check(!!code, 'лобби создано: ' + code);
  /* Ссылка-приглашение: у хоста страница на 127.0.0.1, а друзьям нужен
     настоящий адрес сервера. */
  const linkA = await A.js(`document.getElementById('lobbyLink').value`);
  const linkOk = /^http:\/\/[^/]+:\d+\/game\/\?lobby=/.test(linkA) &&
    !/127\.0\.0\.1|localhost/.test(linkA);
  const srv = await getJSON(BASE + '/api/server');
  if (!(srv.urls || []).some(u => u.kind === 'lan')) {
    console.log('  (нет сетевого адреса — проверка ссылки пропущена)');
  } else {
    check(linkOk, 'ссылка-приглашение ведёт по IP сервера: ' + linkA);
  }
  const linkRow = await A.js(`(document.getElementById('lobbyLinks').textContent||'').length`);
  check(linkRow > 0, 'в лобби показан список адресов');

  const bTab = await newTab('http://127.0.0.1:' + PORT + '/game/?lobby=' + code);
  const B = await connect(bTab.webSocketDebuggerUrl);
  await sleep(6000);
  check(await B.js(`!document.getElementById('lobby').classList.contains('hidden')`), 'ссылка открыла лобби у гостя');
  await B.js(`document.getElementById('joinName').value='Гость'; document.getElementById('joinCode').value='${code}'; document.getElementById('lobbyJoin').click(); 1`);
  await sleep(1500);
  check(await B.js('window.Net.connected()'), 'гость подключился к релею');
  check(await B.js(`document.getElementById('lobbyLink').value.indexOf('127.0.0.1') < 0`),
    'у гостя ссылка тоже не на localhost: ' + await B.js(`document.getElementById('lobbyLink').value`));

  /* Оба жмут «Готов» именно кнопкой — как в жизни. */
  await A.send('Page.bringToFront');
  await A.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(600);
  check(await A.js(`document.getElementById('lobbyReady').textContent === 'Не готов'`),
    'кнопка хоста показывает «Не готов»');
  check(await A.js(`document.getElementById('lobbyPlayers').textContent.indexOf('Гость') >= 0`),
    'хост видит гостя в списке');
  await B.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(500);
  check(await A.js(`!document.getElementById('lobby').classList.contains('hidden')`),
    'после «Готов» обоих лобби ещё открыто: ждём кнопку хоста');
  check(await A.js(`!document.getElementById('lobbyStart').classList.contains('hidden') &&
    !document.getElementById('lobbyStart').disabled`),
    'у хоста доступна кнопка «Начать игру»');
  check(await B.js(`document.getElementById('lobbyStart').classList.contains('hidden')`),
    'у гостя кнопки старта нет');
  await A.js(`document.getElementById('lobbyStart').click(); 1`);
  await sleep(3500);

  check(await A.js(`document.getElementById('lobby').classList.contains('hidden')`),
    'у хоста экран лобби закрылся');
  check(await B.js(`document.getElementById('lobby').classList.contains('hidden')`),
    'у гостя экран лобби закрылся');

  const stA = await A.js(`(() => { const P=window.__game.Play; return {role:P.state.netRole, buildings:P.state.buildings.length, villagers:P.state.villagers.length, towns:P.state.world?P.state.world.towns.length:0}; })()`);
  const stB = await B.js(`(() => { const P=window.__game.Play; return {role:P.state.netRole, buildings:P.state.buildings.length, villagers:P.state.villagers.length, towns:P.state.world?P.state.world.towns.length:0}; })()`);
  check(!!stA && stA.role === 'host' && stA.towns === 2, 'хост в партии, городов 2: ' + (stA && stA.role));
  check(!!stB && stB.role === 'client' && stB.towns === 2, 'гость в партии клиентом: ' + (stB && stB.role));
  const ownerA = await A.js('window.__game.Play.state.playerOwner');
  const ownerB = await B.js('window.__game.Play.state.playerOwner');
  check(ownerA === 0 && ownerB === 1, 'владельцы деревень: хост 0, гость 1 (' + ownerA + ', ' + ownerB + ')');
  check(stB.buildings === 6 && stB.villagers === 6, 'гость видит 6 построек и 6 жителей: ' + JSON.stringify(stB));
  check(stA.buildings === 6 && stA.villagers === 6, 'у хоста 6 построек и 6 жителей');

  /* Правило 2026-10-24: в сетевой партии всплывашек нет вовсе. Проверяем и
     стартовую весть лобби (она жила 4.2 с, а прошло 3.5 — без правила ещё
     висела бы), и прямой вызов Hud.toast: HUD на экране, игра не на паузе. */
  for (const [who, page, role] of [['хост', A, 'host'], ['гость', B, 'client']]) {
    const quiet = await page.js(`(() => {
      const before = document.querySelectorAll('#toasts .toast').length;
      window.Hud.toast('проверка: в сети всплывашек нет');
      return { before: before,
        after: document.querySelectorAll('#toasts .toast').length,
        hud: !document.getElementById('hud').classList.contains('hidden'),
        role: window.__game.Play.state.netRole };
    })()`);
    check(quiet && quiet.role === role && quiet.hud === true &&
      quiet.before === 0 && quiet.after === 0,
      'у ' + who + ' в сетевой партии всплывашек нет: ' + JSON.stringify(quiet));
  }
  /* Темп снимков и честный круг. Сжатие проверено выше на сыром SSE, здесь —
     что настоящая партия по-прежнему идёт 12,5 кадров в секунду и что число
     в бейдже берётся из сетевого стека (Resource Timing), а не из разницы
     performance.now() вокруг промиса: занятый кадром главный поток раньше
     показывал честные 20 мс как «420», и игрок шёл чинить интернет.
     Хост обязан быть на переднем плане: в скрытой вкладке браузер редеет
     кадры до раза в секунду — это ограничение браузера, а не сети. */
  await A.send('Page.bringToFront');
  await sleep(1200);
  /* Мир на эти секунды замирает: проверяем темп снимков, а не рождение
     жителя. Иначе добавленное время сдвигало бы состояние следующих
     проверок (размер снимка после рубки и F5). Снимки при стоящем мире
     идут из Play.tick так же, как при живом. */
  await A.js(`window.__game.Play.state.running=false; 1`);
  const pace = await B.js(`(async () => {
    const N = window.Net, P = window.__game.Play;
    let n = 0, last = 0, gaps = [];
    const off = N.on('snapshot', () => {
      n++;
      const t = performance.now();
      if (last) gaps.push(t - last);
      last = t;
    });
    const p = await N.ping();
    await new Promise(r => setTimeout(r, 2200));
    off();
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    return { n: n, gap: +avg.toFixed(1), ping: p.ms, by: p.measuredBy,
      wall: p.msWall, seq: P.state.netSeq, hidden: document.hidden };
  })()`);
  const hostPace = await A.js(`(() => {
    const P = window.__game.Play;
    return { hidden: document.hidden, every: +P.state.netEvery.toFixed(3),
      q: P.state.netQueue, gzip: P.state.netGzip, busy: P.state.netBusy };
  })()`);
  await A.js(`window.__game.Play.state.running=true; 1`);
  /* Порог не «ровно 12,5»: в headless хост рисует ~44 кадра в секунду, и
     снимок уходит раз в 80 мс по сетке кадров — это 10–11 в секунду. Ловим
     не точное число, а провал: в скрытой вкладке было ~1 снимок в секунду,
     то есть 2–4 за окно. */
  check(pace && pace.n >= 16,
    'хост шлёт 10–12 снимков в секунду: ' + (pace && pace.n) + ' за 2,2 с · хост ' +
    JSON.stringify(hostPace) + ' · гость ' + JSON.stringify({ hidden: pace && pace.hidden }));
  check(hostPace && hostPace.gzip === true,
    'браузер жмёт тело снимка: сервер подтвердил gzip (' +
    (hostPace && hostPace.gzip) + ')');
  check(pace && pace.gap > 40 && pace.gap < 250,
    'снимки идут ровно, а не пачками: ' + (pace && pace.gap) + ' мс между кадрами');
  check(pace && pace.ping < 200 && pace.by === 'network',
    'круг меряется по сетевому стеку: ' + (pace && pace.ping) + ' мс (' +
    (pace && pace.by) + '), на главном потоке было бы ' + (pace && pace.wall));
  /* Хост остаётся на переднем плане: дальше проверяются движение жителей,
     бой, команды и F5, а в скрытой вкладке браузер редеет кадры до раза в
     секунду — тест ловил бы ограничение браузера, а не игру. */
  const camB = await B.js(`(() => {
    const P=window.__game.Play, th=P.state.world.towns[P.state.playerOwner].townhall;
    const c=P.renderer().cam;
    return {zoom:c.zoom, d:Math.hypot(c.x-th.x, c.y-th.y)};
  })()`);
  check(camB.zoom > 20 && camB.d < 10, 'камера гостя стоит на его ратуше: ' +
    camB.zoom.toFixed(0) + 'px, ' + camB.d.toFixed(1) + ' клетки');

  /* Общий план 192-й карты. Раньше здесь было два бага сразу: кадр больше
     400 000 клеток считался «испорченным», drawSeaTexture/drawWaterShimmer
     возвращались после ctx.save() без restore, и стек контекста рос на два
     состояния за кадр. Через минуту-две такого плана браузер начинал
     задыхаться, хост переставал успевать со снимками, а на карте объекты
     рисовались в масштабе кэша поверх огромного острова — «остров
     дублируется и фиксируется по середине». Проверяем не глазом, а стеком:
     сколько save — столько restore, и после кадра преобразование обычное. */
  const wide = await B.js(`(() => {
    const P=window.__game.Play, r=P.renderer();
    r.fitIsland();
    const ctx=r.ctx, os=ctx.save, or=ctx.restore;
    let saves=0, restores=0;
    ctx.save=function(){ saves++; return os.apply(this, arguments); };
    ctx.restore=function(){ restores++; return or.apply(this, arguments); };
    for(let i=0;i<3;i++) r.render(1);
    ctx.save=os; ctx.restore=or;
    const t=ctx.getTransform(), b=r.viewTiles(2);
    return {zoom:r.cam.zoom, min:r.minZoom, saves:saves, restores:restores,
      a:t.a, e:t.e, f:t.f, dpr:r.dpr, css:[r.cssW,r.cssH],
      area:(b.x1-b.x0)*(b.y1-b.y0)};
  })()`);
  check(wide && Math.abs(wide.zoom - wide.min) < 0.001,
    'гость отдалился до общего плана: ' + (wide && wide.zoom.toFixed(2)) +
    ' при пределе ' + (wide && wide.min.toFixed(2)) + ', кадр ' +
    (wide && Math.round(wide.area)) + ' клеток');
  check(wide && wide.saves === wide.restores,
    'общий план не копит состояния контекста: save ' + (wide && wide.saves) +
    ' / restore ' + (wide && wide.restores));
  check(wide && Math.abs(wide.a - wide.dpr) < 1e-6 &&
    Math.abs(wide.e - wide.css[0] * wide.dpr / 2) < 1 &&
    Math.abs(wide.f - wide.css[1] * wide.dpr / 2) < 1,
    'после общего плана преобразование кадра обычное, а не масштаб кэша: ' +
    JSON.stringify(wide && [wide.a, wide.e, wide.f]));
  /* Вернуть камеру гостю на его деревню — дальше проверяется игра, а не вид. */
  await B.js(`(() => { const P=window.__game.Play, r=P.renderer();
    const th=P.state.world.towns[P.state.playerOwner].townhall;
    r.cam.zoom=42; r.centerOn(th.x+1.5, th.y+1.5); r.render(1); return 1; })()`);

  /* Формат снимка: убранное — битовая карта, а не растущий массив. */
  const proto = await A.js(`(() => {
    const P=window.__game.Play;
    const s=window.Serialize.world(P.state.world,P.state.buildings,P.state.villagers,{seq:7});
    return {json:JSON.stringify(s).length, removed:typeof s.removed,
      total:s.objectTotal, objects:P.state.world.objects.length, seq:s.seq};
  })()`);
  check(proto.removed === 'string' && proto.total > 1000 && proto.json < 10000,
    'снимок компактный: ' + proto.json + ' Б, убранное — битовая карта на ' + proto.total);
  const protoB = await B.js(`(() => {
    const P=window.__game.Play, w=P.state.world;
    return {seq:P.state.netSeq, total:w.objectTotal, removed:w.removedIds.length,
      sig:typeof w._removedSig, objects:w.objects.length};
  })()`);
  check(protoB.seq > 0 && protoB.total === proto.total && protoB.sig === 'string',
    'гость принял нумерованный снимок и битовую карту: seq ' + protoB.seq);

  /* Сверка, а не пересоздание: выбранный житель и постройка остаются теми же
     объектами между снимками. Иначе выбор и открытая панель сбрасывались бы
     10 раз в секунду. */
  const ident = await B.js(`(async () => {
    const P=window.__game.Play, r=P.renderer();
    const v=P.state.villagers[0], b=P.state.buildings[0];
    P.setFocus(v); r.selected=b;
    const mm0=r.minimapVersion;
    await new Promise(res=>setTimeout(res,500));
    return {sameV:v===P.state.villagers.find(x=>x.id===v.id),
      sameB:b===P.state.buildings.find(x=>x.id===b.id),
      focus:P.state.focus===v, selected:r.selected===b,
      mm0:mm0, mm1:r.minimapVersion};
  })()`);
  check(ident.sameV && ident.sameB && ident.focus && ident.selected,
    'снимок сверяется по id: житель, постройка, выбор и фокус те же');
  check(ident.mm1 - ident.mm0 <= 1,
    'обзор не пересобирается на каждый снимок: ' + ident.mm0 + ' -> ' + ident.mm1);

  /* Движение жителя: хост шагает, гость обязан увидеть ту же клетку. */
  const moved = await A.js(`(() => {
    const P=window.__game.Play;
    for(let i=0;i<30;i++) P.tick(0.1);
    P.state.running=false;
    const v=P.state.villagers[0];
    return {x:v.x,y:v.y};
  })()`);
  await sleep(800);
  const movedB = await B.js(`(() => { const v=window.__game.Play.state.villagers[0]; return {x:v.x,y:v.y}; })()`);
  check(moved && movedB && Math.abs(moved.x-movedB.x) < 0.05 && Math.abs(moved.y-movedB.y) < 0.05,
    'движение жителя доехало до гостя: ' + JSON.stringify(moved) + ' / ' + JSON.stringify(movedB));

  /* Бой: хост бьёт своего жителя чужим воином, гость обязан увидеть HP. */
  const fight = await A.js(`(() => {
    const P=window.__game.Play, V=window.Villagers, w=P.state.world;
    P.state.running=true;
    const victim=P.state.villagers.find(v=>v && !v.warrior);
    if(!victim) return null;
    const foe=V.create(w,{index:900,x:victim.x+1.1,y:victim.y,buildings:P.state.buildings,avoid:[]});
    foe.owner=1; foe.warrior=true; foe.state='patrol';
    foe.x=victim.x+1.0; foe.y=victim.y; foe.hidden=false; foe.emergeT=0; foe.state='patrol';
    foe.target=victim; foe.combatMode='attack';
    P.state.villagers.push(foe);
    for(let i=0;i<90;i++) P.tick(1/60);
    P.state.running=false;
    return {hp:victim.hp,max:victim.maxHp,until:victim.hpUntil,id:victim.id};
  })()`);
  await sleep(900);
  const fightB = await B.js(`(() => { const v=window.__game.Play.state.villagers.find(x=>x.id===${fight ? fight.id : -1}); return v ? {hp:v.hp,max:v.maxHp,until:v.hpUntil} : null; })()`);
  check(!!fight && fight.hp < fight.max, 'хост нанёс урон: ' + JSON.stringify(fight));
  check(!!fightB && fightB.hp === fight.hp && fightB.max === fight.max,
    'HP и полоса доехали до гостя: ' + JSON.stringify(fightB));

  const added = await A.js(`(() => {
    const P=window.__game.Play,B=window.Buildings;
    const spot=B.findSpot(P.state.world,P.state.buildings,'a',B.FACE_ROT,{type:'house',minSep:0});
    if(!spot) return null;
    spot.id='p0:test';
    B.settle(P.state.world,spot,{clear:true}); P.state.buildings.push(spot); P.renderer().setBuildings(P.state.buildings);
    return P.state.buildings.length;
  })()`);
  await sleep(900);
  const bAfter = await B.js(`window.__game.Play.state.buildings.length`);
  check(added === 7 && bAfter === 7, 'постройка хоста доехала до гостя: ' + added + ' -> ' + bAfter);

  /* Обратный поток: гость просит поставить дом, хост проверяет, списывает
     брёвна и ставит. Цену назначает хост, а не клиент. */
  const purse = await A.js(`(() => {
    const P=window.__game.Play;
    P.state.world.towns[1].logs = 100;
    return P.state.world.towns[1].logs;
  })()`);
  await sleep(500);
  const cmd = await B.js(`(() => {
    const P=window.__game.Play,B=window.Buildings;
    const spot=B.findSpot(P.state.world,P.state.buildings,'a',B.FACE_ROT,{type:'house',minSep:0});
    if(!spot) return null;
    window.Net.command({type:'build',buildingType:'house',variant:'a',rot:B.FACE_ROT,x:spot.x,y:spot.y});
    return {x:spot.x,y:spot.y};
  })()`);
  await sleep(1000);
  const afterCmd = await A.js(`(() => { const P=window.__game.Play; return {
    buildings:P.state.buildings.length, logs:P.state.world.towns[1].logs}; })()`);
  const bAfterCmd = await B.js(`window.__game.Play.state.buildings.length`);
  check(!!cmd && afterCmd.buildings === 8 && bAfterCmd === 8,
    'команда гостя поставила дом у обоих: ' + afterCmd.buildings + ' / ' + bAfterCmd);
  check(purse === 100 && afterCmd.logs === 88,
    'дом гостя списал 12 брёвен у его деревни: ' + afterCmd.logs);

  /* Правка клиента: «Применить» после переноса обязано уехать хосту
     командой move. Раньше клиент закрывал режим молча, и следующий снимок
     возвращал дом на старое место. */
  const moveCmd = await B.js(`(() => {
    const P=window.__game.Play, B=window.Buildings, w=P.state.world;
    const b=P.state.buildings.find(x=>B.typeOf(x)==='house' && (x.owner||0)===1);
    if (!b) return null;
    const orig=B.snapshot(b);
    let spot=null;
    const offs=[[2,0],[0,2],[2,2],[-2,0],[0,-2],[2,-2],[3,0],[0,3],[3,3],[-3,0]];
    for (const [dx,dy] of offs) {
      const c=B.checkAt(w,P.state.buildings,b,{x:b.x+dx,y:b.y+dy});
      if (c.ok) { spot={x:b.x+dx,y:b.y+dy}; break; }
    }
    if (!spot) return null;
    P.state.edit={building:b,orig:orig,mode:'move',changed:true,valid:true,reason:''};
    P.renderer().editing=b;
    B.setSpot(w,b,{x:spot.x,y:spot.y});
    P.renderer().invalidateOrder();
    const res=P.editAction('apply');
    return {id:b.id,orig:[orig.x,orig.y],x:spot.x,y:spot.y,res:res};
  })()`);
  await sleep(900);
  const movedHost = await A.js(`(() => {
    const P=window.__game.Play;
    const b=P.state.buildings.find(x=>x.id===${JSON.stringify(moveCmd && moveCmd.id)});
    return b ? [b.x,b.y] : null;
  })()`);
  const movedClient = await B.js(`(() => {
    const P=window.__game.Play;
    const b=P.state.buildings.find(x=>x.id===${JSON.stringify(moveCmd && moveCmd.id)});
    return b ? [b.x,b.y] : null;
  })()`);
  check(!!moveCmd && moveCmd.res.ok && movedHost &&
    movedHost[0]===moveCmd.x && movedHost[1]===moveCmd.y &&
    movedClient && movedClient[0]===moveCmd.x && movedClient[1]===moveCmd.y,
    '«Применить» после переноса доехало до хоста: ' +
      JSON.stringify(moveCmd && [moveCmd.orig, [moveCmd.x,moveCmd.y]]) + ' -> ' +
      JSON.stringify(movedHost) + ' / ' + JSON.stringify(movedClient));

  /* Поворот клиента — отдельная команда; после неё на клиенте должно быть
     то же, что у хоста.

     С 2026-10-26 поворот проверяет место так же, как перенос: дом нельзя
     развернуть в клетку жителя или так, чтобы запереть выход. Сценарий
     проверяет ДОСТАВКУ команды, поэтому дом гостя заранее переносится (на
     хосте) на место, где законны оба угла, а жители уводятся из пятна.
     Правила расстановки сторожат regress.js/place.js, не эта приёмка. */
  const rotSpot = await A.js(`(() => {
    const P=window.__game.Play, B=window.Buildings, st=P.state;
    const b=st.buildings.find(x=>(x.owner||0)===1 && B.typeOf(x)==='house');
    if (!b) return null;
    for (const v of st.villagers) {
      if ((v.owner||0)!==1) continue;
      v.x=Math.max(1.5, Math.min(st.world.width-2.5, b.x+20.5));
      v.y=Math.max(1.5, Math.min(st.world.height-2.5, b.y+20.5));
      v.path=null;
    }
    let spot=null;
    for (let r=2;r<=14&&!spot;r++) for (let dy=-r;dy<=r&&!spot;dy++) for (let dx=-r;dx<=r;dx++) {
      if (Math.max(Math.abs(dx),Math.abs(dy))!==r) continue;
      const x=b.x+dx, y=b.y+dy;
      const a=B.checkAt(st.world, st.buildings, b, {x:x,y:y,rot:b.rot});
      const c=B.checkAt(st.world, st.buildings, b, {x:x,y:y,rot:(b.rot+90)%360});
      if (a.ok && c.ok) { spot={x:x,y:y}; break; }
    }
    if (spot) { B.setSpot(st.world,b,spot); B.touch(st.world); P.renderer().setBuildings(st.buildings); }
    return spot ? {id:b.id, x:spot.x, y:spot.y} : null;
  })()`);
  await sleep(700);
  const rotCmd = await B.js(`(() => {
    const P=window.__game.Play, B=window.Buildings;
    const b=P.state.buildings.find(x=>(x.owner||0)===1 && B.typeOf(x)==='house');
    if (!b) return null;
    const orig=B.snapshot(b);
    P.state.edit={building:b,orig:orig,mode:'idle',changed:false,valid:true,reason:''};
    P.renderer().editing=b;
    const res=P.editAction('rotate');
    return {id:b.id, rot:orig.rot, res:res};
  })()`);
  await sleep(900);
  const rotHost = await A.js(`(() => {
    const P=window.__game.Play;
    const b=P.state.buildings.find(x=>x.id===${JSON.stringify(rotCmd && rotCmd.id)});
    return b ? b.rot : null;
  })()`);
  const rotClient = await B.js(`(() => {
    const P=window.__game.Play;
    const b=P.state.buildings.find(x=>x.id===${JSON.stringify(rotCmd && rotCmd.id)});
    return b ? b.rot : null;
  })()`);
  check(!!rotCmd && rotCmd.res.ok && rotHost === (rotCmd.rot + 90) % 360 &&
    rotClient === rotHost,
    'поворот клиента доехал до хоста: ' + (rotCmd ? rotCmd.rot : '?') + ' -> ' +
      rotHost + ' / ' + rotClient);

  /* --- войска в сети: у каждого своя дружина (правило 2026-10-24) ---------
   *
   * Заказчик: «у всех участников лобби во вкладке войско показывается войско
   * хоста, и они не могут управлять своим войском». Панель собирала группы
   * с жёстким owner 0, поэтому гость видел дружину хоста; приказ по чужому id
   * хост отклонял, и своим войском гость не управлял вовсе. Здесь у каждого
   * свой лагерь и свои воины: панель обязана показать только своё, а приказ
   * гостя — дойти до его воина и не тронуть хозяйского. */
  const squadSetup = await A.js(`(() => {
    const P=window.__game.Play, B=window.Buildings, V=window.Villagers, w=P.state.world;
    /* Воин-враг из проверки боя выше — без лагеря и двора. Убираем его, чтобы
       в «Без места» не было случайной строки и счёт был ровно нашим. */
    P.state.villagers=P.state.villagers.filter(v =>
      !(v && v.warrior && (v.owner===undefined?0:v.owner)===1 && !v.warcamp && !v.station));
    function putCamp(owner,id){
      const th=w.towns[owner] && w.towns[owner].townhall;
      if(!th) return null;
      const c=B.findSpot(w,P.state.buildings,'x',B.FACE_ROT,
        {type:'warcamp',center:{x:th.x+1.5,y:th.y+1.5},ideal:7,range:16,minSep:4});
      if(!c) return null;
      c.owner=owner; c.town=owner; c.id=id;
      B.settle(w,c,{clear:true});
      P.state.buildings.push(c);
      if(w.towns[owner]) w.towns[owner].buildings.push(c);
      return c;
    }
    function putWarrior(owner,camp,id){
      const pc=B.patrolCells(camp);
      const v=V.create(w,{index:id,id:id,owner:owner,town:owner,
        x:pc[0].x+0.5,y:pc[0].y+0.5,buildings:P.state.buildings,avoid:[]});
      v.warrior=true; v.warcamp=camp; v.state='patrol';
      P.state.villagers.push(v);
      if(w.towns[owner]) w.towns[owner].villagers.push(v);
      return v;
    }
    const hostCamp=putCamp(0,'p0:b9000');
    const guestCamp=putCamp(1,'p1:b9001');
    if(!hostCamp || !guestCamp) return null;
    const h1=putWarrior(0,hostCamp,9001), h2=putWarrior(0,hostCamp,9002);
    const g1=putWarrior(1,guestCamp,9003);
    w._buildings=P.state.buildings; w._villagers=P.state.villagers;
    P.renderer().setBuildings(P.state.buildings);
    P.renderer().setVillagers(P.state.villagers);
    P.state.netForce=true;
    return {hostIds:[h1.id,h2.id], guestIds:[g1.id],
      hostCamp:[hostCamp.x,hostCamp.y], guestCamp:[guestCamp.x,guestCamp.y]};
  })()`);
  check(!!squadSetup && squadSetup.hostIds.length === 2 &&
    squadSetup.guestIds.length === 1,
    'у каждого игрока свой лагерь и свои воины: ' + JSON.stringify(squadSetup));
  await sleep(1400);
  const squadSeen = await B.js(`(() => {
    const P=window.__game.Play;
    return {camp:!!P.state.buildings.find(b=>b.id==='p1:b9001'),
      hostCamp:!!P.state.buildings.find(b=>b.id==='p0:b9000'),
      warrior:!!P.state.villagers.find(v=>v.id===9003),
      hostWarriors:P.state.villagers.filter(v=>v.warrior &&
        (v.owner===undefined?0:v.owner)===0 && v.warcamp && v.warcamp.id==='p0:b9000').length};
  })()`);
  check(squadSeen.camp && squadSeen.hostCamp && squadSeen.warrior &&
    squadSeen.hostWarriors === 2,
    'оба лагеря и воины доехали до гостя: ' + JSON.stringify(squadSeen));

  const panelGuest = await B.js(`(() => {
    const P=window.__game.Play;
    window.__game.Hud.toggleSquad();
    window.__game.Hud.tick(0.3);
    const rows=[...document.querySelectorAll('#squadList .squad-row')];
    return {owner:P.state.playerOwner,
      open:!document.getElementById('squadPanel').classList.contains('hidden'),
      rows:rows.length,
      names:rows.map(r=>r.querySelector('.squad-name').textContent),
      slots:document.getElementById('squadSlots').textContent,
      note:document.getElementById('squadNote').textContent,
      ids:P.state.squadIds.slice()};
  })()`);
  check(panelGuest.open && panelGuest.owner === 1 && panelGuest.rows === 1 &&
    panelGuest.names[0].indexOf('Лагерь') === 0 &&
    panelGuest.slots === 'воины 1' && panelGuest.note === 'Выбрано 1 из 1' &&
    panelGuest.ids.length === 1 && panelGuest.ids[0] === 9003,
    'гость видит только свою дружину: ' + JSON.stringify(panelGuest));

  const panelHost = await A.js(`(() => {
    const P=window.__game.Play;
    window.__game.Hud.toggleSquad();
    window.__game.Hud.tick(0.3);
    const rows=[...document.querySelectorAll('#squadList .squad-row')];
    return {owner:P.state.playerOwner, rows:rows.length,
      names:rows.map(r=>r.querySelector('.squad-name').textContent),
      slots:document.getElementById('squadSlots').textContent,
      ids:P.state.squadIds.slice().sort((a,b)=>a-b)};
  })()`);
  check(panelHost.owner === 0 && panelHost.rows === 1 &&
    panelHost.slots === 'воины 2' &&
    JSON.stringify(panelHost.ids) === JSON.stringify([9001,9002]),
    'хост видит только свою дружину: ' + JSON.stringify(panelHost));

  /* Приказ гостя: панель кладёт в state.order СВОИХ воинов, команда несёт их
     id, хост проверяет владельца и двигает только их. */
  await B.js(`document.getElementById('squadOrder').click(); 1`);
  check(await B.js(`!!window.__game.Play.state.order`),
    'гость включил приказ для своего отряда');
  const gc = squadSetup.guestCamp;
  await B.js(`window.__game.Play.orderAt({x:${gc[0] + 4}, y:${gc[1] + 4}}); 1`);
  await sleep(1000);
  const guestOrderOnHost = await A.js(`(() => {
    const P=window.__game.Play;
    function one(id){ const v=P.state.villagers.find(x=>x.id===id);
      return v ? !!v.order : null; }
    return {host:[${squadSetup.hostIds.join(',')}].map(one), guest:one(9003)};
  })()`);
  check(guestOrderOnHost.guest === true &&
    guestOrderOnHost.host.every(o => o === false),
    'приказ гостя дошёл только до его воина: ' + JSON.stringify(guestOrderOnHost));

  await B.js(`document.getElementById('squadStop').click(); 1`);
  await sleep(900);
  const guestStopOnHost = await A.js(`(() => {
    const P=window.__game.Play;
    return [9001,9002,9003].map(id => {
      const v=P.state.villagers.find(x=>x.id===id);
      return v ? !!v.order : null;
    });
  })()`);
  check(JSON.stringify(guestStopOnHost) === JSON.stringify([false,false,false]),
    '«Стоп» гостя снял приказ только у его воина: ' + JSON.stringify(guestStopOnHost));

  /* И наоборот: приказ хоста не трогает дружину гостя. */
  await A.js(`document.getElementById('squadOrder').click(); 1`);
  const hc = squadSetup.hostCamp;
  await A.js(`window.__game.Play.orderAt({x:${hc[0] + 4}, y:${hc[1] + 4}}); 1`);
  await sleep(900);
  const hostOrderOnHost = await A.js(`(() => {
    const P=window.__game.Play;
    function one(id){ const v=P.state.villagers.find(x=>x.id===id);
      return v ? !!v.order : null; }
    return {host:[9001,9002].map(one), guest:one(9003)};
  })()`);
  check(hostOrderOnHost.host.every(o => o === true) &&
    hostOrderOnHost.guest === false,
    'приказ хоста не тронул дружину гостя: ' + JSON.stringify(hostOrderOnHost));
  await A.js(`document.getElementById('squadStop').click(); 1`);
  await sleep(700);
  const hostStopOnHost = await A.js(`(() => {
    const P=window.__game.Play;
    return [9001,9002,9003].map(id => {
      const v=P.state.villagers.find(x=>x.id===id);
      return v ? !!v.order : null;
    });
  })()`);
  check(JSON.stringify(hostStopOnHost) === JSON.stringify([false,false,false]),
    '«Стоп» хоста снял приказ только у его воинов: ' + JSON.stringify(hostStopOnHost));
  await A.js(`document.getElementById('squadClose').click(); 1`);
  await B.js(`document.getElementById('squadClose').click(); 1`);

  /* Долгая партия: сотни срубленных/смятых объектов не должны раздувать
     снимок и не должны стирать остров на клиенте. Раньше каждый снимок тащил
     весь список убранного массивом, а клиент пересобирал обзор. */
  const heavy = await A.js(`(() => {
    const P=window.__game.Play, w=P.state.world;
    const doomed=w.objects.filter(o=>o.kind==='tree').slice(0,500);
    for(const o of doomed) if(w.removedIds) w.removedIds.push(o.id);
    const gone=new Set(doomed.map(o=>o.id));
    w.objects=w.objects.filter(o=>!gone.has(o.id));
    return {removed:w.removedIds.length, objects:w.objects.length};
  })()`);
  await sleep(900);
  const heavySnap = await A.js(`(() => {
    const P=window.__game.Play;
    const s=window.Serialize.world(P.state.world,P.state.buildings,P.state.villagers,{seq:P.state.netSeq+1});
    return {json:JSON.stringify(s).length, removed:s.removed.length, total:s.objectTotal};
  })()`);
  /* Предел — 8 КБ, а не 7: проверка про то, что снимок НЕ РАСТЁТ от рубки
     (hex-карта фиксированной длины), а не про конкретные байты. 500 номеров
     старым массивом добавили бы ~2,5 КБ и всё равно не прошли бы. Запас
     нужен потому, что число жителей и знаков в координатах гуляет от сида. */
  check(heavySnap.json < 8000,
    'после 500 срубленных снимок остаётся компактным: ' + heavySnap.json + ' Б');
  const heavyB = await B.js(`(() => {
    const P=window.__game.Play, w=P.state.world, r=P.renderer();
    const th=w.towns[P.state.playerOwner].townhall, px=r.cachePx, off=r.cacheOffset;
    const cxx=(th.x+1.5)-(th.y+1.5), cyy=(th.x+1.5)+(th.y+1.5);
    const x=Math.round(cxx*0.5*px+off.x), y=Math.round(cyy*0.25*px+off.y);
    const d=r.cache.getContext('2d').getImageData(x,y,1,1).data;
    return {objects:w.objects.length, removed:w.removedIds.length, pixel:[d[0],d[1],d[2],d[3]]};
  })()`);
  check(heavyB.objects === heavy.objects && heavyB.removed === heavy.removed,
    'рубка доехала до гостя: ' + heavyB.objects + ' объектов, ' + heavyB.removed + ' убрано');
  check(heavyB.pixel[1] > heavyB.pixel[2] && heavyB.pixel[3] > 0,
    'остров на клиенте на месте, а не только вода: ' + JSON.stringify(heavyB.pixel));

  /* Браузер выбросил поверхность кэша земли — гость не должен остаться с
     одной водой. Проверка сначала честно делает холст пустым, потом игра
     обязана заметить это и перерисовать остров. */
  const restored = await B.js(`(() => {
    const P=window.__game.Play, r=P.renderer();
    const g=r.cache.getContext('2d');
    g.clearRect(0,0,r.cache.width,r.cache.height);
    const blank=r.cacheLooksBlank();
    const fixed=P.checkCache();
    const th=P.state.world.towns[P.state.playerOwner].townhall, px=r.cachePx, off=r.cacheOffset;
    const x=Math.round(((th.x+1.5)-(th.y+1.5))*0.5*px+off.x);
    const y=Math.round(((th.x+1.5)+(th.y+1.5))*0.25*px+off.y);
    const d=r.cache.getContext('2d').getImageData(x,y,1,1).data;
    return {blank:blank, fixed:fixed, pixel:[d[0],d[1],d[2],d[3]]};
  })()`);
  check(restored.blank === true && restored.fixed === true &&
    restored.pixel[3] > 0 && restored.pixel[1] > restored.pixel[2],
    'пустой кэш земли распознан и остров перерисован: ' + JSON.stringify(restored));

  /* F5 у гостя: страница не должна выкинуть в меню. Сессия (код+токен)
     лежит в localStorage этой вкладки, бут сам поднимает партию. */
  const guestBefore = await B.js(`(() => { const P=window.__game.Play; return {
    role:P.state.netRole, owner:P.state.playerOwner,
    buildings:P.state.buildings.length, villagers:P.state.villagers.length,
    logs:P.state.world.towns[P.state.playerOwner].logs }; })()`);
  await B.send('Page.reload', { ignoreCache: true });
  await sleep(9000);
  const guestAfter = await B.js(`(() => { const P=window.__game.Play; return {
    role:P.state.netRole, owner:P.state.playerOwner,
    buildings:P.state.buildings.length, villagers:P.state.villagers.length,
    logs:P.state.world.towns[P.state.playerOwner].logs,
    lobby:document.getElementById('lobby').classList.contains('hidden'),
    mode:P.state.mode, running:P.state.running }; })()`);
  check(guestAfter && guestAfter.role === 'client' && guestAfter.owner === 1 &&
    guestAfter.lobby === true && guestAfter.mode === 'play' &&
    guestAfter.buildings === guestBefore.buildings &&
    guestAfter.villagers === guestBefore.villagers,
    'F5 у гостя возвращает в ту же партию: ' + JSON.stringify(guestAfter));

  /* И после F5 гость снова МОЖЕТ строить. Раньше номер команды начинался с
     единицы заново, а хост помнил старые номера и молча отбрасывал новые как
     повтор: дом не появлялся уже никогда. Теперь n растёт по часам. */
  await A.js(`window.__game.Play.state.world.towns[1].logs = 200; 1`);
  await sleep(500);
  const reBefore = await B.js(`window.__game.Play.state.buildings.length`);
  const reBuild = await B.js(`(() => {
    const P = window.__game.Play, B = window.Buildings;
    const spot = B.findSpot(P.state.world, P.state.buildings, 'a', B.FACE_ROT,
      { type: 'house', minSep: 0 });
    if (!spot) return null;
    P.renderer().hover = { x: spot.x, y: spot.y };
    P.beginBuild('house');
    const res = P.buildAction('place');
    return { ok: !!(res && res.pending), spot: [spot.x, spot.y] };
  })()`);
  await sleep(1800);
  const reAfterHost = await A.js(`window.__game.Play.state.buildings.length`);
  const reAfterGuest = await B.js(`window.__game.Play.state.buildings.length`);
  check(!!reBuild && reBuild.ok && reAfterHost === reBefore + 1 &&
    reAfterGuest === reAfterHost,
    'после F5 гость снова строит: ' + reBefore + ' -> ' +
      reAfterHost + ' / ' + reAfterGuest);

  /* F5 у хоста: мир поднимается из последнего снимка, а не начинается заново.
     Перед снимком «до» замораживаем мир: иначе житель успеет свалить дерево
     между меркой и перезагрузкой, и сравнение «объектов столько же» будет
     ловить не поломку F5, а честную рубку. Снимки при замороженном мире
     продолжают идти из Play.tick. */
  await A.js(`window.__game.Play.state.running=false; 1`);
  await sleep(1200);
  const hostBefore = await A.js(`(() => {
    const P=window.__game.Play, B=window.Buildings;
    const mark=P.state.buildings.find(x=>(x.owner||0)===1 && B.typeOf(x)==='house');
    return {
      role:P.state.netRole, buildings:P.state.buildings.length,
      villagers:P.state.villagers.length, removed:P.state.world.removedIds.length,
      removedUnique:new Set(P.state.world.removedIds).size,
      seed:P.state.world.seed, size:P.state.world.islandSize,
      total:P.state.world.objectTotal,
      logs:P.state.world.towns[P.state.playerOwner].logs,
      seconds:P.state.seconds, objects:P.state.world.objects.length,
      marker:mark ? [mark.id,mark.x,mark.y,mark.rot] : null }; })()`);
  await A.send('Page.reload', { ignoreCache: true });
  /* Ждём не «одиннадцать секунд», а готовность партии, и сразу замораживаем:
     иначе за это время успевают пройти несколько шагов мира. */
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await A.js(`!!(window.__game && window.__game.Play &&
      window.__game.Play.state.mode === 'play' && window.__game.Play.state.netRole)`);
    if (ready) break;
  }
  await A.js(`if (window.__game && window.__game.Play.state) window.__game.Play.state.running=false; 1`);
  const hostAfter = await A.js(`(() => {
    const P=window.__game.Play, B=window.Buildings;
    const mark=P.state.buildings.find(x=>(x.owner||0)===1 && B.typeOf(x)==='house');
    return {
      role:P.state.netRole, buildings:P.state.buildings.length,
      villagers:P.state.villagers.length, removed:P.state.world.removedIds.length,
      removedUnique:new Set(P.state.world.removedIds).size,
      seed:P.state.world.seed, size:P.state.world.islandSize,
      total:P.state.world.objectTotal,
      logs:P.state.world.towns[P.state.playerOwner].logs,
      seconds:P.state.seconds, objects:P.state.world.objects.length,
      lobby:document.getElementById('lobby').classList.contains('hidden'),
      mode:P.state.mode, running:P.state.running, seq:P.state.netSeq,
      marker:mark ? [mark.id,mark.x,mark.y,mark.rot] : null }; })()`);
  check(hostAfter && hostAfter.role === 'host' && hostAfter.lobby === true &&
    hostAfter.mode === 'play' && hostAfter.buildings === hostBefore.buildings &&
    hostAfter.villagers >= 5 &&
    hostAfter.removed === hostBefore.removed &&
    hostAfter.objects === hostBefore.objects &&
    JSON.stringify(hostAfter.marker) === JSON.stringify(hostBefore.marker) &&
    hostAfter.logs >= hostBefore.logs && hostAfter.seconds >= hostBefore.seconds,
    'F5 у хоста поднимает мир из снимка, а не с нуля: ' +
      JSON.stringify(hostBefore) + ' -> ' + JSON.stringify(hostAfter));
  const guestBack = await B.js(`(() => { const P=window.__game.Play; return {
    running:P.state.running, lost:window.Hud.isNetLostShown(),
    role:P.state.netRole, buildings:P.state.buildings.length }; })()`);
  check(guestBack && guestBack.role === 'client' && guestBack.running === true &&
    guestBack.lost === false && guestBack.buildings === hostAfter.buildings,
    'после возврата хоста гость снова в игре: ' + JSON.stringify(guestBack));

  /* Хост ушёл: гость остаётся в партии, а не получает экран «выкинуло».
     Мир замирает (считать его некому) и остаётся на экране последним кадром;
     вместо итогового экрана — только бейдж «нет связи» (правило 2026-10-24:
     всплывашек в сети нет). Вернётся хост — игра продолжится, не вернётся —
     игрок сам откроет «Меню». */
  await A.js('window.Net.leave()');
  await sleep(900);
  const lost = await B.js(`(() => { const P=window.__game.Play; return {
    running:P.state.running, shown:window.Hud.isNetLostShown(),
    resultHidden:document.getElementById('result').classList.contains('hidden'),
    badge:document.getElementById('netBadge').textContent,
    toasts:document.querySelectorAll('#toasts .toast').length,
    title:document.getElementById('resultTitle').textContent}; })()`);
  check(lost.shown === true && lost.running === false && lost.resultHidden === true &&
    lost.toasts === 0 && /нет связи|хост/i.test(lost.badge),
    'потеря хоста не выкидывает в меню: мир на экране, бейдж «' +
    lost.badge + '», всплывашек 0, экран итога скрыт');

  /* Главный сценарий поломки: SSE не доставляет ничего (так вёл себя
     cloudflared). Лобби обязано ожить опросом: гость входит, оба жмут
     «Готов», партия начинается. */
  const dTab = await newTab('about:blank');
  const D = await connect(dTab.webSocketDebuggerUrl);
  await D.send('Page.navigate', { url: BASE + '/game/' });
  await sleep(6000);
  await D.js(`window.Lobby.open(); document.getElementById('lobbyName').value='Хост2'; document.getElementById('lobbyCreate').click(); 1`);
  await sleep(1200);
  const code2 = await D.js('window.Net.code()');
  check(!!code2, 'второе лобби создано: ' + code2);

  const cTab = await newTab('about:blank');
  const C = await connect(cTab.webSocketDebuggerUrl);
  await C.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__noSSE = true; window.EventSource = function (u) {' +
      ' this.url = u; this.close = function () {};' +
      ' this.addEventListener = function () {}; };'
  });
  await C.send('Page.navigate', { url: BASE + '/game/?lobby=' + code2 });
  await sleep(6000);
  check(await C.js('window.__noSSE === true'), 'у гостя SSE отключён намеренно');
  await C.js(`document.getElementById('joinName').value='БезСвязи'; document.getElementById('joinCode').value='${code2}'; document.getElementById('lobbyJoin').click(); 1`);
  await sleep(1500);
  check(await C.js(`!document.getElementById('lobbyWait').classList.contains('hidden')`),
    'гость без SSE попал в лобби (опрос)');
  await D.send('Page.bringToFront');
  await D.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(400);
  await C.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(500);
  await D.js(`document.getElementById('lobbyStart').click(); 1`);
  await sleep(4500);
  const noSse = await C.js(`(() => { const P=window.__game.Play; return {role:P.state.netRole, towns:P.state.world?P.state.world.towns.length:0, owner:P.state.playerOwner, sse:!!window.EventSource && !!window.__noSSE}; })()`);
  check(!!noSse && noSse.role === 'client' && noSse.towns === 2,
    'без SSE партия всё равно началась опросом: ' + JSON.stringify(noSse));
  check(!!noSse && noSse.sse === true, 'SSE у гостя правда не было');
  check(await C.js(`document.getElementById('lobby').classList.contains('hidden')`),
    'экран лобби у гостя без SSE закрылся');

  /* Итог партии в настоящей сети с живым SSE: ратуша гостя падает — хост
     видит «Победа», гость «Поражение». Раньше onDefeat был жёстко 1v1:
     owner 1 — «победа» хоста, а гости не получали итог вовсе. */
  const eTab = await newTab('about:blank');
  const E = await connect(eTab.webSocketDebuggerUrl);
  await E.send('Page.navigate', { url: BASE + '/game/' });
  await sleep(6000);
  await E.js(`window.Lobby.open(); document.getElementById('lobbyName').value='Хост-итог'; document.getElementById('lobbyCreate').click(); 1`);
  await sleep(1200);
  const code3 = await E.js('window.Net.code()');
  check(!!code3, 'лобби для проверки итога создано: ' + code3);

  const fTab = await newTab('about:blank');
  const F = await connect(fTab.webSocketDebuggerUrl);
  await F.send('Page.navigate', { url: BASE + '/game/?lobby=' + code3 });
  await sleep(6000);
  await F.js(`document.getElementById('joinName').value='Гость-итог'; document.getElementById('joinCode').value='${code3}'; document.getElementById('lobbyJoin').click(); 1`);
  await sleep(1500);
  await E.send('Page.bringToFront');
  await E.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(300);
  await F.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(400);
  await E.js(`document.getElementById('lobbyStart').click(); 1`);
  await sleep(4500);

  const hit = await E.js(`(() => {
    const P=window.__game.Play, C=window.Combat, V=window.Villagers, w=P.state.world;
    const th=w.towns[1].townhall;
    if(!th) return {err:'нет ратуши гостя'};
    th.hp=1;
    const cells=C.approachCells(w,th,th.x+1.5,th.y+1.5);
    let spot=null;
    for(const c of cells){ if(V.walkable(w,V.blockedMap(w,P.state.buildings),c.x,c.y)){spot=c;break;} }
    if(!spot) return {err:'нет подхода'};
    const v=V.create(w,{index:7100,id:7100,owner:0,town:0,
      x:spot.x+0.5,y:spot.y+0.5,buildings:P.state.buildings,avoid:[]});
    v.warrior=true; v.state='attack'; v.target=th; v.combatMode='attack';
    P.state.villagers.push(v); P.state.running=true;
    for(let i=0;i<8;i++) P.tick(0.1);
    return {over:P.state.over,winner:P.state.winner,result:P.state.result,
      alive:w.towns.map(t=>t.alive)};
  })()`);
  check(!!hit && hit.over === true && hit.winner === 0 && hit.result === 'win',
    'хост: падение ратуши гостя — победа и мир остановлен: ' + JSON.stringify(hit));
  await sleep(1400);
  const guestEnd = await F.js(`(() => { const P=window.__game.Play; return {
    over:P.state.over, winner:P.state.winner, result:P.state.result,
    shown:!document.getElementById('result').classList.contains('hidden'),
    title:document.getElementById('resultTitle').textContent,
    ownAlive:P.state.world.towns[P.state.playerOwner].alive }; })()`);
  check(!!guestEnd && guestEnd.over === true && guestEnd.result === 'lose' &&
    guestEnd.shown === true && guestEnd.title === 'Поражение' &&
    guestEnd.ownAlive === false,
    'гость получил «Поражение», а не замороженный кадр: ' + JSON.stringify(guestEnd));

  A.ws.close(); B.ws.close(); C.ws.close(); D.ws.close(); E.ws.close(); F.ws.close();
  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nМУЛЬТИПЛЕЕР ПРИНЯТ');
  killAll();
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('ошибка: ' + (e.stack || e));
  killAll();
  process.exit(1);
});
