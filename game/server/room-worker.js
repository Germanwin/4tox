/* room-worker.js — worker одной комнаты.

   Главный поток обслуживает HTTP, лобби, аутентификацию и SSE. Мир считает
   этот worker; в нём нет ни одного браузерного API. Модули движка — те же
   IIFE, что грузит game/index.html, и порядок загрузки тот же: сначала
   зависимости, потом Session/Combat/Army, затем чистые simulation-модули.

   Сообщения типизированы: init, commands, snapshotAck, shutdown,
   diagnostics, testFault. В каждом есть roomId и workerGeneration; результат
   завершённого старого worker'а не может изменить новую комнату. */
'use strict';

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..', '..');
const NetConfig = require(path.join(ROOT, 'game', 'shared', 'net-config.js'));
global.NetConfig = NetConfig;
global.GameplayConfig = require(path.join(ROOT, 'mapgen2', 'js', 'simulation', 'gameplay-config.js'));

function loadEngine(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'document', 'globalThis', code + '\n//# sourceURL=' + rel)(
    undefined, undefined, globalThis);
}

/* Порядок как в game/index.html: rng нужен всем, buildings — session,
   hero — villager, serialize — replication. */
const FILES = [
  'mapgen2/js/noise.js',
  'mapgen2/js/rng.js',
  'mapgen2/js/events.js',
  'mapgen2/js/worldgen.js',
  'mapgen2/js/hero.js',
  'mapgen2/js/buildings.js',
  'mapgen2/js/villager.js',
  'mapgen2/js/session.js',
  'mapgen2/js/combat.js',
  'mapgen2/js/army.js',
  'mapgen2/js/serialize.js',
  'mapgen2/js/simulation/navigation.js',
  'mapgen2/js/simulation/checkpoint.js',
  'mapgen2/js/simulation/commands.js',
  'mapgen2/js/simulation/simulation.js',
  'mapgen2/js/simulation/replication.js'
];
for (const f of FILES) loadEngine(f);

const RoomRuntime = require('./room-runtime').RoomRuntime;

const roomId = workerData && workerData.roomId;
const generation = (workerData && workerData.workerGeneration) || 1;
let runtime = null;
let snapshotInFlight = false;
let pendingSnapshot = null;
let closed = false;

function send(type, data) {
  if (!parentPort) return;
  parentPort.postMessage(Object.assign({
    type: type, roomId: roomId, workerGeneration: generation
  }, data || {}));
}

function canSendSnapshot() {
  return !snapshotInFlight;
}

function shipSnapshot(snap) {
  if (!snap) return;
  if (!canSendSnapshot()) { pendingSnapshot = snap; return; }
  snapshotInFlight = true;
  send('snapshot', { snapshot: snap });
}

async function init(msg) {
  try {
    runtime = new RoomRuntime({
      roomId: roomId,
      workerGeneration: generation,
      seed: msg.seed,
      size: msg.size,
      players: msg.players,
      epoch: msg.epoch || 1,
      dir: msg.stateDir || undefined,
      buildHash: msg.buildHash,
      testMode: !!msg.testMode,
      onSnapshot: function (snap) { shipSnapshot(snap); },
      onFault: function (fault) { send('fault', { fault: fault }); }
    });
    const baseline = await runtime.start();
    send('ready', {
      epoch: runtime.epoch, revision: runtime.revision, tick: runtime.tick,
      baseline: baseline, diagnostics: runtime.diagnostics()
    });
  } catch (e) {
    send('fault', {
      fault: {
        phase: 'init', message: String(e && e.message || e),
        stack: e && e.stack ? String(e.stack).slice(0, 4000) : ''
      }
    });
  }
}

async function onMessage(msg) {
  if (!msg || msg.roomId !== roomId) return;
  if (msg.workerGeneration !== undefined && msg.workerGeneration !== generation) return;
  if (msg.type === 'init') { await init(msg); return; }
  if (!runtime) { send('fault', { fault: { phase: msg.type, message: 'room_not_ready' } }); return; }
  if (msg.type === 'commands') {
    const out = [];
    const list = msg.commands || [];
    for (const item of list) {
      let res;
      try { res = await runtime.submit(item.command); }
      catch (e) { res = { admitted: false, status: 'rejected', reasonCode: 'runtime_error', reason: String(e && e.message || e) }; }
      out.push(Object.assign({ requestId: item.requestId }, res));
    }
    send('received', { commands: out });
    return;
  }
  if (msg.type === 'snapshotAck') {
    runtime.acknowledgeSnapshot(msg.workerGeneration);
    snapshotInFlight = false;
    if (pendingSnapshot) {
      const p = pendingSnapshot;
      pendingSnapshot = null;
      shipSnapshot(p);
    }
    return;
  }
  if (msg.type === 'diagnostics') {
    let commandState = null;
    if (msg.empty !== undefined) runtime.markEmpty(!!msg.empty);
    if (msg.action === 'recover') {
      let recovered;
      try { recovered = await runtime.recover(msg.reason || 'organizer'); }
      catch (e) { recovered = { ok: false, reason: String(e && e.message || e) }; }
      send('diagnostics', {
        diagnostics: runtime.diagnostics(),
        recovery: recovered,
        requestId: msg.requestId
      });
      return;
    }
    if (msg.sessionId) {
      commandState = runtime.commandState(msg.sessionId, msg.ids || []);
      if (msg.watermark !== undefined && msg.watermark !== null) {
        runtime.ackResults(msg.sessionId, msg.watermark);
      }
    }
    send('diagnostics', {
      diagnostics: runtime.diagnostics(),
      commandState: commandState,
      requestId: msg.requestId
    });
    return;
  }
  if (msg.type === 'testFault') {
    if (!(runtime && msg.testMode)) { send('error', { reason: 'test_fault_not_enabled' }); return; }
    runtime.enterFault(new Error(String(msg.message || 'injected fault')), 'testFault');
    return;
  }
  if (msg.type === 'shutdown') {
    closed = true;
    try { await runtime.close(msg.reason || 'shutdown'); } catch (e) { /* закрытие */ }
    send('closed', { reason: msg.reason || 'shutdown' });
    if (parentPort) parentPort.close();
    return;
  }
}

if (parentPort) {
  parentPort.on('message', function (msg) {
    onMessage(msg).catch(function (e) {
      send('fault', { fault: { phase: msg && msg.type, message: String(e && e.message || e) } });
    });
  });
  send('boot', { mode: 'worker', protocol: NetConfig.protocol });
} else {
  module.exports = { RoomRuntime: RoomRuntime };
}
