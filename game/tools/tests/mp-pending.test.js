'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadEngine } = require('./load-engine');

function pending() {
  loadEngine();
  require('../../js/pending.js');
  const P = globalThis.Pending;
  P.reset(0);
  return P;
}
function spec(x, y) {
  return { type: 'house', variant: 'a', rot: 90, x: x, y: y };
}
function snapshot(seq, ids) {
  return {
    seq: seq,
    buildings: ids.map(function (b) {
      return { id: b.id, owner: 0, type: 'house', rot: 90, x: b.x, y: b.y };
    })
  };
}

test('T24: резерв снимается ровно один раз, результат и снимок в любом порядке', () => {
  const P = pending();
  P.addBuild({ commandId: 'c1', cost: 12, spec: spec(10, 10), sentSeq: 0 });
  assert.equal(P.reserved(0), 12);
  P.result('c1', { state: 'applied', ids: ['b1'], appliedRevision: 5 });
  assert.equal(P.reserved(0), 12, 'applied раньше снимка — резерв ещё держится');
  P.reconcile(snapshot(5, [{ id: 'b1', x: 10, y: 10 }]));
  assert.equal(P.reserved(0), 0, 'снимок показал дом — резерв снят');
  assert.equal(P.list().length, 0);

  P.addBuild({ commandId: 'c2', cost: 12, spec: spec(20, 10), sentSeq: 0 });
  P.reconcile(snapshot(6, [{ id: 'b2', x: 20, y: 10 }]));
  assert.equal(P.reserved(0), 12, 'снимок раньше результата резерв не снимает');
  assert.equal(P.buildings().length, 0, 'призрак уже не рисуется: дом виден');
  P.result('c2', { state: 'applied', ids: ['b2'], appliedRevision: 6 });
  P.reconcile(snapshot(6, [{ id: 'b2', x: 20, y: 10 }]));
  assert.equal(P.reserved(0), 0);
});

test('T24: rejected снимает резерв, поздний received не оживляет', () => {
  const P = pending();
  P.addBuild({ commandId: 'c3', cost: 12, spec: spec(30, 10), sentSeq: 0 });
  P.result('c3', { state: 'rejected', reason: 'не хватает брёвен' });
  assert.equal(P.reserved(0), 0);
  assert.equal(P.list().length, 0);
  P.result('c3', { state: 'received' });
  assert.equal(P.list().length, 0, 'received после rejected не возвращает ожидание');
});

test('T25: дом применён и снесён до baseline — ожидание не висит вечно', () => {
  const P = pending();
  P.addBuild({ commandId: 'c4', cost: 12, spec: spec(40, 10), sentSeq: 0 });
  P.result('c4', { state: 'applied', ids: ['gone'], appliedRevision: 10 });
  P.reconcile(snapshot(13, []));   // снимок позже версии применения, дома нет
  assert.equal(P.list().length, 0);
  assert.equal(P.reserved(0), 0);
});

test('T26: 61-е ожидание запрещено, старые не вытеснены', () => {
  const P = pending();
  for (let i = 0; i < 60; i++) {
    assert.ok(P.addBuild({ commandId: 'p' + i, cost: 0, spec: spec(10 + i, 30), sentSeq: 0 }));
  }
  const extra = P.addBuild({ commandId: 'p60', cost: 0, spec: spec(90, 30), sentSeq: 0 });
  assert.equal(extra, null);
  assert.equal(P.list().length, 60);
  assert.equal(P.list()[0].commandId, 'p0', 'первое ожидание не вытеснено');
});
