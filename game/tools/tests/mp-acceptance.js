/* mp-acceptance.js — сквозная приёмка серверной комнаты без браузера.

   Поднимает отдельный сервер на свободном loopback-порту, отдельный
   временный STATE_DIR и проверяет то, что можно проверить по HTTP/SSE:
   старт, baseline, независимые тики, команду гостя, точный результат,
   повтор ID, отказ старого /api/snapshot, возврат после F5 и то, что уход
   организатора не останавливает комнату.

   Сырые ответы пишутся отдельно от сводки. При FAIL — ненулевой exit code.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'game', 'tools', 'out');

function help() {
  console.log('usage: node game/tools/tests/mp-acceptance.js [--keep] [--json path]');
  console.log('starts an isolated loopback server with a temporary STATE_DIR');
  console.log('exit 0 — all checks PASS; nonzero — FAIL/BLOCKED');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server_not_ready');
}

async function post(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

async function get(base, p) {
  const r = await fetch(base + p);
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

async function openSse(base, code, token) {
  const ctrl = new AbortController();
  const r = await fetch(base + '/api/events?code=' + encodeURIComponent(code) +
    '&token=' + encodeURIComponent(token), { signal: ctrl.signal });
  return { response: r, ctrl: ctrl, reader: r.body.getReader() };
}

async function countSnapshots(stream, ms) {
  const decoder = new TextDecoder();
  let text = '';
  let count = 0;
  const started = Date.now();
  while (Date.now() - started < ms) {
    const race = await Promise.race([
      stream.reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 100))
    ]);
    if (race.timeout) continue;
    if (race.done) break;
    text += decoder.decode(race.value, { stream: true });
    const m = text.match(/event: snapshot/g);
    count = m ? m.length : 0;
  }
  return count;
}

async function readSse(stream, ms) {
  const decoder = new TextDecoder();
  let text = '';
  const started = Date.now();
  while (Date.now() - started < ms) {
    const race = await Promise.race([
      stream.reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 100))
    ]);
    if (race.timeout) continue;
    if (race.done) break;
    text += decoder.decode(race.value, { stream: true });
    if (text.indexOf('event: snapshot') >= 0) break;
  }
  return text;
}

async function main() {
  if (process.argv.includes('--help')) { help(); return 0; }
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = path.join(OUT, 'mp-acceptance-raw-' + stamp + '.json');
  const summaryPath = path.join(OUT, 'mp-acceptance-summary-' + stamp + '.json');
  const checks = [];
  const raw = { at: new Date().toISOString(), steps: [] };
  function check(name, ok, detail) {
    checks.push({ name: name, result: ok ? 'PASS' : 'FAIL', detail: detail || null });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  }

  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-accept-'));
  const logPath = path.join(stateDir, 'server.log');
  const log = fs.createWriteStream(logPath);
  log.on('error', function () {});
  const child = spawn(process.execPath, [path.join(ROOT, 'game', 'server', 'server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { STATE_DIR: stateDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  if (process.env.MP_ACCEPT_DEBUG) {
    child.stdout.on('data', function (d) { process.stderr.write('SERVER: ' + d); });
    child.stderr.on('data', function (d) { process.stderr.write('SERVER: ' + d); });
  }
  const base = 'http://127.0.0.1:' + port;
  if (process.env.MP_ACCEPT_DEBUG) console.error('acceptance:', { port: port, pid: child.pid, stateDir: stateDir });
  let hostStream = null, guestStream = null;
  try {
    await waitFor(base + '/api/build', 10000);
    const build = await get(base, '/api/build');
    check('server starts, protocol 4', build.status === 200 && build.json.protocol === 4,
      build.json && ('protocol ' + build.json.protocol));
    raw.steps.push({ build: build.json });

    const lobby = await post(base, '/api/lobby', { name: 'Host', max: 2, protocol: 4 });
    check('lobby created', lobby.status === 200 && !!lobby.json.code, lobby.json && lobby.json.code);
    const code = lobby.json.code;
    const hostToken = lobby.json.token;
    const guest = await post(base, '/api/join', { code: code, name: 'Guest', protocol: 4 });
    check('guest joined', guest.status === 200, guest.json && guest.json.playerId);
    const guestToken = guest.json.token;
    await post(base, '/api/ready', { code: code, token: hostToken, ready: true });
    await post(base, '/api/ready', { code: code, token: guestToken, ready: true });
    const started = await post(base, '/api/start', { code: code, token: hostToken });
    const start = started.json && started.json.start;
    check('host start returns baseline', started.status === 200 && start &&
      start.protocol === 4 && start.baseline && start.roomId && start.epoch,
    start && ('room ' + start.roomId + ' epoch ' + start.epoch));
    raw.steps.push({ start: start });

    hostStream = await openSse(base, code, hostToken);
    guestStream = await openSse(base, code, guestToken);
    const hostSse = await readSse(hostStream, 3000);
    const guestSse = await readSse(guestStream, 3000);
    check('SSE baseline reaches both clients', /event: start/.test(hostSse) &&
      /event: snapshot/.test(hostSse) && /event: start/.test(guestSse) &&
      /event: snapshot/.test(guestSse), 'host ' + hostSse.length + 'B, guest ' + guestSse.length + 'B');

    /* E03: хост перестаёт читать SSE, гость продолжает. Поток хоста обязан
       копить только последний снимок и не задерживать гостя. Потом хост
       дочитывает — он получает свежий кадр, а не бесконечную очередь. */
    const fastGuest = await countSnapshots(guestStream, 1500);
    check('E03 slow host does not starve fast guest', fastGuest >= 5,
      'guest snapshots in 1.5s: ' + fastGuest);
    const hostCatchup = await readSse(hostStream, 2500);
    check('E03 slow host catches up on the next snapshot', /event: snapshot/.test(hostCatchup),
      hostCatchup.length + 'B');

    const ping1 = await get(base, '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(hostToken) + '&c0=1');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const ping2 = await get(base, '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(hostToken) + '&c0=2');
    check('room commits ticks independently of page frames',
      ping1.json.tick !== null && ping2.json.tick > ping1.json.tick,
      (ping1.json.tick) + ' -> ' + (ping2.json.tick));
    check('ping carries server clock markers', isFinite(ping2.json.serverReceiveAtMs) &&
      isFinite(ping2.json.serverSendAtMs) && ping2.json.serverSendAtMs >= ping2.json.serverReceiveAtMs,
    ping2.json.serverReceiveAtMs + '..' + ping2.json.serverSendAtMs);
    raw.steps.push({ ping1: ping1.json, ping2: ping2.json });

    const guestPlayer = (start.players || []).find(function (x) { return x.id === guest.json.playerId; });
    const commandId = (guestPlayer && guestPlayer.instance || 's1-acc') + ':1';
    const envelope = {
      protocol: 4, roomId: start.roomId, epoch: start.epoch,
      commandId: commandId, clientSequence: 1,
      type: 'stop', payload: { ids: [] }
    };
    const cmd = await post(base, '/api/command', { code: code, token: guestToken, command: envelope });
    check('guest command admitted with receipt', cmd.status === 202 && cmd.json.ok &&
      cmd.json.admitted === true && cmd.json.status === 'received',
    cmd.json && (cmd.json.status + ' ' + (cmd.json.code || '')));
    raw.steps.push({ command: cmd.json });

    let terminal = null;
    for (let i = 0; i < 40; i++) {
      const q = await get(base, '/api/command-state?code=' + encodeURIComponent(code) +
        '&token=' + encodeURIComponent(guestToken) + '&id=' + encodeURIComponent(commandId));
      const r = q.json && q.json.results && q.json.results[0];
      if (r && r.status !== 'received' && r.status !== 'unknown') { terminal = r; break; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    check('command has exact terminal result', !!terminal &&
      (terminal.status === 'applied' || terminal.status === 'rejected'),
    terminal && (terminal.status + ' / ' + terminal.reasonCode));

    const dup = await post(base, '/api/command', { code: code, token: guestToken, command: envelope });
    check('duplicate command returns same result, not applied twice',
      dup.status === 200 && dup.json.duplicate === true &&
      dup.json.status === (terminal && terminal.status),
    dup.json && dup.json.status);
    raw.steps.push({ duplicate: dup.json });

    const oldSnap = await post(base, '/api/snapshot', {
      code: code, token: hostToken, snapshot: { seq: 999, towns: [{ logs: 999999 }] }
    });
    check('old host snapshot rejected as server_authoritative',
      oldSnap.status === 409 && oldSnap.json && oldSnap.json.code === 'server_authoritative',
      oldSnap.status + ' ' + (oldSnap.json && oldSnap.json.code));

    /* Организатор «закрыл вкладку» — рвём его SSE. Комната и гость должны
       продолжить получать committed ticks. */
    hostStream.ctrl.abort();
    const before = (await get(base, '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(guestToken))).json.tick;
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = (await get(base, '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(guestToken))).json.tick;
    check('closing organizer does not stop the room', after > before, before + ' -> ' + after);

    const resume = await get(base, '/api/resume?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(guestToken));
    check('F5 resume returns baseline and session', resume.status === 200 &&
      resume.json.baseline && resume.json.session && resume.json.session.instance,
    resume.json && ('rev ' + (resume.json.room && resume.json.room.revision)));
    raw.steps.push({ resume: resume.json });

    const rawOut = { checks: checks, raw: raw };
    fs.writeFileSync(rawPath, JSON.stringify(rawOut, null, 2) + '\n');
    fs.writeFileSync(summaryPath, JSON.stringify({
      at: new Date().toISOString(),
      checks: checks,
      pass: checks.filter((c) => c.result === 'PASS').length,
      fail: checks.filter((c) => c.result === 'FAIL').length,
      raw: path.relative(ROOT, rawPath)
    }, null, 2) + '\n');
    const failed = checks.filter((c) => c.result === 'FAIL').length;
    console.log('\n' + (failed ? 'FAIL' : 'PASS') + ': ' +
      (checks.length - failed) + '/' + checks.length + ' checks; raw ' + rawPath);
    return failed ? 1 : 0;
  } catch (e) {
    try {
      const txt = fs.readFileSync(logPath, 'utf8');
      console.error('--- server log ---\n' + txt.split('\n').slice(-40).join('\n'));
    } catch (err) { /* no log */ }
    check('acceptance runs to completion', false, String(e && e.stack || e));
    try {
      fs.writeFileSync(rawPath, JSON.stringify({ error: String(e && e.stack || e), raw: raw }, null, 2) + '\n');
    } catch (err) { /* no */ }
    return 1;
  } finally {
    try { if (hostStream) hostStream.ctrl.abort(); } catch (e) {}
    try { if (guestStream) guestStream.ctrl.abort(); } catch (e) {}
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { child.kill('SIGKILL'); } catch (e) {}
    log.end();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(String(e && e.stack || e));
    process.exitCode = 2;
  });
}

module.exports = { main: main };
