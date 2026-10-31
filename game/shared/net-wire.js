/* net-wire.js — компактный двоичный кадр состояния для WebSocket.

   Зачем. JSON-снимок на 300 жителях весит ~110–135 КБ и содержит до 55 %
   имён полей и объектов motion; 10 таких кадров в секунду — это больше
   мегабайта на клиента, а разбор/GC на главной нити браузера дают рывки.
   Здесь тот же снимок кодируется числами: координата — 1/100 клетки в u16,
   поворот — u16, поля-умолчания не пишутся вовсе, motion — по 10 байт на
   точку. На 300 жителях кадр выходит ~15–25 КБ.

   Формат намеренно ПОЛНЫЙ, а не дельта: TCP/WebSocket и так доставляет кадры
   по порядку, а полный кадр переживает переподключение и потерю любого
   предыдущего. Дельта потребовала бы истории на каждого клиента и дала бы
   рассинхрон после reconnect — цена, не оправданная на 300–1000 сущностях.

   Кодек общий для браузера и Node: IIFE, без зависимостей, как net-config.
   Он не знает правил игры и не меняет состояние — только представление. */
(function (global) {
  'use strict';

  var MAGIC = 0x31585434;        // little-endian "4TX1" на проводе
  var VERSION = 1;
  var TYPE_SNAPSHOT = 1;
  var NULL_STR = 0xFFFF;
  var F_BASELINE = 1;
  var F_RESULTS = 2;

  var TD = global.TextDecoder ? new global.TextDecoder() : null;
  var TE = global.TextEncoder ? new global.TextEncoder() : null;

  function encodeUtf8(s) {
    if (TE) return TE.encode(String(s));
    return new Uint8Array(Buffer.from(String(s), 'utf8'));
  }
  function decodeUtf8(bytes) {
    if (TD) return TD.decode(bytes);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  }
  function clampInt(n, lo, hi) {
    n = Math.round(Number(n) || 0);
    return n < lo ? lo : (n > hi ? hi : n);
  }
  function coord(v) { return clampInt((Number(v) || 0) * 100, 0, 65535); }
  function coordOut(v) { return v / 100; }
  function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
  function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
  function round3(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }

  /* ------------------------------ writer ------------------------------ */
  function Writer(size) {
    this.buf = new Uint8Array(size || 8192);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  Writer.prototype.need = function (n) {
    var want = this.len + n;
    if (want <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < want) cap *= 2;
    var next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  };
  Writer.prototype.u8 = function (v) {
    this.need(1);
    this.buf[this.len++] = v & 255;
  };
  Writer.prototype.u16 = function (v) {
    this.need(2);
    this.view.setUint16(this.len, v & 0xFFFF, true);
    this.len += 2;
  };
  Writer.prototype.u32 = function (v) {
    this.need(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  };
  Writer.prototype.i32 = function (v) {
    this.need(4);
    this.view.setInt32(this.len, v | 0, true);
    this.len += 4;
  };
  Writer.prototype.f32 = function (v) {
    this.need(4);
    this.view.setFloat32(this.len, Number(v) || 0, true);
    this.len += 4;
  };
  Writer.prototype.f64 = function (v) {
    this.need(8);
    this.view.setFloat64(this.len, Number(v) || 0, true);
    this.len += 8;
  };
  Writer.prototype.varint = function (v) {
    v = Number(v) >>> 0;
    while (v >= 0x80) {
      this.u8((v & 0x7F) | 0x80);
      v = v >>> 7;
    }
    this.u8(v);
  };
  Writer.prototype.str = function (s) {
    var bytes = encodeUtf8(s === undefined || s === null ? '' : s);
    this.varint(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  };
  Writer.prototype.bytes = function (bytes) {
    this.varint(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  };
  Writer.prototype.finish = function () {
    return this.buf.slice(0, this.len);
  };

  /* ------------------------------ reader ------------------------------ */
  function Reader(bytes) {
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.len = bytes.byteLength;
    this.off = 0;
  }
  Reader.prototype.need = function (n) {
    if (this.off + n > this.len) throw new Error('wire: кадр короче заголовка');
  };
  Reader.prototype.u8 = function () {
    this.need(1);
    return this.buf[this.off++];
  };
  Reader.prototype.u16 = function () {
    this.need(2);
    var v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  };
  Reader.prototype.u32 = function () {
    this.need(4);
    var v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  };
  Reader.prototype.i32 = function () {
    this.need(4);
    var v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  };
  Reader.prototype.f32 = function () {
    this.need(4);
    var v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  };
  Reader.prototype.f64 = function () {
    this.need(8);
    var v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  };
  Reader.prototype.varint = function () {
    var v = 0, shift = 0, b;
    do {
      b = this.u8();
      v += (b & 0x7F) * Math.pow(2, shift);
      shift += 7;
      if (shift > 35) throw new Error('wire: слишком длинный varint');
    } while (b & 0x80);
    return v >>> 0;
  };
  Reader.prototype.str = function () {
    var n = this.varint();
    this.need(n);
    var s = decodeUtf8(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  };
  Reader.prototype.bytes = function () {
    var n = this.varint();
    this.need(n);
    var out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  };

  /* --------------------------- string table --------------------------- *
   * Одинаковые имена (id построек, анимации, состояния) пишутся один раз.
   * NULL_STR — «поля нет»; пустая строка — законное значение. */
  function buildTable(snap) {
    var map = new Map();
    var list = [];
    function add(s) {
      if (s === undefined || s === null) return NULL_STR;
      s = String(s);
      var i = map.get(s);
      if (i !== undefined) return i;
      i = list.length;
      if (i >= NULL_STR) throw new Error('wire: больше 65534 строк');
      map.set(s, i);
      list.push(s);
      return i;
    }
    add(snap.roomId);
    add(snap.worldgenVersion);
    add(snap.worldgenHash);
    add(snap.gameplayConfigHash);
    add(snap.seed);
    add(snap.roomStatus);
    var towns = snap.towns || [];
    for (var t = 0; t < towns.length; t++) {
      add(towns[t].name); add(towns[t].color);
    }
    var bs = snap.buildings || [];
    for (var b = 0; b < bs.length; b++) {
      add(bs[b].id); add(bs[b].type); add(bs[b].variant);
    }
    var vs = snap.villagers || [];
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      add(v.anim); add(v.state);
      add(v.trainingId); add(v.homeId); add(v.employerId);
      add(v.campId); add(v.stationId);
    }
    var rs = snap.commandResults || [];
    for (var r = 0; r < rs.length; r++) {
      add(rs[r].commandId); add(rs[r].sessionId);
      add(rs[r].status); add(rs[r].reasonCode); add(rs[r].reason);
    }
    return { list: list, idx: function (s) { return add(s); } };
  }

  var VF = {
    FROZEN: 1 << 0, WARRIOR: 1 << 1, TRAINEE: 1 << 2, HIDDEN: 1 << 3,
    CARRYING: 1 << 4, DEAD: 1 << 5, TELEPORT: 1 << 6,
    HP: 1 << 7, HP_UNTIL: 1 << 8, FLINCH: 1 << 9, ATTACK_T: 1 << 10,
    TRAINING: 1 << 11, HOME: 1 << 12, EMPLOYER: 1 << 13, CAMP: 1 << 14,
    STATION: 1 << 15, APPEAR: 1 << 16, VANISH: 1 << 17, EMERGE: 1 << 18,
    ORDER: 1 << 19, DEATH: 1 << 20, SAFE: 1 << 21, PHASE: 1 << 22,
    ANIM: 1 << 23, STATE: 1 << 24, OWNER: 1 << 25, TOWN: 1 << 26
  };

  /* ------------------------------- pack ------------------------------- */
  function packSnapshot(snap, opts) {
    if (!snap || typeof snap !== 'object') throw new Error('wire: нет снимка');
    opts = opts || {};
    var table = buildTable(snap);
    var w = new Writer(16384);
    w.u32(MAGIC);
    w.u8(VERSION);
    w.u8(TYPE_SNAPSHOT);
    var flags = 0;
    if (opts.baseline || snap.baseline) flags |= F_BASELINE;
    var results = snap.commandResults || [];
    if (results.length) flags |= F_RESULTS;
    w.u16(flags);

    /* Таблица строк — до ссылок на неё. */
    w.varint(table.list.length);
    for (var si = 0; si < table.list.length; si++) w.str(table.list[si]);

    w.u8(snap.protocol || 4);
    w.u16(snap.size || 0);
    w.u32(snap.epoch || 0);
    w.u32(snap.revision === undefined ? (snap.seq || 0) : snap.revision);
    w.u32(snap.simulationTick || 0);
    w.u32(snap.simulationTimeMs || 0);
    w.f64(snap.serverGeneratedAtMs || 0);
    w.u32(snap.structureVersion || 1);
    w.u8(snap.over ? 1 : 0);
    w.i32(snap.winner === undefined ? -2 : (snap.winner === null ? -1 : (snap.winner | 0)));
    w.u32(snap.objectTotal || 0);
    w.u16(table.idx(snap.roomId));
    w.u16(table.idx(snap.worldgenVersion));
    w.u16(table.idx(snap.worldgenHash));
    w.u16(table.idx(snap.gameplayConfigHash));
    w.u16(table.idx(snap.seed));
    w.u16(table.idx(snap.roomStatus));
    w.str(snap.removed === undefined || snap.removed === null ? '' : snap.removed);

    var towns = snap.towns || [];
    w.varint(towns.length);
    for (var t = 0; t < towns.length; t++) {
      var tw = towns[t];
      w.u16(tw.id || 0);
      w.u8(tw.owner || 0);
      w.u16(table.idx(tw.name));
      w.u16(table.idx(tw.color));
      w.u8(tw.alive === false ? 0 : 1);
      w.u8(tw.isBot ? 1 : 0);
      w.u32(tw.logs || 0);
      w.u32(tw.deliveries || 0);
      w.u32(tw.felled || 0);
      w.u32(tw.inTransit || 0);
      w.u32(tw.lost || 0);
      if (tw.birthNext === undefined || tw.birthNext === null) w.u8(0);
      else { w.u8(1); w.f64(tw.birthNext); }
      if (tw.vid === undefined || tw.vid === null) w.u8(0);
      else { w.u8(1); w.u32(tw.vid); }
    }

    var bs = snap.buildings || [];
    w.varint(bs.length);
    for (var b = 0; b < bs.length; b++) {
      var bb = bs[b];
      w.u16(table.idx(bb.id));
      w.u16(table.idx(bb.type));
      w.u16(table.idx(bb.variant));
      w.u16(bb.rot || 0);
      w.u16(coord(bb.x));
      w.u16(coord(bb.y));
      w.u8(bb.owner || 0);
      w.u8(bb.town || 0);
      w.f32(bb.hp || 0);
      w.f32(bb.maxHp || 0);
      w.f32(bb.hpUntil || 0);
      w.f32(bb.flinch || 0);
      w.u8(bb.rubble ? 1 : 0);
    }

    var vs = snap.villagers || [];
    w.varint(vs.length);
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      var vf = 0;
      if (v.frozen) vf |= VF.FROZEN;
      if (v.warrior) vf |= VF.WARRIOR;
      if (v.trainee) vf |= VF.TRAINEE;
      if (v.hidden) vf |= VF.HIDDEN;
      if (v.carrying) vf |= VF.CARRYING;
      if (v.dead) vf |= VF.DEAD;
      if (v.teleport) vf |= VF.TELEPORT;
      if (typeof v.hp === 'number') vf |= VF.HP;
      if (typeof v.hpUntil === 'number') vf |= VF.HP_UNTIL;
      if (typeof v.flinch === 'number') vf |= VF.FLINCH;
      if (typeof v.attackT === 'number') vf |= VF.ATTACK_T;
      if (v.trainingId !== undefined && v.trainingId !== null) vf |= VF.TRAINING;
      if (v.homeId !== undefined && v.homeId !== null) vf |= VF.HOME;
      if (v.employerId !== undefined && v.employerId !== null) vf |= VF.EMPLOYER;
      if (v.campId !== undefined && v.campId !== null) vf |= VF.CAMP;
      if (v.stationId !== undefined && v.stationId !== null) vf |= VF.STATION;
      if (typeof v.appearT === 'number' && typeof v.appearDur === 'number') vf |= VF.APPEAR;
      if (typeof v.vanishT === 'number') vf |= VF.VANISH;
      if (typeof v.emergeT === 'number') vf |= VF.EMERGE;
      if (typeof v.orderX === 'number' && typeof v.orderY === 'number') vf |= VF.ORDER;
      if (typeof v.deathTimeMs === 'number') vf |= VF.DEATH;
      if (typeof v.safeExtrapolationTo === 'number') vf |= VF.SAFE;
      if (typeof v.phase === 'number') vf |= VF.PHASE;
      if (v.anim !== undefined && v.anim !== null) vf |= VF.ANIM;
      if (v.state !== undefined && v.state !== null) vf |= VF.STATE;
      if (v.owner) vf |= VF.OWNER;
      if (v.town) vf |= VF.TOWN;
      w.u32(v.id >>> 0);
      w.u16(coord(v.x));
      w.u16(coord(v.y));
      w.u16(v.rot || 0);
      w.u32(vf >>> 0);
      if (vf & VF.OWNER) w.u8(v.owner || 0);
      if (vf & VF.TOWN) w.u8(v.town || 0);
      if (vf & VF.ANIM) w.u16(table.idx(v.anim));
      if (vf & VF.STATE) w.u16(table.idx(v.state));
      if (vf & VF.PHASE) w.u16(clampInt((Number(v.phase) || 0) * 1000, 0, 65535));
      if (vf & VF.HP) w.f32(v.hp);
      if (vf & VF.HP_UNTIL) w.f32(v.hpUntil);
      if (vf & VF.FLINCH) w.f32(v.flinch);
      if (vf & VF.ATTACK_T) w.f32(v.attackT);
      if (vf & VF.TRAINING) {
        w.u16(table.idx(v.trainingId));
        w.f32(v.trainT || 0);
      }
      if (vf & VF.HOME) w.u16(table.idx(v.homeId));
      if (vf & VF.EMPLOYER) w.u16(table.idx(v.employerId));
      if (vf & VF.CAMP) w.u16(table.idx(v.campId));
      if (vf & VF.STATION) w.u16(table.idx(v.stationId));
      if (vf & VF.APPEAR) { w.f32(v.appearT); w.f32(v.appearDur); }
      if (vf & VF.VANISH) w.f32(v.vanishT);
      if (vf & VF.EMERGE) w.f32(v.emergeT);
      if (vf & VF.ORDER) { w.u16(coord(v.orderX)); w.u16(coord(v.orderY)); }
      if (vf & VF.DEATH) w.f64(v.deathTimeMs);
      if (vf & VF.SAFE) w.u32(v.safeExtrapolationTo || 0);
      var motion = v.motion || [];
      w.varint(motion.length);
      for (var m = 0; m < motion.length; m++) {
        var s = motion[m] || {};
        w.u32(s.t || 0);
        w.u16(coord(s.x));
        w.u16(coord(s.y));
        w.u16(s.rot || 0);
      }
    }

    if (flags & F_RESULTS) {
      w.varint(results.length);
      function tick(v) {
        return v === undefined || v === null ? -1 : (v | 0);
      }
      for (var r = 0; r < results.length; r++) {
        var q = results[r] || {};
        w.u16(table.idx(q.commandId));
        w.u32(q.clientSequence === undefined ? 0 : q.clientSequence);
        w.u16(table.idx(q.sessionId));
        w.u32(q.playerId === undefined ? 0 : q.playerId);
        w.u8(q.owner === undefined || q.owner === null ? 255 : q.owner);
        w.u16(table.idx(q.status));
        w.u16(table.idx(q.reasonCode));
        w.u16(table.idx(q.reason));
        var ids = q.ids || [];
        w.varint(ids.length);
        for (var k = 0; k < ids.length; k++) w.u32(ids[k] >>> 0);
        w.i32(tick(q.appliedTick));
        w.i32(tick(q.appliedRevision));
        w.i32(tick(q.decidedTick));
        w.i32(tick(q.decidedRevision));
        w.u32(q.epoch || 0);
      }
    }
    return w.finish();
  }

  /* ------------------------------ unpack ------------------------------ */
  function unpackSnapshot(bytes) {
    var r = new Reader(bytes);
    if (r.u32() !== MAGIC) throw new Error('wire: не снимок 4tox');
    var version = r.u8();
    if (version !== VERSION) throw new Error('wire: версия ' + version);
    var type = r.u8();
    if (type !== TYPE_SNAPSHOT) throw new Error('wire: тип кадра ' + type);
    var flags = r.u16();
    var nstr = r.varint();
    if (nstr > 65535) throw new Error('wire: таблица строк слишком велика');
    var strings = new Array(nstr);
    for (var i = 0; i < nstr; i++) strings[i] = r.str();
    function S(idx) {
      if (idx === NULL_STR) return null;
      if (idx >= strings.length) throw new Error('wire: ссылка на строку ' + idx);
      return strings[idx];
    }

    var protocol = r.u8();
    var size = r.u16();
    var epoch = r.u32();
    var revision = r.u32();
    var simulationTick = r.u32();
    var simulationTimeMs = r.u32();
    var serverGeneratedAtMs = r.f64();
    var structureVersion = r.u32();
    var over = !!r.u8();
    var win = r.i32();
    var objectTotal = r.u32();
    var out = {
      protocol: protocol, size: size, epoch: epoch, revision: revision,
      simulationTick: simulationTick, simulationTimeMs: simulationTimeMs,
      serverGeneratedAtMs: serverGeneratedAtMs,
      structureVersion: structureVersion, over: over, objectTotal: objectTotal
    };
    if (win !== -2) out.winner = win < 0 ? null : win;
    out.seq = out.revision;
    out.roomId = S(r.u16());
    out.worldgenVersion = S(r.u16());
    out.worldgenHash = S(r.u16());
    out.gameplayConfigHash = S(r.u16());
    out.seed = S(r.u16());
    out.roomStatus = S(r.u16());
    out.removed = r.str();
    if (flags & F_BASELINE) out.baseline = true;

    var nt = r.varint();
    var towns = new Array(nt);
    for (var t = 0; t < nt; t++) {
      var tw = {
        id: r.u16(), owner: r.u8(),
        name: S(r.u16()), color: S(r.u16()),
        alive: !!r.u8(), isBot: !!r.u8(),
        logs: r.u32(), deliveries: r.u32(), felled: r.u32(),
        inTransit: r.u32(), lost: r.u32(),
        birthNext: null, vid: null
      };
      if (r.u8()) tw.birthNext = r.f64();
      if (r.u8()) tw.vid = r.u32();
      towns[t] = tw;
    }
    out.towns = towns;

    var nb = r.varint();
    var buildings = new Array(nb);
    for (var b = 0; b < nb; b++) {
      buildings[b] = {
        id: S(r.u16()), type: S(r.u16()), variant: S(r.u16()),
        rot: r.u16(), x: coordOut(r.u16()), y: coordOut(r.u16()),
        owner: r.u8(), town: r.u8(),
        hp: r.f32(), maxHp: r.f32(), hpUntil: r.f32(),
        flinch: round2(r.f32()), rubble: !!r.u8()
      };
    }
    out.buildings = buildings;

    var nv = r.varint();
    var villagers = new Array(nv);
    for (var vix = 0; vix < nv; vix++) {
      var v = {
        id: r.u32(), x: coordOut(r.u16()), y: coordOut(r.u16()),
        rot: r.u16()
      };
      var vf = r.u32();
      if (vf & VF.OWNER) v.owner = r.u8();
      if (vf & VF.TOWN) v.town = r.u8();
      if (vf & VF.ANIM) v.anim = S(r.u16());
      if (vf & VF.STATE) v.state = S(r.u16());
      if (vf & VF.PHASE) v.phase = r.u16() / 1000;
      if (vf & VF.HP) v.hp = round1(r.f32());
      if (vf & VF.HP_UNTIL) v.hpUntil = round2(r.f32());
      if (vf & VF.FLINCH) v.flinch = round2(r.f32());
      if (vf & VF.ATTACK_T) v.attackT = round2(r.f32());
      if (vf & VF.TRAINING) { v.trainingId = S(r.u16()); v.trainT = round2(r.f32()); }
      if (vf & VF.HOME) v.homeId = S(r.u16());
      if (vf & VF.EMPLOYER) v.employerId = S(r.u16());
      if (vf & VF.CAMP) v.campId = S(r.u16());
      if (vf & VF.STATION) v.stationId = S(r.u16());
      if (vf & VF.APPEAR) { v.appearT = round2(r.f32()); v.appearDur = round2(r.f32()); }
      if (vf & VF.VANISH) v.vanishT = round2(r.f32());
      if (vf & VF.EMERGE) v.emergeT = round2(r.f32());
      if (vf & VF.ORDER) { v.orderX = coordOut(r.u16()); v.orderY = coordOut(r.u16()); }
      if (vf & VF.DEATH) v.deathTimeMs = r.f64();
      if (vf & VF.SAFE) v.safeExtrapolationTo = r.u32();
      var nm = r.varint();
      if (nm) {
        var motion = new Array(nm);
        for (var m = 0; m < nm; m++) {
          motion[m] = {
            t: r.u32(), x: coordOut(r.u16()), y: coordOut(r.u16()), rot: r.u16()
          };
        }
        v.motion = motion;
      }
      if (vf & VF.FROZEN) v.frozen = 1;
      if (vf & VF.WARRIOR) v.warrior = 1;
      if (vf & VF.TRAINEE) v.trainee = 1;
      if (vf & VF.HIDDEN) v.hidden = 1;
      if (vf & VF.CARRYING) v.carrying = 1;
      if (vf & VF.DEAD) v.dead = 1;
      if (vf & VF.TELEPORT) v.teleport = 1;
      villagers[vix] = v;
    }
    out.villagers = villagers;

    if (flags & F_RESULTS) {
      var nr = r.varint();
      var results = new Array(nr);
      for (var qi = 0; qi < nr; qi++) {
        var q = {
          commandId: S(r.u16()), clientSequence: r.u32(),
          sessionId: S(r.u16()), playerId: r.u32(),
          owner: r.u8(), status: S(r.u16()),
          reasonCode: S(r.u16()), reason: S(r.u16()),
          ids: [], appliedTick: null, appliedRevision: null,
          decidedTick: null, decidedRevision: null, epoch: 0
        };
        var nids = r.varint();
        for (var idn = 0; idn < nids; idn++) q.ids.push(r.u32());
        var at = r.i32(); if (at >= 0) q.appliedTick = at;
        var ar = r.i32(); if (ar >= 0) q.appliedRevision = ar;
        var dt = r.i32(); if (dt >= 0) q.decidedTick = dt;
        var dr = r.i32(); if (dr >= 0) q.decidedRevision = dr;
        q.epoch = r.u32();
        if (q.owner === 255) q.owner = null;
        results[qi] = q;
      }
      out.commandResults = results;
    }
    if (r.off !== r.len) throw new Error('wire: лишние байты в кадре off=' + r.off + ' len=' + r.len);
    return out;
  }

  var api = {
    MAGIC: MAGIC,
    VERSION: VERSION,
    TYPE_SNAPSHOT: TYPE_SNAPSHOT,
    packSnapshot: packSnapshot,
    unpackSnapshot: unpackSnapshot,
    /* Для тестов/диагностики: размер без копирования. */
    packedSize: function (snap, opts) { return packSnapshot(snap, opts).byteLength; }
  };
  global.NetWire = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
