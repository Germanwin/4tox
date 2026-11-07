#!/usr/bin/env node
/* fake_entry.js — заглушки входа для приёмки экрана сети (Godot).
 *
 * Зачем своя заглушка. Настоящий 443 на VPS делит листенер с naive-прокси:
 * при включённом VPN он то отвечает `407 Proxy Authentication Required`, то
 * рвёт соединение до ответа. Приёмка не может ходить на прод, поэтому те же
 * ответы отдаются на localhost, и клиент проверяется на них, а не на удаче.
 *
 *   node tests/fake_entry.js <port> proxy407|html404|capacity|hold [delayMs]
 *
 *   proxy407  — 407 и HTML, как Caddy Secure Web Proxy;
 *   html404   — 404 и HTML, как «на этом адресе нет игры»;
 *   capacity  — 503 и JSON с причиной, как переполненный сервер;
 *   hold      — обычный лобби-сервер, но слушает не сразу: первый заход
 *               получает отказ соединения (так ведёт себя 443 на VPN), а
 *               повтор через 0,35 с попадает уже в живой сокет.
 *
 * `/api/_stats` отдаёт {posts, conns}: приёмка проверяет, что повтор сетевого
 * сбоя не создал второе лобби.
 */
'use strict';

const http = require('http');

const port = parseInt(process.argv[2], 10);
const mode = process.argv[3] || 'hold';
const delayMs = parseInt(process.argv[4] || '500', 10);
const CODE = 'QATST';
const TOKEN = 'qatoken';

let posts = 0;
let conns = 0;

function players(ready) {
  return [{ id: 0, name: 'Заглушка', ready: !!ready, host: true, color: '#4a90d9', online: true }];
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer(function (req, res) {
  if (mode === 'proxy407') {
    res.writeHead(407, {
      'Content-Type': 'text/html; charset=utf-8',
      'Proxy-Authenticate': 'Basic realm="Caddy Secure Web Proxy"',
    });
    res.end('<!doctype html><html><head><title>407 Proxy Authentication Required</title></head>'
      + '<body>407 Proxy Authentication Required</body></html>');
    return;
  }
  if (mode === 'html404') {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>404 page not found</body></html>');
    return;
  }
  if (mode === 'capacity') {
    sendJson(res, 503, {
      ok: false,
      code: 'server_capacity',
      reason: 'на сервере слишком много лобби; попробуйте позже',
    });
    return;
  }

  if (req.url === '/api/_stats') {
    sendJson(res, 200, { ok: true, posts: posts, conns: conns });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/lobby') {
    posts++;
    sendJson(res, 200, {
      ok: true, code: CODE, token: TOKEN, playerId: 0, hostId: 0,
      max: 2, players: players(false),
    });
    return;
  }
  if (req.url.indexOf('/api/status') === 0) {
    sendJson(res, 200, { ok: true, lobby: { players: players(false) }, started: false, block: {} });
    return;
  }
  if (req.url.indexOf('/api/leave') === 0) {
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 200, { ok: true });
});

server.on('connection', function () { conns++; });

if (mode === 'hold') {
  setTimeout(function () { server.listen(port, '127.0.0.1'); }, delayMs);
} else {
  server.listen(port, '127.0.0.1');
}
process.on('SIGTERM', function () { process.exit(0); });
process.on('SIGINT', function () { process.exit(0); });
