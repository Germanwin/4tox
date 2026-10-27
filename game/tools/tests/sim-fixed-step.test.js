'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine, makeSim } = require('./load-engine');

test('T01: 1200 фиксированных шагов дают один и тот же мир и 60 с', () => {
  const g = loadEngine();
  const a = makeSim();
  const b = makeSim();
  for (let i = 0; i < 1200; i++) { a.step([]); b.step([]); }
  assert.equal(a.state.tick, 1200);
  assert.equal(a.state.tick * 50, 60000);
  assert.equal(g.Checkpoint.canonicalHash(a.state), g.Checkpoint.canonicalHash(b.state));
});

test('T02: планировщик исполняет только целые шаги 50 мс', async () => {
  const g = loadEngine();
  const { RoomRuntime } = require('../../server/room-runtime.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-step-'));
  let t = 0;
  const clock = {
    now: () => t,
    setTimeout: () => 0,
    setImmediate: () => 0,
    clearTimeout: () => {}
  };
  const r = new RoomRuntime({
    roomId: 'STEP', seed: 'тихая-пойма-123', size: 64,
    players: [{ sessionId: 's1', playerId: 1, owner: 0 }],
    dir, clock
  });
  await r.start();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
  for (const dt of [17, 17, 16]) { t += dt; r.pump(); await wait(); }
  assert.equal(r.tick, 1, 'после 50 мс ровно один шаг');
  for (const dt of [49, 1]) { t += dt; r.pump(); await wait(); }
  assert.equal(r.tick, 2, '49+1 мс — второй шаг, без дробного');
  await r.close('test');
});

test('T03: walk расходует остаток дистанции и не теряет углы', () => {
  const g = loadEngine();
  const W = 200, H = 200;
  const world = {
    width: W, height: H, objects: [], time: 0,
    isLand: new Uint8Array(W * H).fill(1),
    seed: 'walk'
  };
  function run(dt) {
    const v = g.Villagers.blank(world, { id: 1, index: 1, x: 0.5, y: 0.5 });
    v.speed = 1;
    v.state = 'wander';
    v.walked = 0;
    v.path = [];
    for (let i = 0; i < 100; i++) {
      v.path.push({ x: 0.5 + 0.07 * (i + 1), y: 0.5 });
    }
    let time = 0, guard = 0;
    while (v.path && v.path.length && v.step < v.path.length && guard++ < 10000) {
      g.Villagers.walk(v, world, null, dt, 'walk');
      time += dt;
    }
    return { time: time, walked: v.walked };
  }
  const a = run(1 / 60);
  const b = run(0.05);
  /* 100 отрезков по 0.07 = 7.0 клетки. Ошибка — не больше одного шага:
     остаток после конечной точки не переходит в следующее состояние. */
  assert.ok(Math.abs(a.time - 7.0) <= 1 / 60 + 1e-9, '30/60 FPS: ' + a.time);
  assert.ok(Math.abs(b.time - 7.0) <= 0.05 + 1e-9, '20 тиков: ' + b.time);
  assert.ok(Math.abs(a.walked - 7.0) <= 0.05, 'walked = пройденная длина');

  /* Нулевые точки, точное попадание и пустой путь не ломают шаг. */
  const v = g.Villagers.blank(world, { id: 2, index: 2, x: 1, y: 1 });
  v.speed = 1;
  v.path = [{ x: 1, y: 1 }, { x: 1.5, y: 1 }, { x: 1.5, y: 1 }];
  v.step = 0;
  v.walked = 0;
  g.Villagers.walk(v, world, null, 0.25, 'walk');
  assert.ok(Math.abs(v.x - 1.25) < 1e-9, 'прошёл 0.25 через нулевую точку');
  assert.ok(Math.abs(v.walked - 0.25) < 1e-9);
  const empty = g.Villagers.blank(world, { id: 3, index: 3, x: 2, y: 2 });
  empty.path = [];
  g.Villagers.walk(empty, world, null, 0.05, 'walk'); // пустой путь — не ошибка
  assert.equal(empty.x, 2);
});

test('RNG: getState/fromState продолжают ту же последовательность', () => {
  const g = loadEngine();
  const a = new g.RNG('тихая-пойма-123');
  const first = [];
  for (let i = 0; i < 100; i++) first.push(a.next());
  const st = a.getState();
  const b = g.RNG.fromState(st);
  const second = [];
  for (let i = 0; i < 100; i++) second.push(a.next());
  const c = [];
  for (let i = 0; i < 100; i++) c.push(b.next());
  assert.deepEqual(c, second, 'fromState не начинает последовательность заново');
  assert.equal(st.seed, g.hashString('тихая-пойма-123'));
  assert.throws(() => g.RNG.fromState({ seed: -1, state: 0 }), /invalid_rng_state/);
});
