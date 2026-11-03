/* browser_guest.js — настоящий браузерный гость для кроссплея с Godot.

   Godot создаёт лобби и ждёт второго игрока; этот скрипт открывает game/ в
   headless Chrome, входит по коду, жмёт «Готов» и ждёт старт. Хост стартует
   сам (LiveRoom.begin_host), после чего скрипт проверяет, что у браузера тот
   же мир: две деревни, шесть построек, шесть жителей, транспорт ws.

   Запуск: node godot/tests/browser_guest.js <port> <code> <out.json> */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const REPO = path.resolve(__dirname, '..', '..');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));

const port = Number(process.argv[2]);
const code = String(process.argv[3] || '');
/* База игры: локальный сервер (по умолчанию) или VPS/релей.
   TOX_HOST_URL=https://374412.fornex.cloud:8443 — origin без /game/. */
const HOST_URL = (process.env.TOX_HOST_URL || ('http://127.0.0.1:' + port)).replace(/\/+$/, '');
const outPath = String(process.argv[4] || '/tmp/4tox-guest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const cdp = 9700 + (process.pid % 200);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-guest-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdp,
    '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
    '--window-size=1280,800', 'about:blank'], { detached: true, stdio: 'ignore' });
  const kill = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {} };
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { kill(); process.exit(130); }));
  try {
    for (let i = 0; i < 120; i++) {
      try { await getJSON('http://127.0.0.1:' + cdp + '/json/version'); break; } catch (e) { await sleep(150); }
    }
    const list = await getJSON('http://127.0.0.1:' + cdp + '/json/list');
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
    });
    const js = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result && r.result.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: HOST_URL + '/game/' });
    const waitFor = async (expr, ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        try { if (await js(expr)) return true; } catch (e) {}
        await sleep(200);
      }
      return false;
    };
    if (!await waitFor('!!(window.Net && window.Play)', 30000)) throw new Error('страница не загрузилась');
    const joined = await js('Net.join(' + JSON.stringify(code) + ',"Браузер").then(r=>r)');
    if (!joined || !joined.ok) throw new Error('вход: ' + JSON.stringify(joined));
    await js('Net.ready(true)');
    if (!await waitFor("Play.state.mode === 'play' && Play.state.world", 40000)) {
      throw new Error('старт не пришёл');
    }
    await sleep(1500);
    const st = await js(`(() => ({
      role: Play.state.netRole, proto: Play.state.netProtocol, seq: Play.state.netSeq,
      seed: Play.state.world.seed, towns: Play.state.world.towns.length,
      buildings: Play.state.buildings.length, villagers: Play.state.villagers.length,
      hostBuildings: Play.state.buildings.filter(b => b.owner === 0).length,
      mine: Play.state.buildings.filter(b => b.owner === Play.state.playerOwner).length,
      transport: Net.transport()
    }))()`);
    fs.writeFileSync(outPath, JSON.stringify(st));
    console.log('guest ' + JSON.stringify(st));
    kill();
    process.exit(0);
  } catch (e) {
    console.error('guest error: ' + (e && e.message || e));
    kill();
    process.exit(1);
  }
})();
