#!/usr/bin/env node
/* run-scenario.js — один прогон одного сценария паспорта 4tox.
 *
 * Поднимает (или берёт готовый) сервер, НАСТОЯЩИЙ видимый Chrome, две
 * страницы (хост и гость), доводит их до партии теми же кнопками, что игрок,
 * включает внешнюю обвязку tools/probe.js и пишет сырые выборки в каталог
 * прогона.
 *
 * Примеры:
 *   node tools/run-scenario.js --scenario S1 --repo ../.. --out runs/S1/r1
 *   node tools/run-scenario.js --scenario S3 --repo ../.. --out runs/S3/r1 \
 *        --warmup 25 --measure 60
 *   node tools/run-scenario.js --scenario S5 --url https://vps.example/game/ ...
 *
 * Сценарии (по заданию):
 *   S1 — одиночная партия, одна видимая вкладка;
 *   S2 — хост+гость на одном ПК, два ВИДИМЫХ окна, localhost;
 *   S3 — хост+гость соседними вкладками, активна вкладка ГОСТЯ (хост скрыт);
 *   S4 — те же вкладки, активна вкладка ХОСТА (гость скрыт);
 *   S5 — как S2, но через VPS (--url);
 *   S6 — два устройства: этим инструментом НЕ воспроизводится (нужен второй
 *        компьютер). Скрипт печатает NOT RUN и выходит с кодом 3.
 *
 * Секретов не пишет: токен лобби живёт только в памяти процесса — он нужен,
 * чтобы спросить у сервера /api/stream-stats, и в файлы не попадает.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ------------------------------------------------------------ аргументы */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
function num(name, def) { const v = arg(name, def); return v === true ? def : Number(v); }

const SCEN = String(arg('scenario', 'S2'));
if (SCEN === 'S6') {
  console.log('NOT RUN: S6 требует второго устройства (хост и гость на разных машинах).');
  console.log('Инструкция — LIMITATIONS.md пакета.');
  process.exit(3);
}
const REPO = path.resolve(String(arg('repo', path.resolve(__dirname, '..', '..'))));
const OUT = path.resolve(String(arg('out', path.join('runs', SCEN, 'r1'))));
const WARMUP = num('warmup', 25);
const MEASURE = num('measure', 60);
const SEED_SOLO = arg('seed', null);
const SIZE = num('size', 192);
/* По умолчанию — headless=new. Это не «ускоренная симуляция», а тот же
   Chrome без окна на экране: проверено, что он воспроизводит и
   видимость вкладки (в фоне rAF = 0 кадров, таймер 200 мс — 1/с), и
   два независимых видимых окна (newWindow:true — оба visible и оба
   60 кадров/с). Окно на экране забирает фокус у человека за
   машиной — для длинного профилирования это недопустимо. */
const HEADLESS = !arg('headed', false);
const PROBE = String(arg('probe', 'on'));
const FRAMES = arg('frames', 'on') !== 'off';
const TRACE = !!arg('trace', false);
const URL_BASE = arg('url', null);
/* --label позволяет записать длинный прогон под своим именем (S7), не меняя
   логику сценария: сценарий остаётся, например, S2. */
const LABEL = String(arg('label', SCEN));
const RNG = num('rng', 20261027);
const VIEW = { w: num('view-w', 700), h: num('view-h', 773), dpr: num('dpr', 2) };

const PORT = num('port', 8800 + (process.pid % 90));
const CDP = num('cdp', 9200 + (process.pid % 90));
/* Второй браузер нужен только S2/S5: два видимых окна в одном headless-
   браузере ведут себя непредсказуемо (второе окно после входа гостя в лобби
   становится hidden — проверено). Два процесса дают ровно то, что описано в
   задании: два независимых видимых окна на одной машине. */
const CDP2 = CDP + 1;
const PROF = path.join(os.tmpdir(), 'dsh-4tox-passport-' + process.pid);
const PROF2 = PROF + '-b';
const BASE = URL_BASE ? String(URL_BASE).replace(/\/$/, '') : ('http://127.0.0.1:' + PORT);
const IS_REMOTE = !!URL_BASE;
/* Для удалённого прогона BASE — это адрес игры (…/game), а API живёт в корне
   сайта. Иначе /api/stream-stats искался бы в …/game/api/stream-stats. */
const API_BASE = IS_REMOTE ? (function () {
  try { return new URL(BASE).origin; } catch (e) { return BASE; }
})() : BASE;
/* Адрес самой игры: для локального сервера это …/game/, для удалённого —
   то, что передали в --url (он уже указывает на /game/). */
const GAME_URL = IS_REMOTE ? (BASE.endsWith('/') ? BASE : BASE + '/') : (BASE + '/game/');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));

fs.mkdirSync(OUT, { recursive: true });
const LOG = [];
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  LOG.push(line);
  process.stdout.write(line + '\n');
}

/* ------------------------------------------------------------------ http */
function getJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('не JSON: ' + b.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('таймаут')); });
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------- CDP-клиент */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message + ' (' + m.error.code + ')'));
      else resolve(m.result);
      return;
    }
    if (m.method) listeners.forEach(fn => { try { fn(m); } catch (e) {} });
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws: ' + e.message)); });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    const msg = { id: i, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('CDP таймаут: ' + method)); } }, 60000);
  });
  return { ws, send, on: fn => listeners.push(fn), close: () => { try { ws.close(); } catch (e) {} } };
}

function pageSession(cdp, sessionId) {
  const send = (m, p) => cdp.send(m, p, sessionId);
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r && r.exceptionDetails) {
      throw new Error('в странице: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r && r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = await js(expr); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('не дождались: ' + (label || expr) + ' за ' + ms + ' мс');
      await sleep(200);
    }
  };
  return { send, js, waitFor };
}

/* --------------------------------------------------------------- сборка */
const state = { server: null, chrome: null, chromes: [], cdp: null, pages: [], traces: [] };

function killAll() {
  for (const p of state.pages) { try { p.cdp.close(); } catch (e) {} }
  try { if (state.cdp) state.cdp.close(); } catch (e) {}
  try { if (state.cdp2) state.cdp2.close(); } catch (e) {}
  for (const c of state.chromes) {
    try { process.kill(-c.pid, 'SIGKILL'); } catch (e) { try { c.kill('SIGKILL'); } catch (e2) {} }
  }
  try { state.server && state.server.kill('SIGTERM'); } catch (e) {}
}
process.on('SIGINT', () => { killAll(); process.exit(130); });
process.on('uncaughtException', e => { log('ОШИБКА: ' + (e && e.stack || e)); killAll(); process.exit(1); });

async function startServer() {
  if (IS_REMOTE) return;
  /* Сервер запускается как есть; предзагрузка -r подменяет только
     Math.random, чтобы сид партии был одинаковым от прогона к прогону. */
  const preload = path.join(__dirname, 'deterministic-random.js');
  state.server = spawn(process.execPath,
    ['-r', preload, path.join(REPO, 'game/server/server.js'), '--port', String(PORT), '--no-upnp'], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PASSPORT_RNG: String(RNG) })
    });
  state.server.stdout.on('data', d => fs.appendFileSync(path.join(OUT, 'server.log'), d));
  state.server.stderr.on('data', d => fs.appendFileSync(path.join(OUT, 'server.log'), d));
  for (let i = 0; i < 200; i++) {
    try { await getJSON(BASE + '/api/server'); return; } catch (e) { await sleep(100); }
  }
  throw new Error('сервер не поднялся');
}

async function startChrome(tag) {
  const second = tag === 'B';
  const args = [
    '--remote-debugging-port=' + (second ? CDP2 : CDP),
    '--user-data-dir=' + (second ? PROF2 : PROF),
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-component-update', '--disable-background-networking',
    '--window-size=1280,820', '--window-position=60,40',
    '--enable-precise-memory-info',
    '--disable-session-crashed-bubble', '--hide-scrollbars',
    'about:blank'
  ];
  if (HEADLESS) args.unshift('--headless=new');
  const proc = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  state.chromes.push(proc);
  if (!second) state.chrome = proc;
  const port = second ? CDP2 : CDP;
  for (let i = 0; i < 200; i++) {
    try {
      const v = await getJSON('http://127.0.0.1:' + port + '/json/version');
      if (!second) state.version = v;
      return v;
    } catch (e) { await sleep(100); }
  }
  throw new Error('Chrome не поднялся' + (second ? ' (второй)' : ''));
}

async function newTarget(cdp, opts) {
  const r = await cdp.send('Target.createTarget', opts);
  const at = await cdp.send('Target.attachToTarget', { targetId: r.targetId, flatten: true });
  const p = pageSession(cdp, at.sessionId);
  p.targetId = r.targetId;
  p.sessionId = at.sessionId;
  return p;
}

/* Окно ставится явно: на macOS Chrome считает окно скрытым, если его
   перекрыли (document.hidden = true), поэтому два окна S2 разводятся по
   экрану, а не накладываются друг на друга. Это проверено опытом: два окна
   в одних и тех же координатах дают у второго hidden=false, а у первого —
   true, и хост перестаёт считать мир. */
async function setBounds(cdp, targetId, b) {
  try {
    const r = await cdp.send('Browser.getWindowForTarget', { targetId });
    await cdp.send('Browser.setWindowBounds', {
      windowId: r.windowId,
      bounds: { left: b.left, top: b.top, width: b.width, height: b.height, windowState: 'normal' }
    });
    return r.windowId;
  } catch (e) { log('окно не поставилось: ' + e.message); return null; }
}

async function openPage(cdp, url, opts) {
  opts = opts || {};
  let page;
  if (opts.reuseTargetId) {
    const at = await cdp.send('Target.attachToTarget', { targetId: opts.reuseTargetId, flatten: true });
    page = pageSession(cdp, at.sessionId);
    page.targetId = opts.reuseTargetId;
    page.sessionId = at.sessionId;
  } else {
    page = await newTarget(cdp, { url: 'about:blank', newWindow: !!opts.newWindow });
  }
  if (opts.bounds) page.windowId = await setBounds(cdp, page.targetId, opts.bounds);
  const errors = [];
  cdp.on(m => {
    if (m.sessionId !== page.sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push({ kind: 'exception', text: m.params.exceptionDetails.text,
        desc: (m.params.exceptionDetails.exception || {}).description });
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      errors.push({ kind: m.params.type,
        text: (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description).join(' ') });
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push({ kind: 'log', text: m.params.entry.text });
    }
  });
  page.errors = errors;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  /* Счётчики Chromium снаружи: работа главного потока, скрипты, GC-кучи.
     Нужны затем, чтобы измерить стоимость САМОЙ обвязки (режим --probe off
     не включает счётчики движка, а эти числа есть всегда). */
  await page.send('Performance.enable').catch(() => {});
  /* Кадр одинаковый во всех сценариях: 700 x 773 CSS, DPR 2 — как окно
     Chrome на Retina-ноутбуке после панели браузера. */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.w, height: VIEW.h, deviceScaleFactor: VIEW.dpr, mobile: false
  }).catch(() => {});
  const probeSrc = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: probeSrc });
  await page.send('Page.navigate', { url });
  return page;
}

async function windowOf(cdp, targetId) {
  try { const r = await cdp.send('Browser.getWindowForTarget', { targetId }); return r.windowId; }
  catch (e) { return null; }
}

/* --------------------------------------------------------------- сценарий */

async function startSolo(page) {
  const seed = SEED_SOLO || ('паспорт-' + SIZE);
  await page.waitFor("!!window.__game && !!window.__game.Play", 30000, 'загрузка игры');
  await page.waitFor("!document.getElementById('boot') || document.getElementById('boot').classList.contains('hidden')", 60000, 'заставка');
  await page.js(`window.__game.start(${JSON.stringify(seed)}, ${SIZE}, {mode:'solo'}); 1`);
  await page.waitFor("window.__game.Play.state.running === true", 60000, 'партия началась');
  await sleep(1500);
  return { seed, size: SIZE, players: 1 };
}

async function startLobby(cdp, host, guestPage) {
  await host.waitFor("!!window.__game && !!window.Lobby", 60000, 'загрузка игры у хоста');
  /* Ждём КОНЦА загрузки атласов. Это не придирка: если начать сетевую партию
     до того, как boot дошёл до startClock, мир создаётся, но rAF-цикл ещё не
     запущен — тиков нет вовсе (ловилось на проде: 109 МБ атласов едут по
     сети дольше, чем занимает лобби). */
  await host.waitFor("document.getElementById('boot').classList.contains('hidden')",
    240000, 'конец загрузки атласов у хоста');
  await host.js(`window.Lobby.open(); document.getElementById('lobbyName').value='Хост'; document.getElementById('lobbyCreate').click(); 1`);
  const code = await host.waitFor("window.Net && window.Net.code ? window.Net.code() : null", 20000, 'код лобби');
  const link = GAME_URL + '?lobby=' + code;

  const g = guestPage || await openPage(cdp, 'about:blank', { newWindow: false });
  await g.send('Page.navigate', { url: link });
  await g.waitFor("!!window.__game && !!window.Lobby", 60000, 'загрузка игры у гостя');
  await g.waitFor("document.getElementById('boot').classList.contains('hidden')",
    240000, 'конец загрузки атласов у гостя');
  await sleep(800);
  await g.js(`document.getElementById('joinName').value='Гость'; document.getElementById('joinCode').value=${JSON.stringify(code)}; document.getElementById('lobbyJoin').click(); 1`);
  await g.waitFor("document.getElementById('lobby').classList.contains('hidden') === false", 15000, 'лобби гостя');
  await sleep(600);
  const lobbyState = p => p.js(`(() => {
    const el = id => document.getElementById(id);
    const txt = id => (el(id) && el(id).textContent || '').trim().slice(0, 200);
    return { players: txt('lobbyPlayers'), hint: txt('lobbyHint'), note: txt('lobbyNote'),
      waitNote: txt('lobbyWaitNote'), net: txt('lobbyNet'), warn: txt('lobbyWarn'),
      startHidden: el('lobbyStart') ? el('lobbyStart').classList.contains('hidden') : null,
      startDisabled: el('lobbyStart') ? el('lobbyStart').disabled : null,
      readyText: el('lobbyReady') ? el('lobbyReady').textContent.trim() : null,
      connected: window.Net && window.Net.connected ? window.Net.connected() : null,
      canStart: window.Lobby && window.Lobby.canStart ? window.Lobby.canStart() : null };
  })()`);
  log('лобби хоста до готовности: ' + JSON.stringify(await lobbyState(host).catch(e => ({ err: e.message }))));
  log('лобби гостя до готовности: ' + JSON.stringify(await lobbyState(g).catch(e => ({ err: e.message }))));
  log('после входа гостя: хост ' + await host.js('document.visibilityState') + ', гость ' + await g.js('document.visibilityState'));
  await host.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(500);
  await g.js(`document.getElementById('lobbyReady').click(); 1`);
  await sleep(800);
  log('лобби хоста после готовности: ' + JSON.stringify(await lobbyState(host).catch(e => ({ err: e.message }))));
  log('лобби гостя после готовности: ' + JSON.stringify(await lobbyState(g).catch(e => ({ err: e.message }))));
  log('после готовности: хост ' + await host.js('document.visibilityState') + ', гость ' + await g.js('document.visibilityState'));
  await host.js(`document.getElementById('lobbyStart').click(); 1`);
  await sleep(1500);
  log('после старта (хост): ' + JSON.stringify(await lobbyState(host).catch(e => ({ err: e.message }))));
  /* Старт в сети — самое долгое место (генерация острова у обоих). Ждём с
     журналом: если партия не поднялась, в run.log видно, на каком поле она
     встала, а не только «не дождались». */
  const waitParty = async (page, role, label) => {
    const t0 = Date.now();
    for (;;) {
      const st = await page.js(`(() => {
        const P = window.__game && window.__game.Play;
        if (!P) return { noPlay: true };
        const s = P.state;
        return { role: s.netRole, world: !!s.world, running: !!s.running, mode: s.mode,
          fault: !!s.faulted, faultMsg: s.fault && (s.fault.phase + ': ' + s.fault.message),
          villagers: s.villagers ? s.villagers.length : null,
          hidden: document.hidden, lobbyOpen: !document.getElementById('lobby').classList.contains('hidden') };
      })()`).catch(e => ({ err: e.message }));
      log('ждём партию (' + label + '): ' + JSON.stringify(st));
      if (st && st.role === role && st.world) return st;
      if (Date.now() - t0 > 75000) throw new Error('партия у ' + label + ' не поднялась: ' + JSON.stringify(st));
      await sleep(3000);
    }
  };
  log('после старта: хост ' + await host.js('document.visibilityState') +
    ', гость ' + await g.js('document.visibilityState'));
  await waitParty(host, 'host', 'хоста');
  await waitParty(g, 'client', 'гостя');
  await sleep(2000);
  const meta = await host.js(`({ seed: window.__game.Play.state.world.seed,
    size: window.__game.Play.state.world.islandSize,
    players: (window.__game.Play.state.netPlayers||[]).length,
    code: window.Net.code() })`);
  return { code, link, meta, guest: g };
}

async function tokenFor(page) {
  // Токен нужен только чтобы спросить /api/stream-stats. В файлы не пишется.
  return page.js(`(() => {
    try {
      const code = window.Net.code(), pid = window.Net.playerId();
      const keys = Object.keys(localStorage).filter(k => k.indexOf('4tox.multiplayer.v1') === 0);
      for (const k of keys) {
        const o = JSON.parse(localStorage.getItem(k) || '{}');
        if (o && o.code === code && o.playerId === pid) return o.token || null;
      }
      return null;
    } catch (e) { return null; }
  })()`);
}

async function sampleServer(host, token, code, tag) {
  const out = [];
  if (!code || !token) return out;
  const url = API_BASE + '/api/stream-stats?code=' + encodeURIComponent(code) + '&token=' + encodeURIComponent(token);
  for (let i = 0; i < 4; i++) {
    try { const v = await getJSON(url); out.push(stripToken(v)); break; }
    catch (e) { await sleep(150); }
  }
  return out;
}

function stripToken(o) {
  // На всякий случай: даже если сервер когда-нибудь начнёт отдавать токен.
  const s = JSON.stringify(o);
  return JSON.parse(s.replace(/"token":"[^"]*"/g, '"token":"<hidden>"'));
}

/* ------------------------------------------------------------------ main */
(async () => {
  const t0 = Date.now();
  const env = {
    scenario: LABEL,
    flow: SCEN,
    startedAt: new Date().toISOString(),
    repo: REPO,
    base: BASE,
    remote: IS_REMOTE,
    headless: HEADLESS,
    probe: PROBE,
    frames: FRAMES,
    warmupSec: WARMUP,
    measureSec: MEASURE,
    seedRequested: SEED_SOLO,
    size: SIZE,
    node: process.version,
    platform: process.platform + ' ' + os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0] && os.cpus()[0].model,
    cpuCount: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1e9 * 10) / 10,
    rng: RNG
  };
  log('сценарий ' + LABEL + ' (логика ' + SCEN + '), база ' + BASE);

  await startServer();
  await startChrome('A');
  log('Chrome ' + (state.version && state.version.Browser));

  const cdp = await connect(state.version.webSocketDebuggerUrl);
  state.cdp = cdp;
  let cdpGuest = null;
  if (SCEN === 'S2' || SCEN === 'S5') {
    const v2 = await startChrome('B');
    cdpGuest = await connect(v2.webSocketDebuggerUrl);
    state.cdp2 = cdpGuest;
    log('второй браузер ' + v2.Browser + ' (гость)');
  }

  /* Окна. В headless нет экрана, поэтому «видимое окно» — это отдельная
     цель Chrome (newWindow:true): проверено, что такие две цели обе visible и
     обе рисуют 60 кадров/с. Соседние вкладки — две цели в ОДНОМ окне
     (newWindow:false): активная visible, вторая hidden с замороженным rAF.
     В режиме --headed окна ставятся по экрану рядом, чтобы не перекрывать
     друг друга (перекрытое окно на macOS тоже hidden). */
  const LAYOUT = {
    host: { left: 0, top: 30, width: VIEW.w, height: VIEW.h + 87 },
    guest: { left: VIEW.w + 10, top: 30, width: VIEW.w, height: VIEW.h + 87 }
  };
  const pages0 = await getJSON('http://127.0.0.1:' + CDP + '/json/list');
  const firstPage = pages0.find(t => t.type === 'page');

  let host, guest, startInfo;
  if (SCEN === 'S1') {
    host = await openPage(cdp, GAME_URL, { reuseTargetId: firstPage && firstPage.id, bounds: HEADLESS ? null : LAYOUT.host });
    await host.send('Page.bringToFront').catch(() => {});
    startInfo = await startSolo(host);
  } else {
    host = await openPage(cdp, GAME_URL, { reuseTargetId: firstPage && firstPage.id, bounds: HEADLESS ? null : LAYOUT.host });
    const sameWindow = (SCEN === 'S3' || SCEN === 'S4');
    await sleep(500);
    if (sameWindow) {
      guest = await openPage(cdp, 'about:blank', { newWindow: false });
    } else {
      /* Гость — отдельный браузер со своим единственным окном: два окна в
         одном headless-браузере после входа в лобби гасят второе. */
      const pagesB = await getJSON('http://127.0.0.1:' + CDP2 + '/json/list');
      const firstB = pagesB.find(t => t.type === 'page');
      guest = await openPage(cdpGuest, 'about:blank', {
        reuseTargetId: firstB && firstB.id, bounds: HEADLESS ? null : LAYOUT.guest
      });
    }
    log('после создания гостя: хост ' + await host.js('document.visibilityState') +
      ', гость ' + await guest.js('document.visibilityState'));
    await host.send('Page.bringToFront').catch(() => {});
    const started = await startLobby(cdp, host, guest);
    guest = started.guest;
    startInfo = started.meta;
    /* Активная вкладка задаётся здесь и больше не трогается до конца
       прогона: переключение вкладок во время измерения недопустимо. В S2/S5
       переключать нечего — это два разных окна, оба видимы. */
    if (SCEN === 'S3') { await guest.send('Page.bringToFront').catch(() => {}); log('активна вкладка гостя (хост скрыт)'); }
    if (SCEN === 'S4') { await host.send('Page.bringToFront').catch(() => {}); log('активна вкладка хоста (гость скрыт)'); }
    /* В S2/S5 НЕ зовём bringToFront: в headless два окна и без него оба
       visible, а лишняя активация одного окна делает второе скрытым (это
       проверено: гость получал hidden=true и терял rAF). */
    if (SCEN === 'S2' || SCEN === 'S5') log('два окна, активацию не трогаем');
  }
  state.pages = [host, guest].filter(Boolean);

  // окна: подтверждаем, одно окно или два, и что страницы видят себя как видимые
  const winHost = await windowOf(cdp, host.targetId);
  const winGuest = guest ? await windowOf(cdp, guest.targetId) : null;

  /* Проверка условий сценария ДО измерения: если видимость не такая, как
     задумано, прогон не годится — лучше упасть, чем записать красивые числа
     от другого сценария. */
  const visOf = async p => p ? p.js('document.visibilityState') : null;
  const vHost = await visOf(host), vGuest = await visOf(guest);
  const need = SCEN === 'S1' ? { host: 'visible' }
    : SCEN === 'S2' || SCEN === 'S5' ? { host: 'visible', guest: 'visible' }
    : SCEN === 'S3' ? { host: 'hidden', guest: 'visible' }
    : { host: 'visible', guest: 'hidden' };
  const wrong = Object.keys(need).filter(k => (k === 'host' ? vHost : vGuest) !== need[k]);
  log('видимость: хост ' + vHost + ', гость ' + vGuest + (wrong.length ? ' — НЕ ТАК: ' + wrong.join(',') : ' — как задумано'));
  if (wrong.length) throw new Error('условия сценария не выполнены: ' + JSON.stringify({ vHost, vGuest, need }));
  const vis = async p => p ? p.js(`({ hidden: document.hidden, vis: document.visibilityState,
      focus: document.hasFocus(), w: innerWidth, h: innerHeight,
      dpr: devicePixelRatio,
      canvas: (() => { const c = document.getElementById('view'); return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null; })(),
      role: window.__game && window.__game.Play ? window.__game.Play.state.netRole : null })`) : null;

  /* Режимы обвязки (для замера её собственной стоимости):
       off      — ничего не включаем, игра как есть;
       metrics  — только счётчики движка (Metrics.on), без обвязки;
       light    — обвязка без покадровой выборки (счётчики + обёртки + 1 Гц);
       full     — всё, включая покадровую выборку. */
  if (PROBE === 'metrics') {
    for (const p of [host, guest]) {
      if (!p) continue;
      await p.js(`(() => { if (window.Metrics) { Metrics.on = true; Metrics.reset(); } return 1; })()`).catch(() => {});
    }
  }
  if (PROBE !== 'off' && PROBE !== 'metrics') {
    const probeOn = `window.__passport && window.__passport.start({frames:${FRAMES}}); 1`;
    const inst = [];
    for (const p of [host, guest]) {
      if (!p) continue;
      inst.push(await p.js(`window.__passport ? window.__passport.info() : null`));
      await p.js(probeOn).catch(() => {});
    }
    log('обвязка: ' + JSON.stringify(inst));
  }

  // разогрев: следим, чтобы обвязка выбрала движущегося жителя
  await sleep(2000);
  if (PROBE !== 'off') {
    for (const p of [host, guest]) {
      if (!p) continue;
      await p.js(`window.__passport && window.__passport.pickMover()`).catch(() => {});
    }
  }
  log('разогрев ' + WARMUP + ' с');
  await sleep(WARMUP * 1000);

  // Точка отсчёта измерения: сбрасываем счётчики движка и отмечаем время.
  for (const p of [host, guest]) {
    if (!p) continue;
    await p.js(`(() => { if (window.Metrics && Metrics.reset) Metrics.reset();
      if (window.__passport) window.__passport.mark('measure-start'); return 1; })()`).catch(() => {});
    await p.js(`window.__passport && window.__passport.pickMover()`).catch(() => {});
  }
  const token = await tokenFor(host).catch(() => null);
  const code = startInfo && startInfo.code ? startInfo.code : await host.js('window.Net && window.Net.code ? window.Net.code() : null').catch(() => null);

  const serverSamples = [];
  const serverLogFile = path.join(OUT, 'server-samples.jsonl');
  fs.writeFileSync(serverLogFile, '');
  let traceStarted = 0;
  if (TRACE) {
    try {
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.gc,loading,net',
        options: 'sampling-frequency=1000'
      });
      traceStarted = Date.now();
    } catch (e) { log('trace не стартовал: ' + e.message); }
  }

  log('измерение ' + MEASURE + ' с');
  const measureStart = { wall: Date.now(), iso: new Date().toISOString() };
  for (let s = 0; s < MEASURE; s++) {
    await sleep(1000);
    try {
      const rec = { t: new Date().toISOString(), sec: s + 1 };
      rec.host = await vis(host);
      rec.guest = await vis(guest);
      if (!IS_REMOTE || true) {
        const st = await sampleServer(host, token, code, 'stream');
        if (st.length) rec.streamStats = st[0];
      }
      /* Внешние счётчики Chromium: не зависят от игры и от Metrics. */
      for (const [name, p] of [['host', host], ['guest', guest]]) {
        if (!p) continue;
        let pm = null;
        try {
          const r = await p.send('Performance.getMetrics');
          pm = {};
          (r.metrics || []).forEach(m => { pm[m.name] = m.value; });
          pm = {
            TaskDuration: pm.TaskDuration, ScriptDuration: pm.ScriptDuration,
            LayoutDuration: pm.LayoutDuration, RecalcStyleDuration: pm.RecalcStyleDuration,
            JSHeapUsedSize: pm.JSHeapUsedSize, JSHeapTotalSize: pm.JSHeapTotalSize,
            Nodes: pm.Nodes, Documents: pm.Documents, Frames: pm.Frames
          };
        } catch (e) { pm = null; }
        rec['perf_' + name] = pm;
      }
      rec.probe = {};
      for (const [name, p] of [['host', host], ['guest', guest]]) {
        if (!p) continue;
        rec.probe[name] = await p.js(`(() => { const P = window.__game && window.__game.Play;
          if (!P) return null; const st = P.state;
          const M = window.Metrics;
          return { simSec: st.seconds, seq: st.netSeq, every: st.netEvery, queue: st.netQueue,
            gzip: st.netGzip, ping: st.netPing, busy: st.netBusy, stale: st.netStale,
            silence: st.netSilence, dropped: st.simDropped, hidden: document.hidden,
            focus: document.hasFocus(), nV: st.villagers.length, nB: st.buildings.length,
            fault: !!st.faulted,
            faultMsg: st.fault ? (st.fault.phase + ': ' + st.fault.message) : null,
            steps: M && M.snapshot ? M.snapshot().steps : null }; })()`).catch(() => null);
      }
      serverSamples.push(rec);
      fs.appendFileSync(serverLogFile, JSON.stringify(rec) + '\n');
    } catch (e) { log('кадр выборки ' + (s + 1) + ': ' + e.message); }
  }

  /* Конец окна измерения фиксируется здесь же: выборка идёт по секундам, но
     каждый опрос страниц занимает время, поэтому фактическое окно длиннее
     запланированного — и в разборе берётся ФАКТ, а не план. */
  const measureEnd = { wall: Date.now(), iso: new Date().toISOString() };
  for (const p of [host, guest]) {
    if (!p) continue;
    await p.js(`window.__passport && window.__passport.mark('measure-end')`).catch(() => {});
  }

  if (traceStarted) {
    try {
      const done = new Promise(res => {
        const h = m => { if (m.method === 'Tracing.tracingComplete') res(m.params); };
        cdp.on(h);
        setTimeout(() => res(null), 20000);
      });
      await cdp.send('Tracing.end');
      const ev = await done;
      if (ev && ev.stream) {
        const f = path.join(OUT, 'trace.json');
        const fd = fs.openSync(f, 'w');
        for (;;) {
          const chunk = await cdp.send('IO.read', { handle: ev.stream });
          if (chunk.base64Encoded) fs.writeSync(fd, Buffer.from(chunk.data, 'base64'));
          else fs.writeSync(fd, chunk.data);
          if (chunk.eof) break;
        }
        fs.closeSync(fd);
        await cdp.send('IO.close', { handle: ev.stream });
        log('trace записан: ' + f);
      }
    } catch (e) { log('trace не записался: ' + e.message); }
  }

  // Сырые выгрузки обвязки.
  const dumps = {};
  for (const [name, p] of [['host', host], ['guest', guest]]) {
    if (!p) continue;
    dumps[name] = await p.js(`(() => { try { return window.__passport.dump(); } catch (e) { return { err: String(e) }; } })()`).catch(e => ({ err: String(e) }));
    dumps[name].errors = p.errors || [];
    dumps[name].visibility = await vis(p).catch(() => null);
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(dumps[name]));
  }

  const scenario = Object.assign({}, env, {
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    chrome: state.version && state.version.Browser,
    userAgent: dumps.host && dumps.host.info ? dumps.host.info.ua : null,
    windows: { host: winHost, guest: winGuest },
    sameWindow: winHost !== null && winHost === winGuest,
    start: startInfo,
    observed: {
      host: dumps.host && dumps.host.visibility,
      guest: dumps.guest && dumps.guest.visibility
    },
    probeInstalled: {
      host: dumps.host && dumps.host.info ? dumps.host.info.inst : null,
      guest: dumps.guest && dumps.guest.info ? dumps.guest.info.inst : null
    },
    measure: { start: measureStart, end: measureEnd,
      actualSec: Math.round((measureEnd.wall - measureStart.wall) / 100) / 10 },
    serverSamplesFile: 'server-samples.jsonl',
    serverLog: 'server.log'
  });
  fs.writeFileSync(path.join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2));
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n');

  log('готово: ' + OUT + ' за ' + Math.round((Date.now() - t0) / 1000) + ' с');
  killAll();
  process.exit(0);
})().catch(e => {
  log('ПАДЕНИЕ: ' + (e && e.stack || e));
  try { fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n'); } catch (e2) {}
  killAll();
  process.exit(1);
});
