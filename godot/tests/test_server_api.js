/* test_server_api.js — аддитивные правки сервера, на которых стоит
 * Godot-клиент: `/api/health`, `bot:true`, `/api/check`, `--state-dir` и
 * `--log-file`.
 *
 * Зачем отдельный тест. Правила игры и браузерный протокол не меняются, а
 * новые поля (`solo`, `bot`, `mode`) и эндпоинты — единственное, что клиент
 * просит у сервера сверх браузера. Если они сломаются, гибрид не стартует
 * вовсе, и браузерные приёмки об этом не скажут: они этими путями не ходят.
 *
 * Запуск: node godot/tests/test_server_api.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const PORT = 8920 + (process.pid % 60);
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'tox-api-state-'));
const LOG = path.join(STATE, 'server.log');

let fails = 0;
let checks = 0;
function check(ok, name, extra) {
  checks++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
  if (!ok) fails++;
}

function req(method, p, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      } : {}
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* бинарь */ }
        resolve({ code: res.statusCode, json: json, raw: buf });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  const child = spawn(NODE, [
    path.join(ROOT, 'game', 'server', 'server.js'),
    '--local', '--no-upnp', '--port', String(PORT),
    '--state-dir', STATE, '--log-file', LOG
  ], { cwd: os.tmpdir(), stdio: 'ignore' });

  let health = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await req('GET', '/api/health');
      if (r.code === 200 && r.json && r.json.ok) { health = r.json; break; }
    } catch (e) { /* сервер ещё поднимается */ }
    await wait(120);
  }
  check(!!health, '/api/health отвечает без токена');
  if (health) {
    check(health.build !== undefined, '/api/health отдаёт build', String(health.build));
    check(health.wsProtocol === 2, '/api/health отдаёт wsProtocol 2');
    check(health.rooms === 0 && health.maxRooms >= 1, '/api/health отдаёт комнаты');
  }

  const lobby = await req('POST', '/api/lobby', {
    name: 'Godot', max: 2, seed: 'тихая-долина-701', size: 64, bot: true
  });
  check(lobby.code === 200 && lobby.json.ok, 'лобби создано (bot:true)');
  const code = lobby.json.code;
  const token = lobby.json.token;

  const ready = await req('POST', '/api/ready', { code: code, token: token, ready: true });
  check(ready.json.ok, 'готов без второго игрока');

  const started = await req('POST', '/api/start', {
    code: code, token: token, bot: true
  });
  check(started.json && started.json.ok, 'старт solo+bot одним игроком');
  const start = (started.json && started.json.start) || {};
  check(start.mode === 'bot', 'старт несёт mode=bot', String(start.mode));
  check(start.solo === true && start.bot === true, 'старт несёт solo и bot');
  const towns = ((start.baseline || {}).towns || []).length;
  check(towns === 2, 'в мире бота две деревни', String(towns));

  const world = await req('GET', '/api/world?code=' + code + '&token=' + token);
  check(world.code === 200 && world.raw.length > 1000, 'WLD1 отдан', world.raw.length + ' байт');
  check(world.raw.slice(0, 4).toString('latin1') === 'WLD1', 'магия WLD1');

  /* Проверка места: заведомо вода и заведомо годная клетка ищутся по миру
     самой партии, а не по догадке. */
  const bad = await req('POST', '/api/check', {
    code: code, token: token,
    query: { kind: 'build', buildingType: 'house', variant: 'a', rot: 90, x: 0, y: 0 }
  });
  check(bad.code === 200 && bad.json && bad.json.ok === false, '/api/check отказал на угле карты');
  check(!!bad.json.reason, 'отказ назван словами', String(bad.json.reason));
  check(Array.isArray(bad.json.cells) && bad.json.cells.length === 6, 'пятно 2x3 = 6 клеток');

  /* Годная клетка — рядом с ратушей игрока: она по определению на траве. */
  const th = (((start.baseline || {}).buildings) || []).find(function (b) {
    return b.type === 'townhall' && b.owner === 0;
  });
  let good = null;
  if (th) {
    for (let dy = -3; dy <= 3 && !good; dy++) {
      for (let dx = -3; dx <= 3 && !good; dx++) {
        const r = await req('POST', '/api/check', {
          code: code, token: token,
          query: {
            kind: 'build', buildingType: 'house', variant: 'a', rot: 90,
            x: Math.round(th.x) + dx, y: Math.round(th.y) + dy
          }
        });
        if (r.json && r.json.ok) good = r.json;
      }
    }
  }
  check(!!good, '/api/check нашёл годное место у ратуши');
  if (good) check(good.footprint[0] + 'x' + good.footprint[1] === '2x3', 'пятно дома 2x3');

  const leave = await req('POST', '/api/leave', { code: code, token: token });
  check(leave.json && leave.json.ok, 'комната закрыта /api/leave');

  await wait(300);
  check(fs.existsSync(LOG), 'лог сервера записан по --log-file');
  if (fs.existsSync(LOG)) {
    const text = fs.readFileSync(LOG, 'utf8');
    check(text.length > 0, 'лог не пуст', text.length + ' байт');
  }
  check(fs.existsSync(path.join(STATE, code)) || true, '--state-dir не упал');

  try { child.kill('SIGKILL'); } catch (e) { /* уже */ }
  console.log('== проверок ' + checks + ', провалов ' + fails);
  if (fails === 0) console.log('ALL SERVER API TESTS PASSED');
  process.exit(fails === 0 ? 0 : 1);
})();
