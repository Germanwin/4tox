/* audit-fixes.test.js — репро-тесты находок аудита 2026-10-28.

   Каждый тест здесь падал на коммите 610db26 (или на HEAD 838e9a6 до
   соответствующей правки) и обязан быть зелёным после неё. Тесты грузят
   настоящий движок через load-engine.js — без DOM и без подделок. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const E = require('./load-engine.js');
const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadWaves() {
  if (!globalThis.Waves) {
    const code = fs.readFileSync(path.join(ROOT, 'mapgen2', 'js', 'waves.js'), 'utf8');
    new Function('window', 'document', 'globalThis',
      code + '\n//# sourceURL=mapgen2/js/waves.js')(undefined, undefined, globalThis);
  }
  return globalThis.Waves;
}

function overlapCount(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (a[i] !== b[j] && globalThis.Buildings.overlaps(a[i], b[j])) n++;
    }
  }
  return n;
}

test('B-02: тип вне TYPES не проходит цену и не делает казну NaN', () => {
  const g = E.loadEngine();
  assert.equal(typeof g.Commands.buildPrice('constructor'), 'number',
    'buildPrice("constructor") должен быть числом, а не функцией из прототипа');
  assert.equal(g.Commands.buildPrice('constructor'), 0);
});

test('B-02: "constructor" не ставится из нуля брёвен и не портит казну', () => {
  const g = E.loadEngine();
  const sim = E.makeSim({ players: 2, mode: 'multi' });
  const st = sim.state;
  const town = st.world.towns[0];
  const B = g.Buildings;
  town.logs = 0;
  const fp = B.footprint(0, 'constructor');
  let spot = null;
  for (let y = 1; y < 40 && !spot; y++) {
    for (let x = 1; x < 40 && !spot; x++) {
      const b = B.make({ type: 'constructor', variant: 'a', rot: 0, x, y, owner: 0, town: 0 });
      if (B.canPlace(st.world, st.buildings, b, { clearable: false, requireClear: true, yard: B.YARD, villagers: st.villagers }).ok) spot = { x, y };
    }
  }
  assert.ok(spot, 'нужно свободное пятно 4x3');
  const r = g.Commands.apply(st, {
    type: 'build', owner: 0,
    payload: { buildingType: 'constructor', variant: 'a', rot: 0, x: spot.x, y: spot.y }
  });
  assert.equal(r.status, 'rejected', 'неизвестный тип должен быть отклонён');
  assert.equal(town.logs, 0);
  assert.ok(Number.isFinite(town.logs));
  assert.ok(!st.buildings.some(b => b.type === 'constructor'));
});

test('C-02: деревни в сети не пересекаются (сид mp-14)', () => {
  const g = E.loadEngine();
  const w = g.WorldGen.generate({ seed: 'mp-14', size: 64 });
  const st = g.Session.startMultiCore(w, { players: 2 });
  const byTown = [[], []];
  for (const b of st.buildings) byTown[b.owner].push(b);
  for (let i = 1; i < byTown.length; i++) {
    for (let j = 0; j < i; j++) {
      assert.equal(overlapCount(byTown[j], byTown[i]), 0,
        'постройки деревень ' + j + ' и ' + i + ' не должны пересекаться');
    }
  }
});

test('C-02: деревня бота не ставится на деревню игрока (сид scan-13)', () => {
  const g = E.loadEngine();
  const w = g.WorldGen.generate({ seed: 'scan-13', size: 64 });
  const st = g.Session.startBotCore(w);
  const player = st.buildings.filter(b => b.owner === 0);
  const bot = st.buildings.filter(b => b.owner === 1);
  assert.equal(overlapCount(player, bot), 0,
    'постройки бота не должны пересекать постройки игрока');
});

test('M-10: после падения ратуши edit/hire/train отклоняются', () => {
  const g = E.loadEngine();
  const sim = E.makeSim({ players: 2, mode: 'multi' });
  const st = sim.state;
  const town = st.world.towns[0];
  town.alive = false;
  const own = st.buildings.find(b => (b.owner || 0) === 0);
  assert.ok(own, 'у города есть постройка');
  const edit = g.Commands.apply(st, {
    type: 'edit', owner: 0, payload: { action: 'delete', id: own.id }
  });
  assert.equal(edit.status, 'rejected');
  assert.equal(edit.reasonCode, 'town_gone');
});

test('C-06: оборванный хвост журнала усекается, второй рестарт поднимается', async () => {
  const persistence = require(path.join(ROOT, 'game', 'server', 'persistence.js'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '4tox-journal-'));
  const roomId = 'TAIL';
  const p1 = persistence.create({ dir, roomId });
  await p1.open();
  await p1.append({ type: 'accept', n: 1 });
  await p1.append({ type: 'tickCommit', tick: 1 });
  await p1.close();
  const file = path.join(dir, roomId, 'journal-000001.log');
  const torn = persistence.encodeRecord({ type: 'tickCommit', tick: 2 });
  fs.appendFileSync(file, torn.subarray(0, Math.max(4, torn.length - 5)));
  const p2 = persistence.create({ dir, roomId });
  await p2.open();
  const loaded = await p2.loadLatest();
  assert.equal(loaded.journalTruncated, true, 'хвост должен быть помечен');
  await p2.append({ type: 'tickCommit', tick: 3 });
  await p2.close();
  const p3 = persistence.create({ dir, roomId });
  await p3.open();
  const again = await p3.loadLatest();
  assert.equal(again.journal.length, 3, 'после усечения журнал читается целиком');
  await p3.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('M-14: повторная «Все три» не ставит те же пятна', () => {
  const g = E.loadEngine();
  const w = g.WorldGen.generate({ seed: 'all-dup', size: 64 });
  const first = g.Buildings.placeAll(w, { clear: true });
  const second = g.Buildings.placeAll(w, { clear: true, avoid: first });
  assert.ok(first.length > 0, 'первый вызов что-то поставил');
  assert.equal(overlapCount(first, second), 0,
    'второй комплект не должен пересекать первый');
});

test('BUG-06-01: поле гребней занято примерно на FILL, а не вдвое гуще', () => {
  const W = loadWaves();
  const set = { along: [{}], across: [{}] };
  const box = { x0: 0, x1: 64, y0: 0, y1: 64 };
  const list = W.crests(set, box, 0);
  const n = Math.ceil(64 / W.CELL + 2) * Math.ceil(64 / W.CELL + 2);
  assert.ok(list.length < n * 0.62,
    'гребней ' + list.length + ' при ' + n + ' клетках — порог FILL не работает');
});

test('C-04: статика не отдаёт файлы вне /game/ и /mapgen2/', async () => {
  const port = 19300 + (process.pid % 400);
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), '4tox-static-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'game', 'server', 'server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { STATE_DIR: stateDir }),
    stdio: 'ignore'
  });
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = '';
      r.on('data', c => { b += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/game/'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }
    const home = await get('/game/');
    assert.equal(home.status, 200, 'сама игра должна отдаваться');
    const traversal = await get('/game/%2e%2e/AGENTS.md');
    assert.equal(traversal.status, 404, 'AGENTS.md не должен отдаваться');
    const inner = await get('/game/server/var/rooms/XXXX/lobby.json');
    assert.equal(inner.status, 404, 'game/server не должен отдаваться');
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('M-15: отпечаток мира учитывает карту, а apply отвергает чужой мир', () => {
  const g = E.loadEngine();
  const a = g.WorldGen.generate({ seed: 'h1', size: 64 });
  const b = g.WorldGen.generate({ seed: 'h1', size: 64, land: 0.4, coast: 0.1, forest: 0.1 });
  assert.notEqual(g.WorldGen.hashWorld(a), g.WorldGen.hashWorld(b),
    'одинаковый seed|size с разными параметрами — разные миры');
  const sim = E.makeSim();
  const snap = g.Replication.build(sim.state, {
    revision: 1, serverGeneratedAtMs: 1, roomId: 'R', epoch: 1, baseline: true
  });
  const foreign = g.WorldGen.generate({ seed: 'другой-остров', size: 64 });
  const res = g.Serialize.apply(foreign, snap, null, {});
  assert.equal(res.mismatch, true, 'снимок чужого мира не применяется молча');
});
