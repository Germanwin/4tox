/* modes.js — приёмка режима «против деревни»: меню, состав врага, итог.

   Открывает игру по file:// (как её открывает игрок), выбирает карточку
   «Против деревни» и жмёт «Играть». Проверяет, что на карте две деревни:
   игрок у края, враг в другом конце; у врага ровно тот состав, что просил
   заказчик; экран победы/поражения показывается.

   Запуск: node game/tools/modes.js */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const CHROME = require('../../mapgen2/tools/chrome.js');
const REPO = path.resolve(__dirname, '..', '..');
const CDP = 9200 + (process.pid % 90);
const PROF = '/tmp/dsh-4tox-modes-' + process.pid;
let fails = 0;
function check(ok, text) { console.log((ok ? '  ok   ' : '  FAIL ') + text); if (!ok) fails++; }
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP,
  '--user-data-dir=' + PROF, '--no-first-run', '--hide-scrollbars', '--window-size=1440,900',
  'about:blank'], { detached: true, stdio: 'ignore' });
function kill() { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {} }
process.on('SIGINT', () => { kill(); process.exit(130); });

(async () => {
  let tabs = [];
  for (let i = 0; i < 100; i++) {
    try { tabs = await getJSON('http://127.0.0.1:' + CDP + '/json/list'); break; } catch (e) { await sleep(100); }
  }
  const tab = tabs.find(t => t.type === 'page' && t.url === 'about:blank') || tabs.find(t => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'file://' + path.join(REPO, 'game/index.html') });
  await sleep(6500);
  check(await js('!!window.__game'), 'игра загрузилась');

  await js(`document.querySelector('[data-mode="bot"]').click(); 1`);
  check(await js(`document.querySelector('[data-mode="bot"]').classList.contains('selected')`), 'карточка «Против деревни» выбрана');
  await js(`document.getElementById('btnPlay').click(); 1`);
  await sleep(7000);

  const st = await js(`(() => {
    const P=window.__game.Play, w=P.state.world, B=window.Buildings;
    return {
      mode: P.state.gameMode, towns: w.towns.length,
      buildings: P.state.buildings.length,
      player: w.towns[0].buildings.length,
      bot: w.towns[1].buildings.length,
      botTypes: w.towns[1].buildings.map(b => B.typeOf(b)),
      botVillagers: w.towns[1].villagers.length,
      warriors: w.towns[1].villagers.filter(v => v.warrior).length,
      workers: w.towns[1].villagers.filter(v => v.employer).length,
      houses: w.towns[1].buildings.filter(b => B.typeOf(b) === 'house').length
    };
  })()`);
  check(st.mode === 'bot' && st.towns === 2, 'режим «против деревни»: ' + st.mode + ', городов ' + st.towns);
  check(st.player === 3, 'у игрока три постройки: ' + st.player);
  check(st.bot === 9, 'у врага девять построек: ' + st.bot);
  check(st.botTypes.filter(t => t === 'lumbercamp').length === 2, 'два лагеря лесорубов');
  check(st.botTypes.filter(t => t === 'warcamp').length === 1, 'военный лагерь');
  check(st.botTypes.filter(t => t === 'barracks').length === 1, 'казарма');
  check(st.houses === 4, 'четыре дома: ' + st.houses);
  check(st.botVillagers === 16, '16 жителей врага: ' + st.botVillagers);
  check(st.warriors === 10, '10 воинов: ' + st.warriors);
  check(st.workers === 6, '6 лесорубов: ' + st.workers);

  const colors = await js(`(() => {
    const P=window.__game.Play, w=P.state.world, r=P.renderer();
    return {own:r.teamColor(w.towns[0].buildings[0]), foe:r.teamColor(w.towns[1].buildings[0])};
  })()`);
  check(!!colors.own && !!colors.foe && colors.own !== colors.foe,
    'свои и чужие постройки разных цветов: ' + colors.own + ' / ' + colors.foe);

  const ui = await js(`(() => {
    window.__game.Hud.onDefeat({ result: 'win' });
    return { shown: !document.getElementById('result').classList.contains('hidden'),
             title: document.getElementById('resultTitle').textContent };
  })()`);
  check(ui.shown && ui.title === 'Победа', 'экран победы показывается: ' + ui.title);

  ws.close();
  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nРЕЖИМ ПРОТИВ ДЕРЕВНИ ПРИНЯТ');
  kill();
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('ошибка: ' + (e.stack || e));
  kill();
  process.exit(1);
});
