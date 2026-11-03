/* tunnel.js — HTTPS-ссылка наружу без cloudflared.

   Зачем: у домашнего интернета часто нет публичного адреса (CGNAT), и
   входящие соединения до компьютера не доходят вообще. Единственный способ
   пустить друга без установки VPN — исходящий туннель.

   Почему pinggy, а не cloudflared: cloudflared буферизует SSE, и лобби
   «молчит» (оба нажали «Готов», а старт не приходит). Pinggy — обычный
   SSH-туннель, он стримит события и даёт настоящий HTTPS-адрес. Скорость
   проверена: ~0.5 МБ/с, то есть атласы игры (~8 МБ) едут за ~15 секунд.

   Это осознанный компромисс: трафик игры идёт через чужой релей, адрес
   случайный и живёт, пока жив ssh (у бесплатного pinggy — час, потом
   переподключение с новым адресом). Поэтому туннель включается флагом
   --tunnel (лаунчер включает его), а не молча. */
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const URL_RE = /https:\/\/[a-z0-9-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link|pinggy\.link)/i;

function start(port, log) {
  const state = {
    url: null, host: null, status: 'starting', error: null,
    child: null, restarts: 0, stopped: false, startedAt: Date.now()
  };
  const knownHosts = path.join(os.tmpdir(), '4tox-ssh-known-hosts');

  function connect() {
    const args = [
      '-T', '-F', '/dev/null',
      '-p', '443',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=' + knownHosts,
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R0:localhost:' + port,
      'a.pinggy.io'
    ];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;
    state.status = 'starting';
    let seen = false;

    function scan(chunk) {
      const text = chunk.toString();
      const m = URL_RE.exec(text);
      if (m && !seen) {
        seen = true;
        state.host = m[0].replace(/^https:\/\//, '');
        state.url = m[0];
        state.status = 'up';
        state.error = null;
        if (log) log('  туннель: ' + state.url + '/game/');
        if (log) log('  (HTTPS через pinggy; бесплатный туннель живёт час, потом адрес сменится)');
      }
    }
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', function (e) {
      state.status = 'failed';
      state.error = e.code === 'ENOENT' ? 'ssh не найден' : e.message;
      if (log) log('  туннель не поднялся: ' + state.error);
    });

    child.on('exit', function (code) {
      state.child = null;
      if (state.stopped) return;
      state.status = 'down';
      state.url = null;
      state.host = null;
      if (log) {
        log('  туннель закрылся' + (seen ? ' — переподключаюсь' : ' (код ' + code + ')'));
      }
      if (state.restarts < 5) {
        state.restarts++;
        setTimeout(function () {
          if (!state.stopped) connect();
        }, 4000).unref();
      } else {
        state.status = 'failed';
        state.error = 'не удалось удержать туннель';
        if (log) log('  туннель сдался после 5 попыток');
      }
    });
  }

  connect();

  return {
    url: function () { return state.url; },
    status: function () { return state.status; },
    error: function () { return state.error; },
    stop: function () {
      state.stopped = true;
      if (state.child) { try { state.child.kill('SIGTERM'); } catch (e) {} }
    }
  };
}

module.exports = { start: start };
