'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEngine, ROOT } = require('./load-engine');

function loadRender() {
  loadEngine();
  if (!globalThis.Render) {
    const code = fs.readFileSync(path.join(ROOT, 'mapgen2/js/render.js'), 'utf8');
    new Function('window', 'document', 'globalThis', code)(undefined, undefined, globalThis);
  }
  return globalThis.Render.Renderer;
}

function world(n) {
  const W = 160, H = 160;
  const w = {
    width: W, height: H, seed: 'chunks', objects: [], removedIds: [],
    objectTotal: n, objectRev: 0, isLand: new Uint8Array(W * H).fill(1)
  };
  for (let i = 0; i < n; i++) {
    w.objects.push({
      kind: i % 17 === 0 ? 'stone' : 'tree',
      x: (i * 37) % W + 0.5,
      y: (i * 53) % H + 0.5,
      scale: 1
    });
  }
  w.objects.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  w.objects.forEach((o, i) => { o.id = i; });
  return w;
}

function fakeRenderer(w) {
  const R = loadRender();
  const r = Object.create(R.prototype);
  r.world = w;
  r.sprites = { meta: { res: [112, 132] }, ppu: 96, mul: 1.35 };
  r.showBuildings = false;
  r.showVillagers = false;
  r.buildings = [];
  r.pending = [];
  r.ghost = null;
  return r;
}

function collect(r, opts, box) {
  const ids = [];
  r.eachSprite(function (o) {
    if (box && (o.x < box.x0 || o.x > box.x1 || o.y < box.y0 || o.y > box.y1)) return;
    ids.push(o.id);
  }, null, null, opts);
  return ids;
}

test('F14: chunk-iterator и full-iterator дают один порядок глубины', () => {
  const w = world(500);
  const r = fakeRenderer(w);
  const box = { x0: 10, x1: 110, y0: 10, y1: 110 };
  const full = collect(r, null, box);
  const chunk = collect(r, { cull: true, box: box }, box);
  assert.deepEqual(chunk, full);
  assert.ok(full.length > 100, 'в кадре достаточно объектов: ' + full.length);
});

test('F14: равная глубина на границе чанка не переставляется', () => {
  const w = {
    width: 64, height: 64, seed: 'tie', objects: [], removedIds: [],
    objectRev: 0, objectTotal: 12
  };
  /* 16 — граница чанка; x+y = 16 у обоих, id задаёт прежний порядок. */
  for (let i = 0; i < 12; i++) {
    w.objects.push({ id: i, kind: 'stone', x: 1 + i, y: 15 - i, scale: 1 });
  }
  w.objects.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  w.objects.forEach((o, i) => { o.id = i; });
  const r = fakeRenderer(w);
  const box = { x0: 0, x1: 63, y0: 0, y1: 63 };
  assert.deepEqual(collect(r, { cull: true, box: box }, box),
    collect(r, null, box));
});

test('F14: удаление и возврат дерева обновляют индекс', () => {
  const w = world(100);
  const r = fakeRenderer(w);
  const box = { x0: 0, x1: 159, y0: 0, y1: 159 };
  const all = collect(r, { cull: true, box: box }, box);
  const gone = w.objects.find((o) => o.kind === 'tree');
  w.objects = w.objects.filter((o) => o !== gone);
  w.objectRev++;
  const after = collect(r, { cull: true, box: box }, box);
  assert.ok(all.indexOf(gone.id) >= 0);
  assert.ok(after.indexOf(gone.id) < 0);
  w.objects.push(gone);
  w.objects.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  w.objectRev++;
  const back = collect(r, { cull: true, box: box }, box);
  assert.ok(back.indexOf(gone.id) >= 0);
});

test('F14: экспорт без culling видит все объекты', () => {
  const w = world(300);
  const r = fakeRenderer(w);
  const ids = collect(r, null, null);
  assert.equal(ids.length, w.objects.length);
  assert.deepEqual(ids, w.objects.map((o) => o.id));
});
