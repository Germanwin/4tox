/* upnp.js — проброс порта на роутере через UPnP IGD и проверка CGNAT.

   Зачем это здесь. Игра открывается по IP, но у домашнего интернета бывает
   два разных «внешних» адреса:

     1) роутер получил настоящий публичный IP — тогда достаточно пробросить
        порт, и друзья зайдут по нему. UPnP умеет сделать это сам, без
        лазания в настройки роутера;
     2) провайдер держит абонента за CGNAT: роутер получает 100.64/10 (или
        другой приватный адрес), а настоящий внешний IP общий на сотни
        абонентов. Никакой проброс порта не поможет — входящие соединения до
        роутера просто не доходят. Это важно сказать вслух, а не показывать
        мёртвую ссылку.

   Модуль ничего не ломает, если UPnP выключен: probe() возвращает ok:false,
   сервер продолжает работать с локальными адресами. */
'use strict';

const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const IGD_RANGE = /^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:1$/;

/* Шлюз по умолчанию и имя интерфейса, через который идёт интернет. */
function defaultRoute() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('route', ['-n', 'get', 'default'],
        { encoding: 'utf8', timeout: 1500 });
      const gw = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(out);
      const io = /interface:\s*(\S+)/.exec(out);
      if (gw) return { gateway: gw[1], iface: io ? io[1] : null };
    } else if (process.platform === 'linux') {
      const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const f = line.trim().split(/\s+/);
        if (!f[0] || !f[1] || f[1] === '00000000') continue;
        const hex = f[1];
        const ip = [3, 2, 1, 0].map(function (i) {
          return parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }).join('.');
        return { gateway: ip, iface: f[0] };
      }
    }
  } catch (e) { /* нет route — вернём null */ }
  return null;
}

function ifaceAddress(name) {
  if (!name) return null;
  const nets = os.networkInterfaces();
  const list = nets[name] || [];
  for (const n of list) if (n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

function privateAddress(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip);
}

/* 100.64.0.0/10 — диапазон CGNAT (RFC 6598). */
function cgnatAddress(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (!m) return false;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  return a === 100 && b >= 64 && b <= 127;
}

function discover(gateway, timeout) {
  return new Promise(function (resolve) {
    const sock = dgram.createSocket('udp4');
    const found = [];
    const seen = {};
    let done = false;
    const finish = function () {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) {}
      resolve(found);
    };
    sock.on('message', function (buf, rinfo) {
      const text = buf.toString();
      const loc = /^location:\s*(\S+)/im.exec(text);
      if (loc && !seen[loc[1]]) {
        seen[loc[1]] = true;
        found.push({ location: loc[1], from: rinfo.address });
      }
    });
    sock.on('error', finish);
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 2\r\n' +
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
    sock.bind(function () {
      try { sock.setBroadcast(true); } catch (e) {}
      try { sock.send(msg, 0, msg.length, 1900, '239.255.255.250'); } catch (e) {}
      try { sock.send(msg, 0, msg.length, 1900, gateway); } catch (e) {}
    });
    setTimeout(finish, timeout || 2200);
  });
}

function getText(url, timeout) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    const req = http.get(url, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () { done(body); });
    });
    req.on('error', function () { done(null); });
    req.setTimeout(timeout || 2200, function () { req.destroy(); done(null); });
  });
}

/* Найти сервис WANIPConnection/WANPPPConnection в описании устройства. */
function findIgd(xml, location) {
  if (!xml) return null;
  const friendly = (/<friendlyName>([\s\S]*?)<\/friendlyName>/.exec(xml) || [])[1] || null;
  let base;
  try { base = new URL(location); } catch (e) { return null; }
  const blocks = xml.match(/<service>[\s\S]*?<\/service>/g) || [];
  for (const block of blocks) {
    const type = (/<serviceType>([\s\S]*?)<\/serviceType>/.exec(block) || [])[1];
    const ctl = (/<controlURL>([\s\S]*?)<\/controlURL>/.exec(block) || [])[1];
    if (!type || !ctl || !IGD_RANGE.test(type.trim())) continue;
    let control;
    try { control = new URL(ctl.trim(), base).href; } catch (e) { continue; }
    return { serviceType: type.trim(), controlUrl: control, router: friendly };
  }
  return null;
}

function soap(controlUrl, serviceType, action, inner, timeout) {
  const body = '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + serviceType + '">' + inner +
    '</u:' + action + '></s:Body></s:Envelope>';
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    let url;
    try { url = new URL(controlUrl); } catch (e) { return done({ ok: false, text: 'плохой URL' }); }
    const req = http.request({
      host: url.hostname, port: url.port || 80, path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': '"' + serviceType + '#' + action + '"',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { text += c; });
      res.on('end', function () {
        const ok = res.statusCode === 200 && !/<(?:s:)?Fault>/i.test(text);
        done({ ok: ok, status: res.statusCode, text: text });
      });
    });
    req.on('error', function (e) { done({ ok: false, text: e.message }); });
    req.setTimeout(timeout || 2500, function () { req.destroy(); done({ ok: false, text: 'таймаут' }); });
    req.end(body);
  });
}

function field(text, name) {
  const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(text || '');
  return m ? m[1].trim() : null;
}

/* probe({ port, publicIp }) -> {
     ok, router, externalIp, localAddress, cgnat, mapped, reason
   } */
async function probe(opts) {
  opts = opts || {};
  const port = opts.port || 8787;
  const route = defaultRoute();
  if (!route) return { ok: false, reason: 'не удалось узнать шлюз по умолчанию' };
  const local = ifaceAddress(route.iface) || null;
  if (!local) return { ok: false, reason: 'не удалось узнать адрес в локальной сети' };

  const locations = await discover(route.gateway);
  if (!locations.length) {
    return { ok: false, reason: 'роутер не отвечает на UPnP (он выключен или не поддерживается)' };
  }

  let igd = null;
  for (const loc of locations.slice(0, 4)) {
    const xml = await getText(loc.location);
    igd = findIgd(xml, loc.location);
    if (igd) break;
  }
  if (!igd) return { ok: false, reason: 'UPnP найден, но WANIPConnection не advertised' };

  const extRes = await soap(igd.controlUrl, igd.serviceType, 'GetExternalIPAddress', '');
  const externalIp = field(extRes.text, 'NewExternalIPAddress');
  if (!externalIp) {
    return { ok: false, router: igd.router, reason: 'роутер не отдал внешний адрес' };
  }

  const cgnat = cgnatAddress(externalIp) || privateAddress(externalIp) ||
    (opts.publicIp && externalIp !== opts.publicIp);

  if (cgnat) {
    return {
      ok: true, router: igd.router, externalIp: externalIp, localAddress: local,
      cgnat: true, mapped: false,
      reason: cgnatAddress(externalIp)
        ? 'провайдер держит за CGNAT: внешний адрес роутера ' + externalIp + ' — общий'
        : 'внешний адрес роутера не совпадает с публичным'
    };
  }

  /* Порт уже мог быть проброшен прошлым запуском. */
  const mapped = await soap(igd.controlUrl, igd.serviceType, 'AddPortMapping',
    '<NewRemoteHost></NewRemoteHost>' +
    '<NewExternalPort>' + port + '</NewExternalPort>' +
    '<NewProtocol>TCP</NewProtocol>' +
    '<NewInternalPort>' + port + '</NewInternalPort>' +
    '<NewInternalClient>' + local + '</NewInternalClient>' +
    '<NewEnabled>1</NewEnabled>' +
    '<NewPortMappingDescription>4tox-' + port + '</NewPortMappingDescription>' +
    '<NewLeaseDuration>0</NewLeaseDuration>');

  return {
    ok: true, router: igd.router, externalIp: externalIp, localAddress: local,
    cgnat: false, mapped: mapped.ok,
    reason: mapped.ok ? null : ('роутер отказал в пробросе: ' + (field(mapped.text, 'errorDescription') || 'код ' + mapped.status))
  };
}

module.exports = {
  probe: probe,
  defaultRoute: defaultRoute,
  cgnatAddress: cgnatAddress,
  privateAddress: privateAddress
};
