'use strict';

const test = require('node:test');
const assert = require('node:assert');
const SB = require('../../js/snapshot-buffer.js');
const SC = require('../../js/server-clock.js');

function snap(rev, t, villagers, extra) {
  return Object.assign({
    protocol: 4, roomId: 'R', epoch: 1, revision: rev,
    simulationTimeMs: t, serverGeneratedAtMs: t,
    villagers: villagers
  }, extra || {});
}

test('T19: поза идёт по ломаной, а не по хорде через угол', () => {
  const b = SB.create({ protocol: 4, roomId: 'R', epoch: 1 });
  b.push(snap(1, 0, [{ id: 1, x: 0, y: 0, rot: 0 }], { baseline: true }));
  b.push(snap(2, 200, [{
    id: 1, x: 1, y: 1, rot: 90,
    motion: [{ t: 0, x: 0, y: 0, rot: 0 }, { t: 100, x: 1, y: 0, rot: 90 },
      { t: 200, x: 1, y: 1, rot: 90 }]
  }]));
  const p = b.pose(1, 150);
  assert.equal(p.mode, 'interpolated');
  assert.ok(Math.abs(p.x - 1) < 1e-9, 'x на углу: ' + p.x);
  assert.ok(Math.abs(p.y - 0.5) < 1e-9, 'y по второму отрезку: ' + p.y);
});

test('T20: одна renderTime — одна поза при любом числе кадров', () => {
  const b = SB.create({ protocol: 4, roomId: 'R', epoch: 1 });
  b.push(snap(1, 1000, [{ id: 2, x: 0, y: 0, rot: 0, motion: [{ t: 1000, x: 0, y: 0, rot: 0 }] }], { baseline: true }));
  b.push(snap(2, 1100, [{ id: 2, x: 1, y: 0, rot: 90, motion: [{ t: 1000, x: 0, y: 0, rot: 0 }, { t: 1100, x: 1, y: 0, rot: 90 }] }]));
  const a = b.pose(2, 1050);
  for (let i = 0; i < 120; i++) {
    const p = b.pose(2, 1050);
    assert.equal(p.x, a.x); assert.equal(p.y, a.y); assert.equal(p.rot, a.rot);
  }
  assert.equal(a.mode, 'interpolated');
});

test('T21: старые/повторные/неупорядоченные снимки и новый epoch', () => {
  const b = SB.create({ protocol: 4, roomId: 'R', epoch: 1, max: 4 });
  assert.equal(b.push(snap(1, 0, [], { baseline: true })).accepted, true);
  assert.equal(b.push(snap(2, 50, [], {})).accepted, true);
  assert.equal(b.push(snap(2, 50, [], {})).accepted, false);
  assert.equal(b.push(snap(1, 0, [], {})).accepted, false);
  for (let i = 3; i < 10; i++) b.push(snap(i, i * 50, [], {}));
  assert.ok(b.size() <= 4, 'буфер ограничен');
  const e2 = snap(11, 500, [], { epoch: 2, baseline: true });
  const r = b.push(e2);
  assert.equal(r.accepted, true);
  assert.equal(r.reset, true);
  assert.equal(b.epoch(), 2);
  assert.equal(b.lastAccepted(), 11);
});

test('T22: экстраполяция не дольше 100 мс и только по безопасному отрезку', () => {
  const b = SB.create({ protocol: 4, roomId: 'R', epoch: 1 });
  b.push(snap(1, 1000, [{
    id: 3, x: 0, y: 0, rot: 0,
    motion: [{ t: 1000, x: 0, y: 0, rot: 0 }]
  }], { baseline: true }));
  b.push(snap(2, 1100, [{
    id: 3, x: 1, y: 0, rot: 0,
    motion: [{ t: 1000, x: 0, y: 0, rot: 0 }, { t: 1100, x: 1, y: 0, rot: 0 }],
    safeExtrapolationTo: 1200
  }]));
  const ext = b.pose(3, 1150);
  assert.equal(ext.mode, 'extrapolated');
  assert.ok(Math.abs(ext.x - 1.5) < 1e-9);
  const over = b.pose(3, 1700);
  assert.equal(over.mode, 'held');
  assert.equal(over.underflow, true);
  assert.equal(over.stale, true, 'после 500 мс без снимка');
});

test('T23: анимация не перезапускается, spawn/death/teleport по времени', () => {
  const b = SB.create({ protocol: 4, roomId: 'R', epoch: 1 });
  const v = {
    id: 4, x: 0, y: 0, rot: 0, anim: 'walk', animInstance: 7,
    animStartTimeMs: 1000, animDurationMs: 1000, loop: true,
    spawnTimeMs: 1000, deathTimeMs: 5000
  };
  b.push(snap(1, 1000, [v], { baseline: true }));
  const p1 = b.pose(4, 1200);
  const p2 = b.pose(4, 1300);
  assert.equal(p1.animInstance, 7);
  assert.ok(Math.abs(p2.phase - 0.3) < 1e-9, 'фаза от серверного времени');
  assert.equal(b.pose(4, 900).hidden, true, 'до spawn не виден');
  assert.equal(b.pose(4, 5000).hidden, true, 'после death скрыт');
  const v2 = Object.assign({}, v, { x: 5, animInstance: 8, animStartTimeMs: 1300 });
  b.push(snap(2, 1400, [v2]));
  const p3 = b.pose(4, 1450);
  assert.equal(p3.animInstance, 8, 'новая анимация — новый instance');
  assert.ok(Math.abs(p3.x - 5) < 1e-9, 'teleport применён скачком');
});

test('ServerClock: RTT/offset, неубывающее время и rebase нового epoch', () => {
  const c = SC.create({ now: () => 0 });
  c.addSample({ c0: 0, c3: 20, s1: 100, s2: 105 });
  assert.equal(c.error() >= 7.5, true);
  const r1 = c.renderTime({ simulationTimeMs: 1000, serverGeneratedAtMs: 1000, roomStatus: 'running' }, 20, { frameDeltaMs: 16, interpolationDelayMs: 150 });
  const r2 = c.renderTime({ simulationTimeMs: 1000, serverGeneratedAtMs: 1000, roomStatus: 'running' }, 36, { frameDeltaMs: 16, interpolationDelayMs: 150 });
  assert.ok(r1.renderTime > r2.renderTime - 1000);
  c.reset(2);
  const r3 = c.renderTime({ simulationTimeMs: 1000, serverGeneratedAtMs: 1000, roomStatus: 'running' }, 100, { frameDeltaMs: 16 });
  assert.ok(isFinite(r3.renderTime));
});

test('E05: задержка 150 мс + jitter 50 мс не ломает монотонность', () => {
  const c = SC.create({ now: () => 0 });
  for (let i = 0; i < 20; i++) {
    const c0 = i * 100;
    const oneWay = 150 + ((i * 37) % 50);
    c.addSample({ c0: c0, c3: c0 + oneWay * 2, s1: 10000 + c0 + oneWay, s2: 10000 + c0 + oneWay * 2 });
  }
  const latest = { simulationTimeMs: 5000, serverGeneratedAtMs: 15000, roomStatus: 'running' };
  let last = -Infinity;
  for (let t = 0; t < 2000; t += 16) {
    const r = c.renderTime(latest, t, { frameDeltaMs: 16, interpolationDelayMs: 150, clientNow: t });
    assert.ok(isFinite(r.renderTime), 'finite');
    assert.ok(r.renderTime >= last, 'renderTime не идёт назад: ' + last + ' -> ' + r.renderTime);
    last = r.renderTime;
  }
});
