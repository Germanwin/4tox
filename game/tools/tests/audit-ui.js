/* audit-ui.js — браузерные репро-тесты находок аудита (Chrome, file://).

   Проверяются ровно те поломки, которые не видны в node:
     M-05 Enter на карточке размера не должен запускать игру;
     M-04 «Новый остров» из сети не должен оставлять главное меню поверх;
     M-03 «Двигать» в сети должен брать дом, а не закрывать правку;
     M-06 журнал обновляет повтор атаки (count/координаты).
   Запуск: node game/tools/tests/audit-ui.js [url] */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const CHROME = require(path.join(__dirname, '..', '..', '..', 'mapgen2', 'tools', 'chrome.js'));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const URL = process.argv[2] || 'file://' + path.join(ROOT, 'game', 'index.html');
const PORT = 19100 + (process.pid % 500);
const PROFILE = '/tmp/4tox-audit-ui-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--hide-scrollbars',
    '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {} };
  process.on('exit', kill);
  let ws;
  try {
    for (let i = 0; i < 100; i++) {
      try { await getJSON('http://127.0.0.1:' + PORT + '/json/version'); break; }
      catch (e) { await sleep(150); }
    }
    const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list');
    ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 1; const pending = new Map(); const errors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
    });
    const send = (method, params) => new Promise(r => {
      const i = id++; pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const js = async (expr) => {
      const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
      if (!res || res.exceptionDetails) {
        const d = res && res.exceptionDetails;
        throw new Error((d && d.exception && d.exception.description) || (d && d.text) || 'cdp');
      }
      return res.result.value;
    };
    const reload = async () => {
      await send('Page.navigate', { url: URL });
      await sleep(3300);
    };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    /* --- M-05: Enter на карточке 128 не стартует игру с прежним выбором --- */
    await reload();
    await js(`(() => { const c = document.querySelector('[data-size="128"]'); c.focus(); return c.dataset.size; })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(1200);
    const enter = await js(`({ menu: Menu.isOpen(), mode: Play.state.mode,
      size: Play.state.world && Play.state.world.islandSize,
      selected: (document.querySelector('.size-card.selected') || {}).dataset && document.querySelector('.size-card.selected').dataset.size })`);
    check('M-05: Enter на карточке не запускает игру', enter.menu === true && enter.mode !== 'play',
      JSON.stringify(enter));
    if (enter.menu) {
      check('M-05: карточка 128 выбрана', enter.selected === '128', 'selected=' + enter.selected);
    }

    /* --- M-06: повтор атаки обновляет журнал --- */
    await reload();
    await js(`document.getElementById('btnPlay').click()`);
    await sleep(1800);
    const evo = await js(`(() => {
      const w = Play.state.world;
      Events.init(w);
      Events.attack(w, 0, 10, 10, 'на деревню напали');
      Hud.tick(0.2);
      return { last: document.getElementById('eventLogLast').textContent,
               count: document.getElementById('eventLogCount').textContent };
    })()`);
    await js(`(() => {
      const w = Play.state.world;
      Events.attack(w, 0, 31, 32, 'на деревню напали');
      Hud.tick(0.2);
      return true;
    })()`);
    const evo2 = await js(`(() => {
      const w = Play.state.world;
      const ev = (w.events || []).filter(e => e.kind === 'attack')[0];
      const row = document.querySelector('#eventLogList .event-row');
      return { last: document.getElementById('eventLogLast').textContent,
               count: document.getElementById('eventLogCount').textContent,
               worldCount: ev && ev.count, x: ev && ev.x, y: ev && ev.y,
               rowX: row && row.dataset.x, rowY: row && row.dataset.y,
               rowCount: row && row.querySelector('.ev-count') && row.querySelector('.ev-count').textContent };
    })()`);
    check('M-06: журнал показывает ×2 после повтора', evo2.count === '×2' || /×2/.test(evo2.count),
      'было ' + evo.count + ', стало ' + evo2.count + ' world=' + JSON.stringify(evo2));
    check('M-06: строка журнала ведёт к новому месту', evo2.rowX === '31' && evo2.rowY === '32',
      'row=' + evo2.rowX + ',' + evo2.rowY + ' (ожидалось 31,32)');

    /* --- M-19: смерть жителя не рождает ложную сдачу «+0» --- */
    await reload();
    await js(`document.getElementById('btnPlay').click()`);
    await sleep(1800);
    const del = await js(`(() => {
      const s = Play.state, B = Buildings;
      const camp = s.buildings.find(b => B.typeOf(b) === 'lumbercamp' && (b.owner || 0) === 0);
      if (!camp) return { err: 'no camp' };
      for (const v of s.villagers.slice()) {
        Play.localCommand({ type: 'hire', campId: camp.id, villagerId: v.id, owner: 0, from: 0 });
      }
      __game.clock.jump(90000);
      window.__del = [];
      Play.on(ev => { if (ev.type === 'delivery') window.__del.push({ vid: ev.villager && ev.villager.id, amount: ev.amount }); });
      if (s.villagers.length < 3) return { err: 'need three' };
      /* Фиксируем сдачу второго жителя, чтобы его счёт стал больше первого. */
      s.villagers[1].delivered = (s.villagers[1].delivered || 0) + 4;
      s.world.village.logs += 4;
      __game.clock.jump(50);
      const logs = s.world.village.logs;
      window.__del.length = 0;
      /* Первый умирает — второй съезжает на его индекс. При ключе по индексу
         это «сдача» на пустом месте: gained = 0. */
      s.villagers[0].dead = true;
      __game.clock.jump(50);
      return { logs, after: s.world.village.logs, killed: s.villagers.map(v => v.id),
               events: window.__del.slice(0, 5) };
    })()`);
    const falseGain = (del.events || []).some(e => !(e.amount > 0));
    check('M-19: после смерти жителя нет ложной сдачи «+0»', del.err || !falseGain,
      JSON.stringify(del));

    /* --- M-03: «Двигать» в сети берёт дом --- */
    await reload();
    await js(`document.getElementById('btnPlay').click()`);
    await sleep(1800);
    const move = await js(`(() => {
      const s = Play.state, B = Buildings;
      const house = s.buildings.find(b => B.typeOf(b) === 'house' && (b.owner || 0) === 0);
      if (!house) return { err: 'no house' };
      Play.selectBuilding(house);
      const opened = Play.editSelected(house.id);
      s.netRole = 'client'; s.netProtocol = 4;
      const r = Play.editAction('move');
      const out = { opened, ok: r && r.ok, hasEdit: !!s.edit,
        mode: s.edit && s.edit.mode, reason: r && r.reason };
      s.netRole = null; s.netProtocol = null;
      return out;
    })()`);
    check('M-03: «Двигать» не закрывает правку', move.ok === true && move.hasEdit === true,
      JSON.stringify(move));
    check('M-03: дом действительно ведут (mode=move)', move.mode === 'move', 'mode=' + move.mode);

    /* --- M-04: «Новый остров» из сети не оставляет меню --- */
    await reload();
    await js(`document.getElementById('btnPlay').click()`);
    await sleep(1600);
    await js(`(() => { Play.state.netRole = 'client'; __game.newIsland(); return true; })()`);
    await sleep(700);
    const isl = await js(`({ menu: Menu.isOpen(), menuCls: document.getElementById('menu').className,
      hud: !document.getElementById('hud').classList.contains('hidden'), world: !!Play.state.world })`);
    check('M-04: после «Нового острова» из сети меню закрыто', isl.menu === false,
      JSON.stringify(isl));
    check('M-04: HUD и мир на месте', isl.hud === true && isl.world === true, JSON.stringify(isl));

    check('консольных исключений нет', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (e) {
    fails++;
    console.error('  FAIL исключение приёмки: ' + (e && e.stack || e));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    kill();
    console.log(fails ? '\nПРОВАЛЕНО: ' + fails : '\nВсе браузерные проверки пройдены');
    setTimeout(() => process.exit(fails ? 1 : 0), 300);
  }
})();
