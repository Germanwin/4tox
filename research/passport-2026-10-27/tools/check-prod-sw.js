#!/usr/bin/env node
/* check-prod-sw.js — есть ли на проде Service Worker или Cache Storage,
 * из-за которых браузер мог бы держать старый JS.
 *
 * Открывает публичную страницу игры в headless Chrome и спрашивает у страницы
 * registrations/caches. Ничего не меняет: ни регистрации, ни очистки.
 *
 * Запуск: node tools/check-prod-sw.js https://адрес/game/
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const CHROME = require(path.join(__dirname, '..', '..', '..', 'mapgen2', 'tools', 'chrome.js'));
const URL_GAME = process.argv[2] || 'https://374412.fornex.cloud/game/';
const CDP = 9400 + (process.pid % 80);
const PROF = path.join(os.tmpdir(), 'dsh-sw-' + process.pid);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(u) { return new Promise((res, rej) => { http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
(async () => {
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + PROF,
    '--no-first-run', '--disable-extensions', 'about:blank'], { detached: true, stdio: 'ignore' });
  let v;
  for (let i = 0; i < 150; i++) { try { v = await get('http://127.0.0.1:' + CDP + '/json/version'); break; } catch (e) { await sleep(100); } }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); const msg = { id: i, method, params: params || {} }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); });
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
  const sid = a.result.sessionId;
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
  await send('Page.navigate', { url: URL_GAME }, sid);
  await sleep(6000);
  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      const out = { href: location.href, ua: navigator.userAgent };
      try { const regs = await navigator.serviceWorker.getRegistrations(); out.sw = regs.map(x => ({ scope: x.scope, active: !!(x.active && x.active.scriptURL) })); }
      catch (e) { out.swErr = String(e); }
      try { out.caches = window.caches ? await caches.keys() : null; } catch (e) { out.cachesErr = String(e); }
      try { out.loadedScripts = [...document.scripts].map(s => s.src).filter(Boolean).map(s => new URL(s).pathname); } catch (e) {}
      try { out.build = (window.__game && window.__game.state && window.__game.state.build) || (window.Play && window.Play.state && window.Play.state.build) || null; } catch (e) {}
      try { out.meta = document.querySelector('meta[name="4tox-build"]') ? document.querySelector('meta[name="4tox-build"]').content : null; } catch (e) {}
      return out;
    })()`, returnByValue: true, awaitPromise: true
  }, sid);
  console.log(JSON.stringify(r.result.result.value, null, 2));
  try { process.kill(-ch.pid, 'SIGKILL'); } catch (e) { ch.kill('SIGKILL'); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
