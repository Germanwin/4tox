/* room-runtime.js — комната: один авторитетный мир, очередь команд и журнал.

   Главный поток HTTP сюда не считает физику. Комната живёт в worker'е и
   двигается по монотонным часам: 20 шагов в секунду, шаг ровно 50 мс,
   остаток меньше шага ждёт следующего вызова. Команда принимается только
   после записи `accept` и fsync; тик становится committed только после
   записи `tickCommit` и fsync.

   Здесь нет DOM и нет renderer. Снимок — представление; checkpoint — полное
   продолжение мира. Это разные форматы и разные пути. */
'use strict';

const path = require('path');
const persistenceMod = require('./persistence');

function nowDefault() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + canonicalJson(v[k]);
  }).join(',') + '}';
}

function hashText(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

function defaultDir() {
  const env = process.env.STATE_DIR;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.resolve(process.cwd(), 'game', 'server', 'var', 'rooms');
}

function sessionInstance(sessionId, owner) {
  return 's' + owner + '-' + hashText(String(sessionId));
}

function makeResult(cmd, status, code, reason, extra) {
  const out = {
    protocol: 4,
    epoch: cmd.epoch,
    commandId: cmd.commandId,
    clientSequence: cmd.clientSequence,
    sessionId: cmd.sessionId,
    playerId: cmd.playerId,
    owner: cmd.owner,
    status: status,
    reasonCode: code || null,
    reason: reason || '',
    ids: [],
    appliedTick: null,
    appliedRevision: null,
    decidedTick: null,
    decidedRevision: null
  };
  if (extra) Object.assign(out, extra);
  return out;
}

function RoomRuntime(options) {
  if (!(this instanceof RoomRuntime)) return new RoomRuntime(options);
  options = options || {};
  this.roomId = String(options.roomId || 'ROOM');
  this.seed = options.seed;
  this.size = options.size || 64;
  this.players = (options.players || []).map((p, i) => ({
    sessionId: String(p.sessionId),
    playerId: p.playerId,
    owner: p.owner === undefined ? i : p.owner,
    name: p.name || ('Игрок ' + (i + 1)),
    instance: p.instance || sessionInstance(p.sessionId, p.owner === undefined ? i : p.owner),
    nextClientSequence: 1,
    watermark: 0,
    minRetainedSequence: 0,
    queue: [],
    rate: { tokens: 40, last: nowDefault() }
  }));
  this.playerBySession = new Map();
  for (const p of this.players) this.playerBySession.set(p.sessionId, p);
  this.dir = options.dir || defaultDir();
  this.epoch = options.epoch || 1;
  this.revision = 0;
  this.tick = 0;
  this.roomOrder = 0;
  this.status = 'starting';
  this.fault = null;
  this.closed = false;
  this.queue = [];
  this.byId = new Map();
  this.resultOrder = [];
  this.recentResults = [];
  this.maxResults = 1024;
  this.latest = null;
  this.baselinePending = true;
  this.snapshotEvery = (options.snapshotEveryTicks || 2);
  this.checkpointEvery = (options.checkpointEveryTicks || 40);
  this.commandsPerTick = options.commandsPerTick || 64;
  this.queuePerPlayer = options.commandQueuePerPlayer || 64;
  this.queuePerRoom = options.commandQueuePerRoom || 256;
  this.emptyGraceMs = options.emptyRoomGraceMs || 600000;
  this.lastActivity = nowDefault();
  this.clock = options.clock || {
    now: nowDefault,
    setTimeout: setTimeout,
    setImmediate: setImmediate,
    clearTimeout: clearTimeout
  };
  this.maxSteps = options.schedulerMaxStepsPerTurn || 4;
  this.budgetMs = options.schedulerBudgetMs || 8;
  this.tickMs = options.tickMs || 50;
  this.debtMs = 0;
  this.lastPump = this.clock.now();
  this.pumping = false;
  this.timer = null;
  this.pendingCommands = [];
  this.interrupted = [];
  this.tickHistory = [];
  this.onSnapshot = options.onSnapshot || null;
  this.onFault = options.onFault || null;
  this.workerGeneration = options.workerGeneration || 1;
  this.buildHash = options.buildHash || null;
  this.gameplay = options.gameplay || global.GameplayConfig;
  this.persistence = null;
  this.lastJournal = null;
  this.admitChain = Promise.resolve();
  this.stats = {
    ticks: 0, snapshots: 0, commandsAccepted: 0, commandsApplied: 0,
    commandsRejected: 0, commandsExpired: 0, faults: 0, stepMs: 0,
    ioMs: 0, maxDebtMs: 0, overloaded: false, slowTicks: 0
  };
}

RoomRuntime.prototype.start = async function () {
  this.persistence = persistenceMod.create({ dir: this.dir, roomId: this.roomId });
  const loaded = await this.persistence.open();
  const meta = loaded || {};
  let restore = null;
  try {
    restore = await this.persistence.loadLatest();
  } catch (e) {
    this.enterFault(e, 'load');
    throw e;
  }
  if (restore && restore.checkpoint) {
    /* Новое поколение: внешняя revision не откатывается вместе с игровым
       временем, epoch растёт, старые worker-сообщения отвергаются. */
    this.epoch = (restore.checkpoint.epoch || this.epoch) + 1;
    const body = restore.checkpoint;
    try {
      this.sim = global.Simulation.fromState(body.sim, { gameplay: this.gameplay });
    } catch (e) {
      this.enterFault(e, 'decode');
      throw e;
    }
    this.tick = body.tick || this.sim.state.tick || 0;
    this.revision = Math.max(body.revision || 0, this.tick);
    if (body.room) this.restoreRoom(body.room);
    if (global.Replication) global.Replication.reset();
    await this.replayJournal(restore.journal || []);
    this.status = 'running';
    this.baselinePending = true;
    this.lastActivity = this.clock.now();
    this.lastPump = this.clock.now();
    this.schedulePump(1);
    const baseline = this.makeSnapshot({ baseline: true });
    this.latest = baseline;
    return baseline;
  }

  /* Чекпоинтов нет: создаём мир и СРАЗУ пишем нулевой checkpoint. Тогда
     следующий запуск восстанавливается из него и читает журнал только после
     его offset, а не переигрывает партию с самого начала. */
  if (!this.seed) throw new Error('room_seed_required');
  this.sim = global.Simulation.create({
    seed: this.seed, size: this.size, players: this.players.length,
    mode: 'multi', gameplay: this.gameplay
  });
  this.epoch = this.epoch || 1;
  this.tick = 0;
  this.revision = 0;
  const startLoc = await this.persistence.append({
    type: 'control', roomId: this.roomId, epoch: this.epoch,
    action: 'room-start', seed: this.seed, size: this.size,
    players: this.players.map((p) => ({ sessionId: p.sessionId, playerId: p.playerId, owner: p.owner, name: p.name, instance: p.instance }))
  });
  this.lastJournal = startLoc;
  await this.writeCheckpoint(0);
  this.status = 'running';
  this.baselinePending = true;
  this.lastActivity = this.clock.now();
  this.lastPump = this.clock.now();
  this.schedulePump(1);
  const baseline = this.makeSnapshot({ baseline: true });
  this.latest = baseline;
  return baseline;
};

RoomRuntime.prototype.restoreRoom = function (room) {
  if (!room) return;
  if (room.roomOrder !== undefined) this.roomOrder = room.roomOrder;
  if (room.revision !== undefined) this.revision = Math.max(this.revision, room.revision);
  if (room.players) {
    for (const ps of room.players) {
      const p = this.playerBySession.get(ps.sessionId);
      if (!p) continue;
      p.instance = ps.instance || p.instance;
      p.nextClientSequence = ps.nextClientSequence || p.nextClientSequence;
      p.watermark = ps.watermark || 0;
      p.minRetainedSequence = ps.minRetainedSequence || 0;
    }
  }
  if (room.results) {
    for (const r of room.results) {
      this.byId.set(r.commandId, r);
      this.resultOrder.push(r.commandId);
      this.recentResults.push(r);
      this.applyResultToPlayer(r);
    }
    this.trimResults();
  }
  if (room.queue) {
    for (const c of room.queue) {
      this.queue.push(c);
      this.byId.set(c.commandId, makeResult(c, 'received', null, ''));
      const p = this.playerBySession.get(c.sessionId);
      if (p) p.queue.push(c);
    }
  }
};

RoomRuntime.prototype.replayJournal = async function (records) {
  for (const rec of records) {
    const r = rec.record;
    if (!r) continue;
    if (r.type === 'accept') {
      /* accept после checkpoint: команда принята, но ещё не исполнена (если
         ниже нет её tickCommit). Восстановление НЕ исполняет её здесь. */
      if (!this.byId.has(r.command.commandId)) {
        this.byId.set(r.command.commandId, makeResult(r.command, 'received', null, ''));
        this.queue.push(r.command);
        const p = this.playerBySession.get(r.command.sessionId);
        if (p) {
          p.queue.push(r.command);
          if (r.command.clientSequence >= p.nextClientSequence) {
            p.nextClientSequence = r.command.clientSequence + 1;
          }
        }
      }
    } else if (r.type === 'tickCommit') {
      if (r.tick <= this.sim.state.tick) continue;
      const before = this.sim.state.tick;
      const out = this.sim.step(r.commands || []);
      const after = this.sim.state.tick;
      if (after !== r.tick) {
        throw new Error('replay_tick_mismatch:' + before + '->' + after + ' expected ' + r.tick);
      }
      this.tick = after;
      this.revision = r.revision;
      const results = r.results || [];
      for (const res of results) {
        this.byId.set(res.commandId, res);
        this.resultOrder.push(res.commandId);
        this.recentResults.push(res);
        this.applyResultToPlayer(res);
      }
      this.recentResults = this.recentResults.slice(-200);
      this.queue = this.queue.filter(function (c) {
        return !results.some(function (x) { return x.commandId === c.commandId; });
      });
      for (const p of this.players) p.queue = p.queue.filter(function (c) {
        return !results.some(function (x) { return x.commandId === c.commandId; });
      });
    } else if (r.type === 'control') {
      if (r.action === 'terminal') {
        this.status = r.status || 'over';
      } else if (r.action === 'epoch') {
        this.epoch = Math.max(this.epoch, r.epoch || this.epoch);
      }
    }
  }
};

RoomRuntime.prototype.applyResultToPlayer = function (res) {
  const p = this.playerBySession.get(res.sessionId);
  if (!p) return;
  if (res.status !== 'received' && res.status !== 'unknown') {
    const seq = res.clientSequence;
    if (typeof seq === 'number' && seq + 1 > p.minRetainedSequence) {
      p.minRetainedSequence = seq + 1;
    }
  }
};

RoomRuntime.prototype.trimResults = function () {
  /* Один commandId мог попасть в resultOrder дважды (received и terminal).
     Без дедупликации потолок вытеснял бы СВЕЖИЙ результат парой старых
     записей одного и того же ID. */
  const unique = [];
  const seen = Object.create(null);
  for (const id of this.resultOrder) {
    if (!this.byId.has(id) || seen[id]) continue;
    seen[id] = 1;
    unique.push(id);
  }
  this.resultOrder = unique;
  while (this.resultOrder.length > this.maxResults) {
    const id = this.resultOrder.shift();
    this.byId.delete(id);
  }
  this.recentResults = this.recentResults.slice(-200);
};

RoomRuntime.prototype.checkRate = function (p) {
  const now = this.clock.now();
  const r = p.rate;
  const dt = Math.max(0, now - r.last) / 1000;
  r.last = now;
  r.tokens = Math.min(40, r.tokens + dt * 20);
  if (r.tokens < 1) return false;
  r.tokens -= 1;
  return true;
};

RoomRuntime.prototype.normalizeCommand = function (auth) {
  const cmd = auth && auth.command ? auth.command : auth;
  return {
    protocol: cmd.protocol,
    roomId: cmd.roomId,
    epoch: cmd.epoch,
    commandId: String(cmd.commandId || ''),
    clientSequence: cmd.clientSequence,
    type: cmd.type,
    payload: cmd.payload === undefined ? null : cmd.payload,
    sessionId: auth.sessionId,
    playerId: auth.playerId,
    owner: auth.owner,
    receivedAt: this.clock.now(),
    roomOrder: 0
  };
};

RoomRuntime.prototype.findPlayer = function (sessionId) {
  return this.playerBySession.get(String(sessionId)) || null;
};

/* Приём команды. Возвращает receipt сразу после durable accept; исполнение —
   на границе тика. HTTP 202/receipt значит `received`, а не `applied`. */
RoomRuntime.prototype.submit = function (authenticatedCommand) {
  const self = this;
  this.admitChain = this.admitChain.then(function () {
    return self.submitNow(authenticatedCommand);
  });
  return this.admitChain;
};

RoomRuntime.prototype.submitNow = async function (auth) {
  if (this.closed) return { admitted: false, status: 'rejected', reasonCode: 'room_closed' };
  if (this.status === 'faulted') return { admitted: false, status: 'faulted', reasonCode: 'room_faulted' };
  if (this.status === 'over') return { admitted: false, status: 'rejected', reasonCode: 'game_over' };
  const cmd = this.normalizeCommand(auth);
  if (!cmd.sessionId) return { admitted: false, status: 'rejected', reasonCode: 'no_session' };
  const p = this.findPlayer(cmd.sessionId);
  if (!p) return { admitted: false, status: 'rejected', reasonCode: 'unknown_session' };
  if (!cmd.commandId || cmd.commandId.indexOf(':') < 0) {
    return { admitted: false, status: 'rejected', reasonCode: 'bad_command_id' };
  }
  if (cmd.protocol !== 4) return { admitted: false, status: 'rejected', reasonCode: 'bad_protocol' };
  if (cmd.roomId !== this.roomId) return { admitted: false, status: 'rejected', reasonCode: 'bad_room' };
  if (!cmd.type || typeof cmd.type !== 'string') {
    return { admitted: false, status: 'rejected', reasonCode: 'bad_type' };
  }
  const known = this.byId.get(cmd.commandId);
  if (known) {
    const same = known.fingerprint === canonicalJson(cmd.payload);
    if (!same) return { admitted: false, status: 'rejected', reasonCode: 'command_id_conflict' };
    return {
      admitted: true, status: known.status, duplicate: true,
      commandId: cmd.commandId, epoch: known.epoch,
      appliedTick: known.appliedTick, appliedRevision: known.appliedRevision,
      reasonCode: known.reasonCode, reason: known.reason, ids: known.ids,
      nextClientSequence: p.nextClientSequence
    };
  }
  if (cmd.epoch !== this.epoch) {
    return {
      admitted: false, status: 'stale_epoch', reasonCode: 'stale_epoch',
      epoch: this.epoch, tick: this.tick, revision: this.revision,
      nextClientSequence: p.nextClientSequence
    };
  }
  if (!Number.isInteger(cmd.clientSequence) || cmd.clientSequence < 1) {
    return { admitted: false, status: 'rejected', reasonCode: 'bad_sequence' };
  }
  if (cmd.clientSequence > p.nextClientSequence) {
    return { admitted: false, status: 'rejected', reasonCode: 'sequence_gap',
      nextClientSequence: p.nextClientSequence };
  }
  if (cmd.clientSequence < p.nextClientSequence) {
    return { admitted: false, status: 'history_expired', reasonCode: 'history_expired',
      boundary: p.minRetainedSequence, nextClientSequence: p.nextClientSequence };
  }
  if (!this.checkRate(p)) {
    return { admitted: false, status: 'rejected', reasonCode: 'rate_limited',
      nextClientSequence: p.nextClientSequence };
  }
  if (this.queue.length >= this.queuePerRoom) {
    return { admitted: false, status: 'rejected', reasonCode: 'room_queue_full' };
  }
  if (p.queue.length >= this.queuePerPlayer) {
    return { admitted: false, status: 'rejected', reasonCode: 'player_queue_full' };
  }
  cmd.roomOrder = ++this.roomOrder;
  cmd.fingerprint = canonicalJson(cmd.payload);
  const accepted = makeResult(cmd, 'received', null, '');
  accepted.fingerprint = cmd.fingerprint;
  accepted.roomOrder = cmd.roomOrder;
  const record = {
    type: 'accept', roomId: this.roomId, epoch: this.epoch,
    command: cmd, roomOrder: cmd.roomOrder
  };
  let loc;
  try {
    loc = await this.persistence.append(record);
  } catch (e) {
    this.enterFault(e, 'accept');
    return { admitted: false, status: 'rejected', reasonCode: 'persistence_error' };
  }
  /* Только после fsync: ID стал consumed. */
  this.byId.set(cmd.commandId, accepted);
  this.resultOrder.push(cmd.commandId);
  this.queue.push(cmd);
  p.queue.push(cmd);
  p.nextClientSequence = cmd.clientSequence + 1;
  this.stats.commandsAccepted++;
  this.lastActivity = this.clock.now();
  this.lastJournal = loc;
  return {
    admitted: true, status: 'received', commandId: cmd.commandId,
    clientSequence: cmd.clientSequence, roomOrder: cmd.roomOrder,
    epoch: this.epoch, tick: this.tick, revision: this.revision,
    nextClientSequence: p.nextClientSequence,
    journal: { segment: loc.segment, offset: loc.offset }
  };
};

RoomRuntime.prototype.selectCommands = function () {
  if (!this.queue.length) return [];
  this.queue.sort(function (a, b) { return a.roomOrder - b.roomOrder; });
  const out = this.queue.slice(0, this.commandsPerTick);
  return out;
};

RoomRuntime.prototype.removeQueued = function (commands) {
  const ids = new Set(commands.map(function (c) { return c.commandId; }));
  this.queue = this.queue.filter(function (c) { return !ids.has(c.commandId); });
  for (const p of this.players) {
    p.queue = p.queue.filter(function (c) { return !ids.has(c.commandId); });
  }
};

RoomRuntime.prototype.publishSnapshot = function (opts) {
  opts = opts || {};
  const snap = this.makeSnapshot(opts);
  this.latest = snap;
  this.stats.snapshots++;
  if (typeof this.onSnapshot === 'function') {
    try { this.onSnapshot(snap); } catch (e) { /* транспорт не роняет мир */ }
  }
  return snap;
};

RoomRuntime.prototype.makeSnapshot = function (opts) {
  opts = opts || {};
  const results = this.pendingResultBlock();
  const snap = global.Replication.build(this.sim.state, {
    protocol: 4,
    roomId: this.roomId,
    epoch: this.epoch,
    revision: this.revision,
    serverGeneratedAtMs: Math.round(this.clock.now()),
    baseline: !!opts.baseline || this.baselinePending,
    roomStatus: this.status,
    commandResults: results
  });
  if (snap.baseline) this.baselinePending = false;
  return snap;
};

RoomRuntime.prototype.pendingResultBlock = function () {
  /* Результаты незакрытых команд — персональный блок. Здесь отдаём последние
     решения (не больше 40) с sessionId/playerId; main отфильтрует своему
     клиенту. Приватных токенов тут нет. */
  const out = [];
  for (let i = this.recentResults.length - 1; i >= 0 && out.length < 40; i--) {
    const r = this.recentResults[i];
    if (!r || r.status === 'received') continue;
    out.push({
      commandId: r.commandId, clientSequence: r.clientSequence,
      sessionId: r.sessionId, playerId: r.playerId, owner: r.owner,
      status: r.status, reasonCode: r.reasonCode, reason: r.reason,
      ids: r.ids || [], appliedTick: r.appliedTick,
      appliedRevision: r.appliedRevision, decidedTick: r.decidedTick,
      decidedRevision: r.decidedRevision, epoch: r.epoch
    });
  }
  return out.reverse();
};

RoomRuntime.prototype.writeCheckpoint = async function (tick) {
  const dto = this.sim.exportState();
  const room = {
    roomOrder: this.roomOrder,
    revision: this.revision,
    players: this.players.map(function (p) {
      return {
        sessionId: p.sessionId, playerId: p.playerId, owner: p.owner,
        instance: p.instance, nextClientSequence: p.nextClientSequence,
        watermark: p.watermark, minRetainedSequence: p.minRetainedSequence
      };
    }),
    results: this.recentResults.slice(-600),
    queue: this.queue.slice()
  };
  const started = this.clock.now();
  const loc = this.lastJournal || { segment: this.persistence.segment, offset: 0 };
  const journalOffset = loc.offset + (loc.bytes || 0);
  const written = await this.persistence.writeCheckpoint(dto, {
    tick: this.tick, revision: this.revision, epoch: this.epoch,
    journalSegment: loc.segment, journalOffset: journalOffset,
    room: room
  });
  this.stats.ioMs += this.clock.now() - started;
  return written;
};

RoomRuntime.prototype.executeAndCommitOneTick = async function () {
  if (this.status !== 'running') return false;
  const selected = this.selectCommands();
  const started = this.clock.now();
  let out;
  try {
    out = this.sim.step(selected);
  } catch (e) {
    this.interrupted = selected.slice();
    this.enterFault(e, 'step');
    throw e;
  }
  this.stats.stepMs += this.clock.now() - started;
  const nextRevision = this.revision + 1;
  const results = [];
  for (const r of out.commandResults) {
    const cmd = selected.find(function (c) { return c.commandId === r.commandId; });
    const terminal = makeResult(cmd || r, r.status, r.reasonCode, r.reason, {
      ids: r.ids || [],
      appliedTick: r.status === 'applied' ? out.tick : null,
      appliedRevision: r.status === 'applied' ? nextRevision : null,
      decidedTick: out.tick, decidedRevision: nextRevision
    });
    terminal.epoch = this.epoch;
    terminal.fingerprint = cmd ? cmd.fingerprint : (r.fingerprint || null);
    results.push(terminal);
  }
  const record = {
    type: 'tickCommit', roomId: this.roomId, epoch: this.epoch,
    tick: out.tick, revision: nextRevision,
    commands: selected, results: results,
    events: out.events || [], structureVersion: out.structureVersion
  };
  const ioStart = this.clock.now();
  let loc;
  try {
    loc = await this.persistence.append(record);
  } catch (e) {
    this.interrupted = selected.slice();
    this.enterFault(e, 'tickCommit');
    throw e;
  }
  this.stats.ioMs += this.clock.now() - ioStart;
  /* FSync прошёл: только теперь тик committed. */
  this.lastJournal = loc;
  this.tick = out.tick;
  this.revision = nextRevision;
  this.stats.ticks++;
  this.removeQueued(selected);
  for (const r of results) {
    this.byId.set(r.commandId, r);
    this.resultOrder.push(r.commandId);
    this.recentResults.push(r);
    this.applyResultToPlayer(r);
    if (r.status === 'applied') this.stats.commandsApplied++;
    else this.stats.commandsRejected++;
  }
  this.trimResults();
  this.lastActivity = this.clock.now();

  const snapshotDue = (this.tick % this.snapshotEvery === 0) ||
    out.over || this.baselinePending;
  if (snapshotDue) this.publishSnapshot({});

  if (this.tick % this.checkpointEvery === 0) {
    try { await this.writeCheckpoint(this.tick); }
    catch (e) { this.enterFault(e, 'checkpoint'); throw e; }
  }
  if (out.over && this.status === 'running') {
    this.status = 'over';
    try {
      await this.persistence.append({
        type: 'control', roomId: this.roomId, epoch: this.epoch,
        action: 'terminal', status: 'over', tick: this.tick, revision: this.revision,
        winner: out.winner === undefined ? this.sim.state.winner : out.winner
      });
      await this.writeCheckpoint(this.tick);
    } catch (e) { this.enterFault(e, 'terminal'); throw e; }
  }
  return true;
};

RoomRuntime.prototype.schedulePump = function (delay) {
  if (this.closed || this.status === 'faulted' || this.status === 'suspended') return;
  const self = this;
  if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
  this.timer = this.clock.setTimeout(function () { self.pump(); }, Math.max(1, delay | 0));
};

RoomRuntime.prototype.pump = function () {
  const self = this;
  if (this.closed || this.status === 'faulted' || this.status === 'suspended') return;
  if (this.pumping) return;
  this.pumping = true;
  const now = this.clock.now();
  this.debtMs += Math.max(0, now - this.lastPump);
  this.lastPump = now;
  if (this.debtMs > this.stats.maxDebtMs) this.stats.maxDebtMs = this.debtMs;
  if (this.debtMs > 250) this.stats.overloaded = true;
  const started = now;
  let steps = 0;
  const run = async function () {
    try {
      while (self.debtMs + 1e-6 >= self.tickMs && steps < self.maxSteps) {
        if (steps > 0 && self.clock.now() - started >= self.budgetMs) break;
        await self.executeAndCommitOneTick();
        self.debtMs -= self.tickMs;
        steps++;
        if (self.closed || self.status !== 'running') break;
      }
    } catch (e) {
      /* executeAndCommitOneTick уже вызвал enterFault. Повторять шаг нельзя. */
    } finally {
      self.pumping = false;
    }
    if (self.closed || self.status === 'faulted' || self.status === 'suspended') return;
    if (self.debtMs >= self.tickMs) self.clock.setImmediate(function () { self.pump(); });
    else {
      const elapsed = self.clock.now() - self.lastPump;
      const delay = Math.max(1, self.tickMs - self.debtMs - Math.max(0, elapsed));
      self.schedulePump(delay);
    }
  };
  run();
};

RoomRuntime.prototype.enterFault = function (error, phase) {
  if (this.status === 'faulted') return;
  this.status = 'faulted';
  this.stats.faults++;
  this.fault = {
    phase: phase || 'unknown',
    message: String(error && error.message || error),
    tick: this.tick,
    revision: this.revision,
    epoch: this.epoch,
    at: this.clock.now(),
    entity: error && error.__4tox ? error.__4tox.entity : null
  };
  if (this.timer) { try { this.clock.clearTimeout(this.timer); } catch (e) {} this.timer = null; }
  const self = this;
  /* Последняя опубликованная версия остаётся последней committed. Клиенты
     получают явный room-fault, а не «здоровое ожидание снимка». */
  try {
    if (typeof this.onFault === 'function') this.onFault(this.fault);
  } catch (e) { /* транспорт не должен маскировать ошибку */ }
  if (this.persistence) {
    this.persistence.append({
      type: 'control', roomId: this.roomId, epoch: this.epoch,
      action: 'fault', fault: this.fault
    }).catch(function () {});
  }
};

RoomRuntime.prototype.acknowledgeSnapshot = function (generation) {
  /* ACK означает: main принял снимок в свой latest и клиентские слоты.
     Он не ждёт самого медленного клиента. Worker может слать следующий. */
  if (generation !== undefined && generation !== this.workerGeneration) return false;
  return true;
};

/* Восстановление после логической ошибки. Вызывается организатором через
   защищённое действие комнаты, а не автоматически: повторять частично
   выполненный шаг нельзя. Команды, выбранные для упавшего тика, получают
   durable rejected/recovery_interrupted, остальные received ждут в очереди. */
RoomRuntime.prototype.recover = async function (reason) {
  if (this.status !== 'faulted') return { ok: false, reason: 'not_faulted' };
  const loaded = await this.persistence.loadLatest();
  if (!loaded || !loaded.checkpoint) return { ok: false, reason: 'no_checkpoint' };
  const body = loaded.checkpoint;
  const interruptedIds = new Set((this.interrupted || []).map(function (c) { return c.commandId; }));
  const previousEpoch = this.epoch;
  this.epoch = (body.epoch || this.epoch) + 1;
  this.sim = global.Simulation.fromState(body.sim, { gameplay: this.gameplay });
  global.Replication.reset();
  this.tick = body.tick || 0;
  this.revision = Math.max(body.revision || 0, this.tick);
  this.byId.clear();
  this.resultOrder = [];
  this.recentResults = [];
  this.queue = [];
  for (const p of this.players) p.queue = [];
  this.restoreRoom(body.room);
  await this.replayJournal(loaded.journal || []);
  /* Прерванные команды — durable отказ, а не «может, выполнилось». */
  for (const id of interruptedIds) {
    const r = this.byId.get(id);
    if (!r) continue;
    const rejected = Object.assign({}, r, {
      status: 'rejected', reasonCode: 'recovery_interrupted',
      reason: 'тик прерван восстановлением: команда не применена',
      decidedTick: this.tick, decidedRevision: this.revision,
      appliedTick: null, appliedRevision: null
    });
    this.byId.set(id, rejected);
    this.recentResults.push(rejected);
    this.applyResultToPlayer(rejected);
    this.queue = this.queue.filter(function (c) { return c.commandId !== id; });
    for (const p of this.players) p.queue = p.queue.filter(function (c) { return c.commandId !== id; });
  }
  this.trimResults();
  this.interrupted = [];
  this.fault = null;
  this.status = 'running';
  this.baselinePending = true;
  this.lastPump = this.clock.now();
  this.debtMs = 0;
  this.lastActivity = this.clock.now();
  try {
    await this.persistence.append({
      type: 'control', roomId: this.roomId, epoch: this.epoch,
      action: 'recover', fromEpoch: previousEpoch, reason: reason || 'organizer',
      interrupted: Array.from(interruptedIds), tick: this.tick, revision: this.revision
    });
    await this.writeCheckpoint(this.tick);
  } catch (e) {
    this.enterFault(e, 'recover');
    return { ok: false, reason: String(e && e.message || e) };
  }
  this.publishSnapshot({ baseline: true });
  this.schedulePump(1);
  return { ok: true, epoch: this.epoch, tick: this.tick, revision: this.revision };
};

RoomRuntime.prototype.commandState = function (sessionId, ids) {
  const out = [];
  const p = this.findPlayer(sessionId);
  const list = Array.isArray(ids) ? ids : [];
  for (let i = 0; i < list.length && i < 200; i++) {
    const id = String(list[i]);
    const r = this.byId.get(id);
    if (r) {
      out.push({
        commandId: id, status: r.status, reasonCode: r.reasonCode,
        reason: r.reason, ids: r.ids || [], appliedTick: r.appliedTick,
        appliedRevision: r.appliedRevision, decidedTick: r.decidedTick,
        decidedRevision: r.decidedRevision, epoch: r.epoch
      });
    } else {
      const seq = (function () {
        const m = /:(\d+)$/.exec(id);
        return m ? parseInt(m[1], 10) : null;
      })();
      if (p && seq !== null && seq < p.minRetainedSequence) {
        out.push({ commandId: id, status: 'history_expired',
          boundary: p.minRetainedSequence, epoch: this.epoch });
      } else {
        out.push({ commandId: id, status: 'unknown', epoch: this.epoch });
      }
    }
  }
  return {
    protocol: 4, roomId: this.roomId, epoch: this.epoch,
    revision: this.revision, tick: this.tick,
    nextClientSequence: p ? p.nextClientSequence : null,
    watermark: p ? p.watermark : null,
    roomStatus: this.status,
    results: out
  };
};

RoomRuntime.prototype.ackResults = function (sessionId, watermark) {
  const p = this.findPlayer(sessionId);
  if (!p) return false;
  p.watermark = Math.max(p.watermark, Number(watermark) || 0);
  return true;
};

RoomRuntime.prototype.latestSnapshot = function () {
  return this.latest;
};

RoomRuntime.prototype.diagnostics = function () {
  return {
    roomId: this.roomId,
    workerGeneration: this.workerGeneration,
    status: this.status,
    epoch: this.epoch,
    tick: this.tick,
    revision: this.revision,
    roomOrder: this.roomOrder,
    queues: {
      room: this.queue.length,
      players: this.players.map(function (p) { return { owner: p.owner, queue: p.queue.length, watermark: p.watermark }; })
    },
    results: { retained: this.byId.size, recent: this.recentResults.length },
    stats: Object.assign({}, this.stats, {
      debtMs: this.debtMs,
      lastActivityAgeMs: this.clock.now() - this.lastActivity
    }),
    fault: this.fault,
    sim: this.sim ? this.sim.diagnostics() : null,
    persistence: this.persistence ? this.persistence.diagnostics() : null
  };
};

RoomRuntime.prototype.close = async function (reason) {
  if (this.closed) return;
  this.closed = true;
  if (this.timer) { try { this.clock.clearTimeout(this.timer); } catch (e) {} this.timer = null; }
  if (this.persistence) {
    try {
      await this.persistence.append({
        type: 'control', roomId: this.roomId, epoch: this.epoch,
        action: 'close', reason: reason || 'closed', tick: this.tick, revision: this.revision
      });
    } catch (e) { /* закрытие не должно падать из-за журнала */ }
    try { await this.writeCheckpoint(this.tick); } catch (e) { /* последний шанс */ }
    await this.persistence.close();
  }
  this.status = 'closed';
};

RoomRuntime.prototype.markEmpty = function (empty) {
  if (!empty) {
    this.lastActivity = this.clock.now();
    this._emptySince = 0;
    if (this.status === 'suspended') {
      this.status = 'running';
      this.lastPump = this.clock.now();
      this.debtMs = 0;
      this.baselinePending = true;
      this.schedulePump(1);
    }
    return;
  }
  if (!this._emptySince) this._emptySince = this.clock.now();
  if (this.clock.now() - this._emptySince > this.emptyGraceMs && this.status === 'running') {
    this.status = 'suspended';
    if (this.timer) { try { this.clock.clearTimeout(this.timer); } catch (e) {} this.timer = null; }
    const self = this;
    this.persistence.append({
      type: 'control', roomId: this.roomId, epoch: this.epoch,
      action: 'suspend', tick: this.tick, revision: this.revision
    }).then(function () { return self.writeCheckpoint(self.tick); }).catch(function () {});
  }
};

RoomRuntime.prototype.runTicks = async function (n) {
  for (let i = 0; i < n; i++) await this.executeAndCommitOneTick();
  return this.tick;
};

module.exports = {
  RoomRuntime: RoomRuntime,
  create: function (opts) { return new RoomRuntime(opts); },
  canonicalJson: canonicalJson
};
