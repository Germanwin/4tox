/* mp-browser-combat.js — 100/200 воинов в реальном Chrome, режим против деревни.

   Это не GPU-профиль и не E02 целиком: меряется, что браузерная оболочка
   рисует и тикает мир с 100/200 добавленными жителями, и во что это
   обходится по кадрам. Жители синтетические, работа/бой не назначаются.

     node game/tools/tests/mp-browser-combat.js --entities 100
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const CHROME = require('../../../mapgen2/tools/chrome.js');
const ROOT = path.resolve(__dirname, '..', '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function tab(cdp, url) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: cdp,
      path: '/json/new?' + encodeURIComponent(url), method: 'PUT' }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    q.on('error', reject); q.end();
  });
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params) => new Promise((r) => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: expression, returnByValue: true, awaitPromise: true
    });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  return { send, js, errors };
}

async function main() {
  const want = Math.max(10, arg('entities', 100));
  const port = await freePort();
  const cdp = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-bload-'));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-chrome-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'game/server/server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: ROOT, env: Object.assign({}, process.env, { STATE_DIR: stateDir }), stdio: 'ignore'
  });
  await sleep(1200);
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdp,
    '--user-data-dir=' + prof, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank'], { detached: true, stdio: 'ignore' });
  await sleep(900);
  const out = { entitiesWanted: want, chrome: 'headless', errors: [] };
  try {
    const t = await tab(cdp, 'about:blank');
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.navigate', { url: base + '/game/' });
    await sleep(3500);
    await page.js('Play.start({seed:"browser-combat",size:128,mode:"bot"}); true');
    await sleep(1200);
    const added = await page.js(`(function(){
      var g = window, P = g.Play, w = P.state.world;
      var enemy = null, list = P.state.buildings;
      for (var bi = 0; bi < list.length; bi++) {
        if (list[bi] && list[bi].owner === 1 && list[bi].type === 'townhall') { enemy = list[bi]; break; }
      }
      if (!enemy) {
        for (var bj = 0; bj < list.length; bj++) {
          if (list[bj] && list[bj].owner === 1) { enemy = list[bj]; break; }
        }
      }
      if (!enemy) return { error: 'no_enemy_town' };
      var want = ${want}, perSide = Math.ceil(want / 2), made = 0;
      for (var side = 0; side < 2; side++) {
        for (var i = 0; i < perSide; i++) {
          var x = enemy.x + 5 + (i % 10) * 0.45 + (side ? 2.5 : -2.5);
          var y = enemy.y + 6 + Math.floor(i / 10) * 0.45 + (side ? 2.5 : -2.5);
          var v = g.Villagers.blank(w, {
            id: 92000 + made, index: 92000 + made, rngKey: 92000 + made,
            x: x, y: y, owner: side, town: side,
            avoid: P.state.villagers, buildings: P.state.buildings
          });
          v.warrior = true; v.state = 'patrol';
          v.order = { x: enemy.x + 1, y: enemy.y + 1 };
          v.anchor = { x: x, y: y }; v.avoid = [];
          P.state.villagers.push(v); made++;
        }
      }
      w._villagers = P.state.villagers;
      w._villagerBlocked = null; w._villagerAreas = null;
      return { made: made, total: P.state.villagers.length,
        enemy: { x: enemy.x, y: enemy.y, hp: enemy.hp } };
    })()`);
    await sleep(2000);
    const frames = await page.js(`new Promise(function(resolve){
      var f = [], last = performance.now(), start = last;
      function step(now) {
        f.push(now - last); last = now;
        if (now - start < 10000) requestAnimationFrame(step);
        else {
          var s = f.slice().sort(function(a,b){return a-b;});
          var p = function(q){ return +s[Math.min(s.length-1, Math.floor((s.length-1)*q))].toFixed(2); };
          var over50 = f.filter(function(x){return x > 50;}).length;
          resolve({ frames: f.length, p50: p(0.5), p95: p(0.95), max: +Math.max.apply(null,f).toFixed(2), over50: over50 });
        }
      }
      requestAnimationFrame(step);
    })`);
    const st = await page.js('({villagers:Play.state.villagers.length, running:Play.state.running, dpr:Play.renderer().dpr, mode:Play.state.mode, warriors:Play.state.villagers.filter(function(v){return !!v.warrior;}).length, combat:Play.state.villagers.filter(function(v){return !!v.combatMode;}).length, targets:Play.state.villagers.filter(function(v){return !!v.target;}).length, enemyHp:Play.state.buildings.filter(function(b){return b.owner===1;}).reduce(function(n,b){return n+(b.hp||0);},0)})');
    out.added = added; out.state = st; out.frames = frames;
    out.errors = page.errors || [];
  } catch (e) {
    out.error = String(e && e.message || e);
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    try { server.kill('SIGKILL'); } catch (e) {}
  }
  out.ok = !out.error && out.errors.length === 0 && out.frames && out.frames.p95 < 40;
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mp-browser-combat-' + want + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
  process.exit(out.ok ? 0 : 1);
}
main();
