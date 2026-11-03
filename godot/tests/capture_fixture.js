/* capture_fixture.js — снимает настоящий кадр 4TX1 v2 и JSON-эталон того же
   мира с живого сервера. Результат — godot/tests/fixtures/{frame.bin,start.json},
   по ним test_wire.gd проверяет декодер: не «читается», а совпадает с JSON.

   Запуск: node godot/tests/capture_fixture.js
   Сервер поднимается сам на свободном порту и гасится в конце. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = process.env.TOX_OUT
  ? path.resolve(process.env.TOX_OUT)
  : path.join(__dirname, 'fixtures');
const PORT = 8900 + (process.pid % 90);

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(pathname + ': не JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await request('GET', '/api/server');
      if (res && res.ok !== false) return;
    } catch (e) { /* ещё не слушает */ }
    await sleep(100);
  }
  throw new Error('сервер не поднялся');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [
    path.join(REPO, 'game/server/server.js'),
    '--local', '--no-upnp', '--port', String(PORT)
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitServer();
    let seed = null;
    let size = null;
    try {
      const wj = JSON.parse(fs.readFileSync(path.join(OUT, 'world.json'), 'utf8'));
      seed = wj.seed;
      size = wj.size;
    } catch (e) { /* фикстуры ещё нет — возьмём случайный мир */ }
    if (!seed && process.env.TOX_SEED) seed = process.env.TOX_SEED;
    if (!size && process.env.TOX_SIZE) size = parseInt(process.env.TOX_SIZE, 10) || null;
    const lobby = await request('POST', '/api/lobby',
      { name: 'Fixture', max: 2, seed: seed, size: size });
    if (!lobby.ok) throw new Error('лобби: ' + JSON.stringify(lobby));
    const guest = await request('POST', '/api/join', { code: lobby.code, name: 'Guest' });
    if (!guest.ok) throw new Error('гость: ' + JSON.stringify(guest));
    for (const token of [lobby.token, guest.token]) {
      const r = await request('POST', '/api/ready', { code: lobby.code, token, ready: true });
      if (!r.ok) throw new Error('готов: ' + JSON.stringify(r));
    }
    const start = await request('POST', '/api/start', { code: lobby.code, token: lobby.token });
    if (!start.ok) throw new Error('старт: ' + JSON.stringify(start));

    /* Статический мир: тот же матч, один раз. */
    const wurl = 'http://127.0.0.1:' + PORT + '/api/world?code=' + lobby.code +
      '&token=' + lobby.token;
    const wres = await fetch(wurl);
    if (!wres.ok) throw new Error('/api/world: HTTP ' + wres.status + ' ' + (await wres.text()));
    const wbuf = Buffer.from(await wres.arrayBuffer());
    const WorldWire = require(path.join(REPO, 'game/shared/world-wire.js'));
    const W = WorldWire.unpack(wbuf);
    console.log('мир:   ' + wbuf.length + ' Б, ' + W.width + 'x' + W.height +
      ', объектов ' + W.objects.length + ', hash ' + W.hash);

    const url = 'ws://127.0.0.1:' + PORT + '/api/ws?code=' + lobby.code + '&token=' + lobby.token;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('кадр не пришёл')), 15000);
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') return;
        clearTimeout(timer);
        resolve(Buffer.from(ev.data));
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    ws.close();

    const framePath = path.join(OUT, 'frame.bin');
    const startPath = path.join(OUT, 'start.json');
    fs.writeFileSync(framePath, frame);
    fs.writeFileSync(startPath, JSON.stringify(start, null, 1));
    fs.writeFileSync(path.join(OUT, 'world.bin'), wbuf);

    const baseline = start.start.baseline;
    console.log('кадр:  ' + frame.length + ' Б, magic=' + frame.slice(0, 4).toString('hex') +
      ' ver=' + frame[4] + ' type=' + frame[5]);
    console.log('эталон: seed=' + start.start.seed + ' size=' + start.start.size +
      ' towns=' + baseline.towns.length + ' buildings=' + baseline.buildings.length +
      ' villagers=' + baseline.villagers.length + ' objects=' + baseline.objectTotal);
    if (W.hash !== baseline.worldgenHash) {
      throw new Error('мир не тот: ' + W.hash + ' != ' + baseline.worldgenHash);
    }
    if (W.objects.length !== baseline.objectTotal) {
      throw new Error('объектов ' + W.objects.length + ' != ' + baseline.objectTotal);
    }
    console.log('файлы:  ' + path.relative(REPO, framePath) + ', ' +
      path.relative(REPO, startPath) + ', tests/fixtures/world.bin');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    if (!server.killed) server.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('ошибка: ' + (e && e.message || e));
  process.exitCode = 1;
});
