/* persistence.js — журнал и checkpoint комнаты на диске.

   Контракт (spec §8.3): новый commandId становится `received` только после
   записи `accept` И fsync. Тик становится `committed` только после записи
   `tickCommit` И fsync. Checkpoint раз в 40 committed тиков пишется через
   temp -> fsync файла -> atomic rename -> fsync каталога.

   Один поток записи сериализует accept/tickCommit/control. Никаких «100
   незаписанных тиков в RAM»: комнате разрешено объявить тик завершённым
   только после ответа диска.

   Файлы комнаты лежат ВНЕ web-root; сервер статики их не отдаёт. */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
const RECORD_MAX_BYTES = 4 * 1024 * 1024;
const KEEP_CHECKPOINTS = 2;

function sha8(buf) {
  return crypto.createHash('sha256').update(buf).digest().subarray(0, 8);
}

function encodeRecord(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  if (payload.length > RECORD_MAX_BYTES) throw new Error('journal_record_too_large');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(payload.length, 0);
  const sum = sha8(payload);
  return Buffer.concat([head, payload, sum]);
}

function decodeRecords(buf, opts) {
  opts = opts || {};
  const out = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 12) {
      if (opts.allowTruncatedTail) break;
      throw new Error('journal_truncated_header');
    }
    const len = buf.readUInt32BE(off);
    if (len > RECORD_MAX_BYTES) throw new Error('journal_record_too_large');
    if (off + 4 + len + 8 > buf.length) {
      if (opts.allowTruncatedTail) break;
      throw new Error('journal_truncated_record');
    }
    const payload = buf.subarray(off + 4, off + 4 + len);
    const sum = buf.subarray(off + 4 + len, off + 4 + len + 8);
    const want = sha8(payload);
    if (!sum.equals(want)) throw new Error('journal_checksum');
    let rec;
    try { rec = JSON.parse(payload.toString('utf8')); }
    catch (e) { throw new Error('journal_bad_json'); }
    out.push({ offset: off, bytes: 4 + len + 8, record: rec });
    off += 4 + len + 8;
  }
  return out;
}

function pad(n, w) {
  n = String(n);
  while (n.length < w) n = '0' + n;
  return n;
}

function Persistence(options) {
  if (!(this instanceof Persistence)) return new Persistence(options);
  options = options || {};
  this.roomId = String(options.roomId || 'room');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.roomId)) throw new Error('bad_room_id');
  this.dir = path.resolve(options.dir || path.join(process.cwd(), 'game', 'server', 'var', 'rooms'),
    this.roomId);
  this.segmentBytes = options.segmentBytes || JOURNAL_MAX_BYTES;
  this.keepCheckpoints = options.keepCheckpoints || KEEP_CHECKPOINTS;
  this.segment = 1;
  this.handle = null;
  this.chain = Promise.resolve();
  this.closed = false;
  this.writeSeq = 0;
  /* Уникальность tmp на процесс И на экземпляр: два Persistence на одном
     STATE_DIR не должны писать в один tmp. */
  this.instanceTag = Math.random().toString(36).slice(2, 10);
  this.stats = {
    records: 0, bytes: 0, fsyncs: 0, checkpoints: 0,
    checkpointBytes: 0, rotations: 0, loadMs: 0
  };
}

Persistence.prototype.open = async function () {
  await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
  const meta = await this.readMeta();
  this.segment = meta && meta.segment ? meta.segment : 1;
  await this.openSegment(this.segment);
  return meta;
};

Persistence.prototype.openSegment = async function (seg) {
  if (this.handle) {
    try { await this.handle.close(); } catch (e) { /* уже закрыт */ }
  }
  this.segment = seg;
  const file = this.segmentPath(seg);
  try { await fsp.access(file); }
  catch (e) { await fsp.writeFile(file, Buffer.alloc(0), { mode: 0o600 }); }
  this.handle = await fsp.open(file, 'a+', 0o600);
  const st = await this.handle.stat();
  this.segmentBytesAtOpen = st.size;
  return file;
};

Persistence.prototype.segmentPath = function (seg) {
  return path.join(this.dir, 'journal-' + pad(seg, 6) + '.log');
};

Persistence.prototype.metaPath = function () {
  return path.join(this.dir, 'meta.json');
};

Persistence.prototype.readMeta = async function () {
  try {
    const txt = await fsp.readFile(this.metaPath(), 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
};

Persistence.prototype.writeMeta = async function (meta) {
  const tmp = this.metaPath() + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  const h = await fsp.open(tmp, 'r');
  try { await h.sync(); } finally { await h.close(); }
  await fsp.rename(tmp, this.metaPath());
  await this.fsyncDir();
};

Persistence.prototype.fsyncDir = async function () {
  try {
    const h = await fsp.open(this.dir, 'r');
    try { await h.sync(); } finally { await h.close(); }
  } catch (e) {
    /* На некоторых платформах каталог нельзя открыть как файл. Это не повод
       объявлять запись неуспешной на Linux, где контракт и исполняется. */
  }
};

Persistence.prototype.append = function (record) {
  if (this.closed) return Promise.reject(new Error('persistence_closed'));
  const self = this;
  const buf = encodeRecord(record);
  this.chain = this.chain.then(function () {
    return self.appendNow(buf);
  });
  return this.chain.then(function (loc) {
    return { segment: loc.segment, offset: loc.offset, bytes: buf.length };
  });
};

Persistence.prototype.appendNow = async function (buf) {
  if (!this.handle) throw new Error('persistence_not_open');
  /* Сегмент переполнился — начинаем новый. Проверка ДО записи, чтобы запись
     не пересекала границу сегментов. */
  const st = await this.handle.stat();
  if (st.size >= this.segmentBytes) {
    this.segment++;
    this.stats.rotations++;
    await this.openSegment(this.segment);
  }
  const st2 = await this.handle.stat();
  const offset = st2.size;
  let written = 0;
  while (written < buf.length) {
    const r = await this.handle.write(buf, written, buf.length - written, null);
    if (!r || !(r.bytesWritten > 0)) throw new Error('journal_write_short');
    written += r.bytesWritten;
  }
  await this.handle.sync();
  this.stats.records++;
  this.stats.bytes += buf.length;
  this.stats.fsyncs++;
  return { segment: this.segment, offset: offset };
};

Persistence.prototype.checkpointPath = function (name) {
  return path.join(this.dir, name);
};

Persistence.prototype.listCheckpoints = async function () {
  let names = [];
  try { names = await fsp.readdir(this.dir); } catch (e) { return []; }
  return names.filter(function (n) { return /^checkpoint-\d+-\d+-\d+\.json$/.test(n); })
    .sort();
};

/* Запись checkpoint: независимый DTO уже посчитан codec'ом. Здесь только
   байты, temp, fsync, rename, fsync каталога. */
Persistence.prototype.writeCheckpoint = async function (simDto, meta) {
  if (this.closed) throw new Error('persistence_closed');
  const tick = meta.tick || 0;
  const revision = meta.revision || tick;
  const epoch = meta.epoch || 1;
  const name = 'checkpoint-' + pad(tick, 10) + '-' + pad(revision, 10) + '-' + pad(epoch, 6) + '.json';
  /* Уникальный tmp: два checkpoint'а на один тик (terminal/suspend и обычный)
     не должны писать в один файл. */
  const tmp = this.checkpointPath(name + '.tmp-' + process.pid + '-' + this.instanceTag + '-' + (++this.writeSeq));
  const final = this.checkpointPath(name);
  const body = {
    checkpointSchema: 1,
    roomId: this.roomId,
    epoch: epoch,
    revision: revision,
    tick: tick,
    journal: { segment: meta.journalSegment || this.segment, offset: meta.journalOffset || 0 },
    createdAtMs: Date.now(),
    sim: simDto,
    /* Комнатная часть checkpoint: очередь команд, ledger, instance и
       watermark'и. Она сохраняется ВМЕСТЕ с миром, а не отдельным файлом:
       иначе после падения мир и подтверждения команд были бы из разных
       мгновений. */
    room: meta.room || null
  };
  const text = JSON.stringify(body);
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    const h = await fsp.open(tmp, 'r+');
    try { await h.sync(); } finally { await h.close(); }
    await fsp.rename(tmp, final);
  } catch (e) {
    /* Не оставляем .tmp после неудачной записи: они копятся и мешают
       разбирать каталог комнаты. */
    try { await fsp.unlink(tmp); } catch (x) { /* уже нет */ }
    throw e;
  }
  await this.fsyncDir();
  this.stats.checkpoints++;
  this.stats.checkpointBytes += Buffer.byteLength(text);
  await this.pruneCheckpoints();
  return { name: name, bytes: Buffer.byteLength(text), journal: body.journal, epoch: epoch, tick: tick, revision: revision };
};

Persistence.prototype.pruneCheckpoints = async function () {
  const list = await this.listCheckpoints();
  while (list.length > this.keepCheckpoints) {
    const old = list.shift();
    try { await fsp.unlink(this.checkpointPath(old)); } catch (e) { /* уже нет */ }
  }
};

/* Загрузка: последний ЦЕЛЫЙ checkpoint, затем журнал после его offset.
   Оборванный последний record допустим; повреждение в середине — ошибка. */
Persistence.prototype.loadLatest = async function () {
  const started = Date.now();
  const list = (await this.listCheckpoints()).reverse();
  let lastError = null;
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    let body;
    try {
      body = JSON.parse(await fsp.readFile(this.checkpointPath(name), 'utf8'));
      if (!body || body.checkpointSchema !== 1) throw new Error('checkpoint_schema');
      if (body.roomId !== this.roomId) throw new Error('checkpoint_room_mismatch');
      if (!body.sim) throw new Error('checkpoint_sim_missing');
    } catch (e) {
      lastError = e;
      continue;
    }
    const journal = await this.readJournal(body.journal || { segment: 1, offset: 0 });
    this.stats.loadMs = Date.now() - started;
    return {
      checkpoint: body,
      checkpointName: name,
      journal: journal.records,
      journalTruncated: journal.truncated,
      journalEnd: journal.end
    };
  }
  /* Чекпоинтов нет — читаем журнал с первого сегмента. */
  const journal = await this.readJournal({ segment: 1, offset: 0 });
  this.stats.loadMs = Date.now() - started;
  return {
    checkpoint: null, checkpointName: null, journal: journal.records,
    journalTruncated: journal.truncated, journalEnd: journal.end,
    checkpointError: lastError ? String(lastError.message || lastError) : null
  };
};

Persistence.prototype.listSegments = async function () {
  let names = [];
  try { names = await fsp.readdir(this.dir); } catch (e) { return []; }
  return names.filter(function (n) { return /^journal-\d{6}\.log$/.test(n); })
    .sort();
};

/* Прочитать журнал с {segment, offset} до конца. Каждый record проверяется
   по checksum; повреждение в середине бросает, оборванный хвост — только
   помечается. */
Persistence.prototype.readJournal = async function (from) {
  const segments = await this.listSegments();
  const startSeg = Math.max(1, (from && from.segment) || 1);
  const records = [];
  let truncated = false;
  let end = { segment: startSeg, offset: 0 };
  for (let si = 0; si < segments.length; si++) {
    const name = segments[si];
    const segNo = parseInt(name.slice(8, 14), 10);
    if (segNo < startSeg) continue;
    const buf = await fsp.readFile(path.join(this.dir, name));
    const skip = segNo === startSeg ? Math.max(0, from.offset || 0) : 0;
    const sub = buf.subarray(skip);
    let decoded;
    try {
      decoded = decodeRecords(sub, { allowTruncatedTail: segNo === segments.length });
    } catch (e) {
      e.message = 'journal_corrupt:' + name + ':' + e.message;
      throw e;
    }
    for (let ri = 0; ri < decoded.length; ri++) {
      decoded[ri].segment = segNo;
      decoded[ri].offset += skip;
      records.push(decoded[ri]);
      end = { segment: segNo, offset: decoded[ri].offset + decoded[ri].bytes };
    }
    if (sub.length > 0) {
      const consumed = decoded.length
        ? decoded[decoded.length - 1].offset + decoded[decoded.length - 1].bytes
        : 0;
      if (consumed < sub.length) {
        /* Хвост после последнего целого record — только у последнего сегмента. */
        if (segNo !== segments.length) throw new Error('journal_corrupt_middle:' + name);
        truncated = true;
      }
    }
  }
  return { records: records, truncated: truncated, end: end };
};

Persistence.prototype.close = async function () {
  this.closed = true;
  try { await this.chain; } catch (e) { /* ошибка уже видна вызывающему */ }
  if (this.handle) {
    try { await this.handle.close(); } catch (e) { /* уже закрыт */ }
    this.handle = null;
  }
};

Persistence.prototype.diagnostics = function () {
  return {
    roomId: this.roomId,
    dir: this.dir,
    segment: this.segment,
    records: this.stats.records,
    bytes: this.stats.bytes,
    fsyncs: this.stats.fsyncs,
    checkpoints: this.stats.checkpoints,
    checkpointBytes: this.stats.checkpointBytes,
    rotations: this.stats.rotations,
    loadMs: this.stats.loadMs
  };
};

module.exports = {
  Persistence: Persistence,
  create: function (opts) { return new Persistence(opts); },
  encodeRecord: encodeRecord,
  decodeRecords: decodeRecords,
  JOURNAL_MAX_BYTES: JOURNAL_MAX_BYTES,
  KEEP_CHECKPOINTS: KEEP_CHECKPOINTS
};
