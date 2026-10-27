/* mp-browser-mixed.js — 100/200 жителей: половина работает, половина воюет, реальный Chrome.

   Это не GPU-профиль и не E02 целиком: меряется, что браузерная оболочка
   рисует и тикает мир с 100/200 добавленными жителями, и во что это
   обходится по кадрам. Жители синтетические, работа/бой не назначаются.

     node game/tools/tests/mp-browser-mixed.js --entities 100
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

function summarizeProfile(profile) {
  if (!profile || !profile.nodes || !profile.samples) return null;
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const dt = (profile.timeDeltas && profile.timeDeltas[i]) || 0;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const rows = [];
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame || {};
    rows.push({ name: cf.functionName || '(anonymous)', url: cf.url || '',
      line: cf.lineNumber, ms: us / 1000 });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((a, b) => a + b.ms, 0);
  const phase = { step: 0, combat: 0, navigation: 0, render: 0, apply: 0, other: 0 };
  for (const r of rows) {
    const n = (r.name + ' ' + r.url).toLowerCase();
    if (/combat|choosetarget|attack/.test(n)) phase.combat += r.ms;
    else if (/navigation|findpath|begintick|requestpath|astar/.test(n)) phase.navigation += r.ms;
    else if (/drawobjects|drawimage|drawsprite|drawbuilding|drawvillager|drawterrain|render\.|crests|yardpoints/.test(n)) phase.render += r.ms;
    else if (/serialize|applysnapshot|replication/.test(n)) phase.apply += r.ms;
    else if (/simulation\.step|stepvillagers|simulationstep|\.step /.test(n)) phase.step += r.ms;
    else phase.other += r.ms;
  }
  const agg = new Map();
  for (const r of rows) {
    const key = r.name + ' @ ' + r.url;
    const cur = agg.get(key) || { name: r.name, url: r.url, ms: 0 };
    cur.ms += r.ms;
    agg.set(key, cur);
  }
  const topRows = Array.from(agg.values()).sort((a, b) => b.ms - a.ms);
  return { totalMs: +total.toFixed(2), top: topRows.slice(0, 15).map((r) => ({
    name: r.name, ms: +r.ms.toFixed(2), pct: +(100 * r.ms / (total || 1)).toFixed(1)
  })), phaseMs: Object.fromEntries(Object.entries(phase).map(([k, v]) => [k, +v.toFixed(2)])) };
}

async function main() {
  const want = Math.max(10, arg('entities', 100));
  const seconds = Math.max(2, arg('seconds', 10));
  const doProfile = process.argv.includes('--profile');
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
    await page.js('Play.start({seed:"browser-mixed",size:128,mode:"bot"}); true');
    await sleep(1200);
    const added = await page.js(`(function(){
      var g = window, P = g.Play, w = P.state.world, B = g.Buildings, S = g.Session;
      var need = ${want}, made = 0, workers = Math.ceil(need / 2), warriors = need - workers;
      var trees = [];
      for (var ty = 3; ty < w.height - 3; ty += 2) {
        for (var tx = 3; tx < w.width - 3; tx += 2) {
          if (!w.isLand[ty * w.width + tx]) continue;
          trees.push({ kind: 'tree', variant: 'oak', x: tx + 0.5, y: ty + 0.5,
            scale: 1, phase: 0, id: trees.length });
        }
      }
      trees.sort(function(a,b){ return (a.x+a.y)-(b.x+b.y); });
      trees.forEach(function(t,i){ t.id=i; });
      w.objects = trees; w.objectTotal = trees.length; w._treeIndex = null;
      w._villagerBlocked = null; w._villagerAreas = null;
      w.objectRev = (w.objectRev || 0) + 1;
      var camps = [], campCount = Math.ceil(workers / 3);
      for (var ci = 0; ci < campCount; ci++) {
        var cx = 20 + (ci % 8) * 8, cy = 20 + Math.floor(ci / 8) * 8;
        var b = B.make({ type: 'lumbercamp', variant: 'a', rot: 90,
          x: cx, y: cy, owner: 0, town: 0, id: 'p0:bwork' + ci });
        P.state.buildings.push(b); camps.push(b);
      }
      B.touch(w);
      for (var c = 0; c < camps.length && made < workers; c++) {
        for (var k = 0; k < 3 && made < workers; k++) {
          var v = g.Villagers.blank(w, {
            id: 91000 + made, index: 91000 + made, rngKey: 91000 + made,
            x: camps[c].x + 1 + k, y: camps[c].y + 1, owner: 0, town: 0,
            avoid: P.state.villagers, buildings: P.state.buildings
          });
          v.avoid = [];
          P.state.villagers.push(v);
          var r = S.hire(camps[c], v, P.state.villagers);
          if (r && r.ok) made++;
        }
      }
      var enemy = null;
      for (var bi = 0; bi < P.state.buildings.length; bi++) {
        var bb = P.state.buildings[bi];
        if (bb && bb.owner === 1 && bb.type === 'townhall') { enemy = bb; break; }
      }
      if (!enemy) for (var bj = 0; bj < P.state.buildings.length; bj++) {
        if (P.state.buildings[bj] && P.state.buildings[bj].owner === 1) { enemy = P.state.buildings[bj]; break; }
      }
      var madeWarriors = 0;
      if (enemy) {
        var perSide = Math.ceil(warriors / 2);
        for (var side = 0; side < 2; side++) {
          for (var wi = 0; wi < perSide && madeWarriors < warriors; wi++) {
            var wx = enemy.x + 5 + (wi % 10) * 0.45 + (side ? 2.5 : -2.5);
            var wy = enemy.y + 6 + Math.floor(wi / 10) * 0.45 + (side ? 2.5 : -2.5);
            var wv = g.Villagers.blank(w, {
              id: 93000 + madeWarriors, index: 93000 + madeWarriors,
              rngKey: 93000 + madeWarriors, x: wx, y: wy,
              owner: side, town: side,
              avoid: P.state.villagers, buildings: P.state.buildings
            });
            wv.warrior = true; wv.state = 'patrol';
            wv.order = { x: enemy.x + 1, y: enemy.y + 1 };
            wv.anchor = { x: wx, y: wy }; wv.avoid = [];
            P.state.villagers.push(wv); madeWarriors++;
          }
        }
      }
      P.renderer().setBuildings(P.state.buildings);
      w._villagers = P.state.villagers; w._buildings = P.state.buildings;
      return { workers: made, warriors: madeWarriors, total: P.state.villagers.length,
        camps: camps.length, trees: trees.length, enemy: !!enemy };
    })()`);
    await sleep(2000);
    if (doProfile) {
      await page.send('Profiler.enable');
      await page.send('Profiler.start');
      await sleep(10000);
      const pr = await page.send('Profiler.stop');
      out.profile = summarizeProfile(pr.result && pr.result.profile);
    }
    const frames = await page.js(`new Promise(function(resolve){
      var f = [], last = performance.now(), start = last;
      function step(now) {
        f.push(now - last); last = now;
        if (now - start < ${seconds} * 1000) requestAnimationFrame(step);
        else {
          var s = f.slice().sort(function(a,b){return a-b;});
          var p = function(q){ return +s[Math.min(s.length-1, Math.floor((s.length-1)*q))].toFixed(2); };
          var over50 = f.filter(function(x){return x > 50;}).length;
          resolve({ frames: f.length, p50: p(0.5), p95: p(0.95), max: +Math.max.apply(null,f).toFixed(2), over50: over50 });
        }
      }
      requestAnimationFrame(step);
    })`);
    const st = await page.js('({villagers:Play.state.villagers.length, running:Play.state.running, dpr:Play.renderer().dpr, mode:Play.state.mode, workers:Play.state.villagers.filter(function(v){return !!v.employer;}).length, chopping:Play.state.villagers.filter(function(v){return v.state==="chop";}).length, felled:Play.state.world.towns.reduce(function(n,t){return n+(t.felled||0);},0), warriors:Play.state.villagers.filter(function(v){return !!v.warrior;}).length, combat:Play.state.villagers.filter(function(v){return !!v.combatMode;}).length, targets:Play.state.villagers.filter(function(v){return !!v.target;}).length})');
    out.added = added; out.seconds = seconds; out.state = st; out.frames = frames;
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
  const file = path.join(dir, 'mp-browser-mixed-' + want + (seconds !== 10 ? '-' + seconds + 's' : '') + (doProfile ? '-profile' : '') + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
  process.exit(out.ok ? 0 : 1);
}
main();
