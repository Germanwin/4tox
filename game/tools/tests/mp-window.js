/* mp-window.js — полное окно серверной комнаты без браузера.

   Поднимает изолированный сервер, открывает SSE организатора и читает
   committed-снимки заданное окно. Считает:
     * committed ticks/s по /api/ping (tick до/после);
     * snapshots/s по факту SSE;
     * p95 интервала между снимками;
     * p95 времени /api/ping.
   Это не заменяет real-device rendering; зато окно, coverage и хвост честные.

     node game/tools/tests/mp-window.js --seconds 180 --warmup 30
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'game', 'tools', 'out');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(base, p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}) });
  return await r.json();
}
async function get(base, p) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(base + p);
  const j = await r.json();
  return { status: r.status, json: j, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
function p95(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * 0.95))].toFixed(3);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const seconds = Math.max(10, arg('seconds', 180));
  const warmup = Math.max(0, arg('warmup', 30));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-window-'));
  const log = fs.createWriteStream(path.join(stateDir, 'server.log'));
  const child = spawn(process.execPath, [path.join(ROOT, 'game', 'server', 'server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: ROOT, env: Object.assign({}, process.env, { STATE_DIR: stateDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(log); child.stderr.pipe(log);
  let stream = null, ctrl = null;
  const out = { plannedSeconds: seconds, warmupSeconds: warmup, startedAt: new Date().toISOString() };
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { const r = await fetch(base + '/api/build'); ready = r.ok; } catch (e) {}
      if (!ready) await sleep(100);
    }
    const lobby = await post(base, '/api/lobby', { name: 'Window', max: 2, protocol: 4 });
    const code = lobby.code, token = lobby.token;
    const guest = await post(base, '/api/join', { code: code, name: 'WindowGuest', protocol: 4 });
    await post(base, '/api/ready', { code: code, token: token, ready: true });
    await post(base, '/api/ready', { code: code, token: guest.token, ready: true });
    const started = await post(base, '/api/start', { code: code, token: token });
    if (!started.ok) throw new Error('start_failed:' + JSON.stringify(started));
    out.roomId = started.start.roomId;
    out.epoch = started.start.epoch;

    ctrl = new AbortController();
    const sse = await fetch(base + '/api/events?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), { signal: ctrl.signal });
    stream = sse.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let snapTimes = [];
    let windowStart = 0;
    let reading = true;
    (async () => {
      while (reading) {
        const r = await stream.read().catch(() => ({ done: true }));
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('event: snapshot')) >= 0) {
          const t = Date.now();
          buf = buf.slice(idx + 15);
          if (windowStart) snapTimes.push(t);
        }
      }
    })();

    await sleep(warmup * 1000);
    const p0 = await get(base, '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token));
    windowStart = Date.now();
    const pingMs = [p0.ms];
    const t0 = windowStart;
    let lastPing = p0.json;
    const endAt = t0 + seconds * 1000;
    while (Date.now() < endAt) {
      await sleep(Math.min(5000, endAt - Date.now()));
      if (Date.now() >= endAt) break;
      const p = await get(base, '/api/ping?code=' + encodeURIComponent(code) +
        '&token=' + encodeURIComponent(token));
      pingMs.push(p.ms);
      if (p.json) lastPing = p.json;
    }
    const p1 = await get(base, '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token));
    pingMs.push(p1.ms);
    const end = Date.now();
    const observed = (end - t0) / 1000;
    const dTicks = (p1.json.tick || 0) - (p0.json.tick || 0);
    const dRev = (p1.json.revision || 0) - (p0.json.revision || 0);
    const intervals = [];
    for (let i = 1; i < snapTimes.length; i++) intervals.push(snapTimes[i] - snapTimes[i - 1]);
    out.observedSeconds = +observed.toFixed(3);
    out.committedTicks = dTicks;
    out.committedTickRate = +(dTicks / observed).toFixed(3);
    out.revisionDelta = dRev;
    out.snapshots = snapTimes.length;
    out.snapshotsPerSecond = +(snapTimes.length / observed).toFixed(3);
    out.snapshotIntervalP95Ms = p95(intervals);
    out.pingP95Ms = p95(pingMs);
    out.tailGapMs = snapTimes.length ? end - snapTimes[snapTimes.length - 1] : null;
    out.roomStatus = lastPing && lastPing.roomStatus;
    out.epochEnd = lastPing && lastPing.epoch;
    out.coverage = +(Math.min(1, observed / seconds)).toFixed(3);
    out.ok = out.roomStatus === 'running' && out.committedTickRate >= 19 &&
      out.snapshotsPerSecond >= 9.5;
  } catch (e) {
    out.error = String(e && e.message || e);
    out.ok = false;
  } finally {
    try { if (ctrl) ctrl.abort(); } catch (e) {}
    try { child.kill('SIGKILL'); } catch (e) {}
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT, 'mp-window-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
  process.exit(out.ok ? 0 : 1);
}

main();
