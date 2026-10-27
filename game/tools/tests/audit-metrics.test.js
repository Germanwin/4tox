'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProbe } = require('../../../research/mp-stabilization/tools/probe');
const { computeWindow } = require('../../../research/mp-stabilization/tools/analyze');

function fakeEnv() {
  const env = {
    Play: {
      tick: function () { return 'game'; },
      draw: function () { return 1; },
      state: null
    },
    Hud: { tick: function () { return 2; } },
    document: undefined,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    performance: { now: () => Date.now() }
  };
  return env;
}

test('D02: оригинал вызывается один раз, ошибка — тот же объект', () => {
  const env = fakeEnv();
  let calls = 0;
  const boom = new Error('boom');
  env.Play.tick = function () { calls++; throw boom; };
  const p = createProbe(env, { bindEvents: false });
  assert.equal(p.wrap('Play', 'tick', {
    before: function () { return {}; },
    after: function () {},
    error: function () {}
  }), true);
  p.start({ frames: false });
  let got = null;
  try { env.Play.tick(0.05); } catch (e) { got = e; }
  assert.equal(calls, 1, 'оригинал выполнен ровно один раз');
  assert.strictEqual(got, boom, 'брошен тот же объект');
  p.stop();
});

test('D02: ошибка before/after не меняет результат и считается отдельно', () => {
  const env = fakeEnv();
  env.Play.tick = function () { return 42; };
  const p = createProbe(env, { bindEvents: false });
  p.wrap('Play', 'tick', {
    before: function () { throw new Error('before'); },
    after: function () { throw new Error('after'); }
  });
  p.start({ frames: false });
  assert.equal(env.Play.tick(0.05), 42);
  assert.equal(p.counters().probeErrors, 2);
  p.stop();
  assert.equal(env.Play.tick(0.05), 42, 'выключенный probe не меняет семантику');
});

test('D02: async resolve/reject сохраняют исходный Promise и не повторяют fetch', async () => {
  const env = fakeEnv();
  let fetches = 0;
  env.Play.sync = function () {
    fetches++;
    return Promise.resolve(7);
  };
  const p = createProbe(env, { bindEvents: false });
  let observed = 0;
  p.wrap('Play', 'sync', {
    async: function (sample, promise) {
      observed++;
      promise.then(function () {}, function () {});
    }
  });
  p.start({ frames: false });
  const promise = env.Play.sync();
  assert.equal(await promise, 7);
  assert.equal(fetches, 1);
  assert.equal(observed, 1);
  let rejected = null;
  env.Play.sync2 = function () {
    fetches++;
    rejected = Promise.reject(new Error('no'));
    rejected.catch(function () {});
    return rejected;
  };
  p.wrap('Play', 'sync2', { async: function () { observed++; } });
  const r = env.Play.sync2();
  assert.strictEqual(r, rejected, 'наружу уходит тот же Promise');
  await assert.rejects(r, /no/);
  assert.equal(fetches, 2);
  p.stop();
});

test('D01: полное окно 60 с, 30 обновлений за первые 30 с, затем тишина', () => {
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({ t: (i + 1) * 1000, tick: i * 20, snapshots: i });
  }
  const out = computeWindow({
    measureStart: 0, measureEnd: 60000,
    startSnapshotCount: 0, endSnapshotCount: 30,
    startCommittedTick: 0, endCommittedTick: 600,
    samples: samples, retained: 30, totalEvents: 30, ringWrapped: false
  });
  assert.equal(out.fullWindow.snapshotHz, 0.5);
  assert.equal(out.fullWindow.simRate, 0.5);
  assert.ok(out.activeWindow.snapshotHz > 0.9, 'активная частота около 1 Гц');
  assert.ok(Math.abs(out.trailingGapMs - 30000) < 1e-6, 'хвост 30 с: ' + out.trailingGapMs);
  assert.equal(out.incomplete, false);
  assert.equal(out.notReconstructable, false);
});

test('D01: переполненное кольцо без интегральных счётчиков — not_reconstructable', () => {
  const samples = [];
  for (let i = 0; i < 10; i++) samples.push({ t: (i + 1) * 1000, tick: i * 20, snapshots: i });
  const out = computeWindow({
    measureStart: 0, measureEnd: 60000,
    samples: samples, retained: 10, totalEvents: 100000,
    ringWrapped: true, ringCapacity: 10
  });
  assert.equal(out.incomplete, true);
  assert.equal(out.notReconstructable, true);
  assert.equal(out.fullWindow.snapshotHz, null);
  assert.ok(out.lowerBound);
  assert.equal(out.retained, 10);
  assert.equal(out.totalEvents, 100000);
});
