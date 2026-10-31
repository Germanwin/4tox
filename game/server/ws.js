/* ws.js — минимальный сервер WebSocket без внешних зависимостей.

   Зачем свой, а не пакет `ws`: игра запускается как `node server.js` без
   package.json и без npm-слоя; на VPS код лежит копией и `npm install` там
   не выполняется. Для одного канала «снимки вниз, команды/пинг вверх»
   достаточно RFC 6455: handshake, маскированные кадры клиента, ping/pong,
   close, backpressure по `socket.writableLength`.

   Чего здесь нет намеренно: permessage-deflate (двоичный кадр уже сжат
   форматом), расширений, подпротоколов, серверного маскирования. Это не
   замена универсальной библиотеке, а транспорт комнаты. */
'use strict';

const crypto = require('crypto');
const NET = require('../shared/net-config.js');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/* Те же числа, что у клиента и комнаты (game/shared/net-config.js). */
const MAX_MESSAGE = NET.wsMaxMessageBytes || (64 * 1024);
const HEARTBEAT_MS = NET.wsServerPingMs || 15000;
const HEARTBEAT_TIMEOUT_MS = NET.wsServerTimeoutMs || 45000;
const SOCKET_HIGH = NET.wsSocketHighBytes || (256 * 1024);

function reject(socket, status, text) {
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + (text || '') +
      '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  } catch (e) { /* уже закрыт */ }
  try { socket.destroy(); } catch (e) {}
}

function frame(opcode, payload) {
  const len = payload ? payload.length : 0;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode;
  if (!payload || !len) return head;
  var out = Buffer.allocUnsafe(head.length + len);
  head.copy(out, 0);
  payload.copy(out, head.length);
  return out;
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.closeSent = false;
    this.lastPong = Date.now();
    this.lastSeen = Date.now();
    this._buf = Buffer.alloc(0);
    this._fragOp = 0;
    this._frag = [];
    this._fragLen = 0;
    this._onmessage = null;
    this._onclose = null;
    this._closeOnce = false;
    this.heartbeat = null;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.dropped = 0;
    this.openedAt = Date.now();
    this._bind();
  }

  _bind() {
    const self = this;
    this.socket.on('data', function (chunk) { self._data(chunk); });
    this.socket.on('error', function () { self._finish('socket-error'); });
    this.socket.on('close', function () { self._finish('socket-close'); });
    this.socket.on('end', function () { self._finish('socket-end'); });
    this.heartbeat = setInterval(function () { self._ping(); }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  _ping() {
    if (this.closed) return;
    if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT_MS) {
      this.destroy('heartbeat-timeout');
      return;
    }
    this._write(frame(0x9, Buffer.alloc(0)), 0);
  }

  _data(chunk) {
    if (this.closed) return;
    this.bytesIn += chunk.length;
    this.lastPong = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (!this.closed && this._buf.length >= 2) {
      const b0 = this._buf[0], b1 = this._buf[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0F;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7F;
      let off = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        if (hi !== 0 || lo > MAX_MESSAGE) { this.close(1009, 'too big'); return; }
        len = lo;
        off = 10;
      }
      if (len > MAX_MESSAGE) { this.close(1009, 'too big'); return; }
      if (!masked) { this.close(1002, 'mask required'); return; }
      if (this._buf.length < off + 4 + len) return;
      const mask = this._buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = this._buf[off + i] ^ mask[i & 3];
      this._buf = this._buf.subarray(off + len);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === 0x8) {                 // close
      if (!this.closeSent) this._write(frame(0x8, payload.subarray(0, 125)), 0);
      this._finish('peer-close');
      return;
    }
    if (opcode === 0x9) {                 // ping
      this._write(frame(0xA, payload), 0);
      return;
    }
    if (opcode === 0xA) {                 // pong
      this.lastPong = Date.now();
      return;
    }
    if (opcode === 0x0) {                 // continuation
      if (!this._fragOp) { this.close(1002, 'unexpected continuation'); return; }
      this._frag.push(payload);
      this._fragLen += payload.length;
      if (this._fragLen > MAX_MESSAGE) { this.close(1009, 'too big'); return; }
      if (fin) {
        const all = Buffer.concat(this._frag, this._fragLen);
        const op = this._fragOp;
        this._frag = [];
        this._fragLen = 0;
        this._fragOp = 0;
        this._message(op, all);
      }
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) { this.close(1002, 'bad opcode'); return; }
    if (!fin) {
      this._fragOp = opcode;
      this._frag = [payload];
      this._fragLen = payload.length;
      return;
    }
    this._message(opcode, payload);
  }

  _message(opcode, payload) {
    this.lastSeen = Date.now();
    if (!this._onmessage) return;
    try {
      if (opcode === 0x1) this._onmessage(payload.toString('utf8'), this);
      else this._onmessage(payload, this);
    } catch (e) {
      this.close(1011, 'handler');
    }
  }

  _write(buf, kind) {
    if (this.closed || !this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(buf);
      this.bytesOut += buf.length;
      return true;
    } catch (e) {
      this._finish('write-error');
      return false;
    }
  }

  /* Возвращает false, если кадр отправлен в переполненный сокет. Для снимков
     это сигнал «пропустить этот кадр»: следующий полный кадр всё равно
     заменит его, а копить очередь устаревших нельзя. */
  get backlog() {
    return this.socket ? (this.socket.writableLength || 0) : 0;
  }

  sendText(text) {
    return this._write(frame(0x1, Buffer.from(String(text), 'utf8')), 1);
  }

  sendBinary(buf) {
    if (this.backlog > SOCKET_HIGH) { this.dropped++; return false; }
    return this._write(frame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)), 2);
  }

  sendJson(obj) { return this.sendText(JSON.stringify(obj)); }

  close(code, reason) {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const text = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
      const payload = Buffer.allocUnsafe(2 + text.length);
      payload.writeUInt16BE(code || 1000, 0);
      text.copy(payload, 2);
      this._write(frame(0x8, payload), 0);
    }
    const self = this;
    const timer = setTimeout(function () { self.destroy('close-timeout'); }, 250);
    if (timer.unref) timer.unref();
    try { this.socket.end(); } catch (e) { this.destroy('end-error'); }
  }

  destroy(reason) {
    if (this.closed) return;
    try { this.socket.destroy(); } catch (e) {}
    this._finish(reason || 'destroy');
  }

  _finish(reason) {
    if (this._closeOnce) return;
    this._closeOnce = true;
    this.closed = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try { this.socket.removeAllListeners('data'); } catch (e) {}
    if (this._onclose) {
      try { this._onclose(reason || 'closed'); } catch (e) {}
    }
  }

  onMessage(fn) { this._onmessage = fn; }
  onClose(fn) { this._onclose = fn; }
}

function attach(server, handler) {
  server.on('upgrade', function (req, socket, head) {
    var url;
    try { url = new URL(req.url || '/', 'http://room.local'); }
    catch (e) { reject(socket, 400, 'Bad Request'); return; }
    if (url.pathname !== '/api/ws') { reject(socket, 404, 'Not Found'); return; }
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      reject(socket, 400, 'Bad Request'); return;
    }
    var key = req.headers['sec-websocket-key'];
    var version = req.headers['sec-websocket-version'];
    if (!key || String(version) !== '13') { reject(socket, 400, 'Bad Request'); return; }
    var accept;
    try {
      accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
    } catch (e) { reject(socket, 400, 'Bad Request'); return; }
    try {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      if (socket.setNoDelay) socket.setNoDelay(true);
    } catch (e) { try { socket.destroy(); } catch (err) {} return; }
    var conn = new Conn(socket);
    try { handler(conn, req, url); }
    catch (e) {
      try { conn.close(1011, 'handler'); } catch (err) { conn.destroy('handler'); }
      return;
    }
    /* Кадр, приехавший вместе с Upgrade, обрабатываем ПОСЛЕ установки
       обработчиков: иначе первое сообщение клиента потерялось бы. */
    if (head && head.length) conn._data(head);
  });
}

module.exports = {
  attach: attach,
  Conn: Conn,
  GUID: GUID,
  MAX_MESSAGE: MAX_MESSAGE,
  SOCKET_HIGH: SOCKET_HIGH
};
