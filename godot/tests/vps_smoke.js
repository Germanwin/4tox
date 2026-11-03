/* vps_smoke.js — настоящая комната на VPS: лобби → solo-старт → WLD1 → WS
 * 4TX1 → leave. Без браузера и без Godot: проверяет только серверный путь,
 * который нужен гибридному клиенту.
 *
 * Запуск: node godot/tests/vps_smoke.js [origin]
 *   node godot/tests/vps_smoke.js https://374412.fornex.cloud:8443
 *   node godot/tests/vps_smoke.js https://374412.fornex.cloud
 */
'use strict';

const BASE = (process.argv[2] || process.env.TOX_VPS_URL || 'https://374412.fornex.cloud:8443').replace(/\/+$/, '');
const SEED = 'вольная-заводь-346';

let fails = 0;
function check(ok, text, extra) {
  console.log((ok ? '  ok   ' : '  FAIL ') + text + (extra ? '   ' + extra : ''));
  if (!ok) fails++;
}

function req(method, path, body) {
  return fetch(BASE + path, {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(async (r) => ({ code: r.status, json: await r.json().catch(() => null) }));
}

function wsFrame(code, token) {
  const url = BASE.replace(/^http/, 'ws') + '/api/ws?code=' + encodeURIComponent(code) +
    '&token=' + encodeURIComponent(token);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('ws timeout')); }, 15000);
    ws.binaryType = 'arraybuffer';
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    ws.onopen = () => {
      ws.onmessage = (ev) => {
        const buf = Buffer.from(ev.data);
        if (buf.length < 4 || buf.toString('latin1', 0, 4) !== '4TX1') return;
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        resolve(buf.length);
      };
    };
  });
}

(async () => {
  console.log('== VPS smoke ' + BASE);
  const build = await req('GET', '/api/build');
  check(build.code === 200 && build.json && build.json.ok, '/api/build', build.json && build.json.build);
  const health = await req('GET', '/api/health');
  check(health.code === 200 && health.json && health.json.ok, '/api/health');
  if (health.json && health.json.rooms >= health.json.maxRooms) {
    console.log('  комната занята (MAX_ACTIVE_ROOMS); ждём 5 с');
    await new Promise((r) => setTimeout(r, 5000));
  }

  let lobby = await req('POST', '/api/lobby', {
    name: 'VPS-smoke', max: 2, seed: SEED, size: 64, solo: true
  });
  if (lobby.code === 503 && lobby.json && lobby.json.code === 'server_capacity') {
    await new Promise((r) => setTimeout(r, 6000));
    lobby = await req('POST', '/api/lobby', {
      name: 'VPS-smoke', max: 2, seed: SEED, size: 64, solo: true
    });
  }
  check(lobby.code === 200 && lobby.json && lobby.json.ok, 'лобби создано',
    lobby.json && lobby.json.reason);
  if (!lobby.json || !lobby.json.ok) {
    console.log('== провалов ' + fails);
    process.exit(1);
  }
  const code = lobby.json.code;
  const token = lobby.json.token;
  try {
    const ready = await req('POST', '/api/ready', { code: code, token: token, ready: true });
    check(ready.json && ready.json.ok, 'готов без второго игрока (solo)');
    const start = await req('POST', '/api/start', { code: code, token: token, solo: true });
    check(start.json && start.json.ok, 'старт solo');
    check(start.json && start.json.start && start.json.start.mode === 'solo',
      'режим solo', start.json && start.json.start && start.json.start.mode);

    const wr = await fetch(BASE + '/api/world?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token));
    const world = Buffer.from(await wr.arrayBuffer());
    check(wr.status === 200 && world.length > 1000, 'WLD1 отдан', world.length + ' байт');
    check(world.toString('latin1', 0, 4) === 'WLD1', 'магия WLD1');

    const bytes = await wsFrame(code, token);
    check(bytes > 20, 'WS отдал 4TX1', bytes + ' байт');
  } finally {
    const leave = await req('POST', '/api/leave', { code: code, token: token });
    check(leave.json && leave.json.ok, '/api/leave закрыл комнату');
  }
  console.log('== провалов ' + fails);
  if (fails === 0) console.log('VPS SMOKE PASSED');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FAIL ' + e.message);
  console.log('VPS SMOKE FAILED');
  process.exit(1);
});
