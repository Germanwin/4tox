/* army.js — приёмка панели «Войска»: вёрстка, «Всех», «Половина», «Сброс»,
   приказ по карте и цвет воинов на карте.

   Логика отбора проверяется в mapgen2/tools/army.js; здесь — что интерфейс
   действительно зовёт её, что кнопки не выезжают за дощечку, что «Половина»
   отправляет половину отряда, а «Сброс» действительно снимает выбор (раньше
   он его, наоборот, возвращал: отсутствие числа в counts читалось как «новая
   группа» и заменялось полным набором).

   В конце кадр читается по пикселям: под выбранными воинами не должно быть
   колец (ни кремового выбора, ни второго кольца цвета деревни), кайма цвета
   деревни должна быть на самом спрайте, а кольцо — только у воина на задании.
   Правило заказчика 2026-10-24, разбор — в AGENTS.md и game/README.md.

   Запуск: node game/tools/army.js
   Кадры:  game/tools/out/{squad-panel,squad-narrow,army-colors}.png */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = require('../../mapgen2/tools/chrome.js');
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const CDP = 9300 + (process.pid % 90);
const PROF = '/tmp/dsh-4tox-army-' + process.pid;
let fails = 0;
function check(ok, text) { console.log((ok ? '  ok   ' : '  FAIL ') + text); if (!ok) fails++; }
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP,
  '--user-data-dir=' + PROF, '--no-first-run', '--hide-scrollbars', '--window-size=1400,900',
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
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
  };
  /* Кусок экрана для замера пикселей. Под file:// холст игры «испачкан»
     чужим атласом, и getImageData по нему нельзя; снимок DevTools — своя
     картинка, её можно положить на чистый холст и читать. */
  const shotClip = async clip => {
    const s = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    });
    return s.result.data;
  };
  /* Всплывашки от только что созданных воинов живут несколько секунд и на
     кадре закрывают панель. Для снимка их убираем: смотрим вёрстку, а не
     очередь сообщений. */
  const clearToasts = () => js(`document.getElementById('toasts').innerHTML=''; 1`);
  /* Геометрия панели: ни одна кнопка не смеет выйти за дощечку. Проверяются
     ВСЕ кнопки внутри #squadPanel, а не список из шести штук: строки групп
     собираются из army.js, и новая кнопка в строке должна попасть под то же
     правило автоматически. */
  const geometry = async () => js(`(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { l:b.left, t:b.top, r:b.right, b:b.bottom, w:b.width, h:b.height }; };
    const panelEl = document.getElementById('squadPanel');
    const panel = r(panelEl);
    const buttons = [...panelEl.querySelectorAll('button')].map(el => {
      const b = r(el);
      return { id: el.id || el.getAttribute('data-squad'), ...b,
        inside: b.l >= panel.l - 1 && b.r <= panel.r + 1 &&
                b.t >= panel.t - 1 && b.b <= panel.b + 1 };
    });
    const res = r(document.getElementById('resBar'));
    const list = r(document.getElementById('squadList'));
    return {
      vw: innerWidth, vh: innerHeight,
      panel: panel,
      resBottom: res.b,
      list: list,
      buttons: buttons,
      outside: buttons.filter(b => !b.inside).map(b => b.id + ' ' + Math.round(b.l) + '..' + Math.round(b.r)),
      panelInside: panel.l >= 0 && panel.r <= innerWidth && panel.t >= 0 && panel.b <= innerHeight,
      panelOverflowX: panelEl.scrollWidth > panelEl.clientWidth + 1,
      listOverflowX: document.getElementById('squadList').scrollWidth > document.getElementById('squadList').clientWidth + 1,
      docOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      shown: !panelEl.classList.contains('hidden')
    };
  })()`);

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'file://' + path.join(REPO, 'game/index.html') });
  await sleep(500);
  /* __game появляется ДО того, как DOMContentLoaded позовёт start(); если
     начать партию в этот зазор, Play.renderer() ещё null и Play.start падает.
     Ждём именно инициализированный Play, а не просто глобал. */
  let readyNow = false;
  for (let i = 0; i < 300 && !readyNow; i++) {
    readyNow = await js(`(() => {
      try { return !!(window.__game && window.__game.Play && window.__game.Play.renderer && window.__game.Play.renderer()); }
      catch (e) { return false; }
    })()`);
    if (!readyNow) await sleep(200);
  }
  check(readyNow, 'игра загрузилась');
  if (!readyNow) throw new Error('игра не инициализировалась за 60 с');
  await js(`window.__game.start('army-ui',64,{mode:'solo'}); window.__game.Menu.hide(); window.__game.Hud.show(); 1`);
  await sleep(1200);

  const setup = await js(`(() => {
    const P=window.__game.Play, B=window.Buildings, V=window.Villagers, w=P.state.world;
    const camp=B.neighbourSpot(w,P.state.buildings,{type:'warcamp',variant:'x'},window.Session.SITE);
    if(!camp) return {err:'нет места'};
    B.settle(w,camp,window.Session.SITE); P.state.buildings.push(camp);
    const pc=B.patrolCells(camp);
    for(let i=0;i<3;i++){
      const v=V.create(w,{index:200+i,x:pc[i].x+0.5,y:pc[i].y+0.5,buildings:P.state.buildings,avoid:[]});
      v.warrior=true; v.warcamp=camp; v.state='patrol'; P.state.villagers.push(v);
    }
    P.renderer().setBuildings(P.state.buildings); P.renderer().setVillagers(P.state.villagers);
    window.__game.Hud.toggleSquad();
    window.__game.Hud.tick(0.3);
    const rows=[...document.querySelectorAll('#squadList .squad-row')];
    return {rows:rows.length, names:rows.map(r=>r.querySelector('.squad-name').textContent),
      slots:document.getElementById('squadSlots').textContent,
      note:document.getElementById('squadNote').textContent,
      total:rows[0] && rows[0].querySelector('.squad-total').textContent,
      campId:camp.id};
  })()`);
  check(setup.rows === 1 && setup.names[0].indexOf('Лагерь') === 0,
    'панель показывает лагерь: ' + JSON.stringify(setup.names));
  check(setup.slots === 'воины 3', 'счётчик воинов: ' + setup.slots);
  check(setup.note === 'Выбрано 3 из 3', 'по умолчанию выбраны все: ' + setup.note);
  check(setup.total === '3 / 20', 'в строке группы видно «есть / мест»: ' + setup.total);

  await sleep(350);              // plaque-in: меряем уже вставшую панель
  const g1 = await geometry();
  check(g1.shown && g1.panelInside,
    'панель помещается в окно: ' + [g1.panel.l, g1.panel.r, g1.panel.t, g1.panel.b].map(Math.round).join('..') +
    ' в ' + g1.vw + '×' + g1.vh);
  check(g1.buttons.length >= 7 && g1.outside.length === 0,
    'все ' + g1.buttons.length + ' кнопок внутри дощечки' + (g1.outside.length ? ': ' + g1.outside.join(', ') : ''));
  check(!g1.panelOverflowX && !g1.listOverflowX && !g1.docOverflowX,
    'горизонтальной прокрутки нет: панель ' + g1.panel.w.toFixed(0) + ' px, список ' + g1.list.w.toFixed(0) + ' px');
  check(g1.panel.t >= g1.resBottom - 1, 'панель не наезжает на строку ресурсов: ' + Math.round(g1.panel.t) + ' ≥ ' + Math.round(g1.resBottom));

  /* «Сброс» — это НОЛЬ, а не «снова все». Именно здесь панель врала: пустой
     counts refreshSquad трактовал как «группа новая» и выбирал весь отряд. */
  await js(`document.getElementById('squadClear').click(); 1`);
  const cleared = await js(`(() => ({
    ids: window.__game.Play.state.squadIds.length,
    note: document.getElementById('squadNote').textContent,
    num: document.querySelector('#squadList .squad-num').textContent,
    order: document.getElementById('squadOrder').disabled,
    stop: document.getElementById('squadStop').disabled
  }))()`);
  check(cleared.ids === 0 && cleared.num === '0', '«Сброс» снимает выбор: ' + cleared.ids + ', счётчик ' + cleared.num);
  check(cleared.note === 'Выбрано 0 из 3' && cleared.order && !cleared.stop,
    'после сброса: «' + cleared.note + '», «Приказ» выключен, «Стоп» доступен');

  /* «Половина» от трёх — двое. Это ровно тот выбор, который нужен заказчику:
     половина идёт, половина остаётся, а не весь отряд. */
  await js(`document.getElementById('squadHalf').click(); 1`);
  const half = await js(`(() => ({
    ids: window.__game.Play.state.squadIds.slice(),
    note: document.getElementById('squadNote').textContent,
    num: document.querySelector('#squadList .squad-num').textContent
  }))()`);
  check(half.ids.length === 2 && half.num === '2',
    '«Половина» берёт половину всех: ' + half.ids.length + ' из 3, счётчик ' + half.num);
  check(half.note === 'Выбрано 2 из 3', 'надпись после половины: ' + half.note);
  await clearToasts();
  await sleep(350);              // панель доигрывает plaque-in, иначе кадр полупрозрачный
  await shot('squad-panel.png');

  /* Приказ уходит ТОЛЬКО выбранной половине. */
  await js(`document.getElementById('squadOrder').click(); 1`);
  const mode = await js(`!!window.__game.Play.state.order`);
  check(mode, 'кнопка «Приказ» включает режим приказа');
  await js(`window.__game.Play.orderAt({x: 20, y: 20}); 1`);
  const after = await js(`(() => {
    const P=window.__game.Play;
    const ws=P.state.villagers.filter(v=>v.warrior);
    return {orders:ws.filter(v=>v.order).length, mode:!!P.state.order, marker:!!P.state.lastOrder};
  })()`);
  check(after.orders === 2, 'точку приказа получила только выбранная половина: ' + after.orders);
  check(!after.mode && after.marker, 'режим закрылся, метка осталась');

  /* «Стоп» без выбранных останавливает весь отряд, а не говорит «некого». */
  await js(`document.getElementById('squadClear').click(); document.getElementById('squadStop').click(); 1`);
  const stopped = await js(`(() => {
    const ws=window.__game.Play.state.villagers.filter(v=>v.warrior);
    return {orders:ws.filter(v=>v.order).length, states:ws.map(v=>v.state).join(',')};
  })()`);
  check(stopped.orders === 0 && !/march/.test(stopped.states),
    '«Стоп» без выбора снимает приказы у всех: ' + stopped.orders + ' приказов, ' + stopped.states);

  /* Счётчики в строке группы работают и не выходят за границы. */
  await js(`document.querySelector('#squadList [data-squad="inc"]').click(); 1`);
  const inc = await js(`window.__game.Play.state.squadIds.length`);
  check(inc === 1, '«+» в строке добавляет одного: ' + inc);
  await js(`document.querySelector('#squadList [data-squad="half"]').click(); 1`);
  const rowHalf = await js(`(() => ({
    n: window.__game.Play.state.squadIds.length,
    label: document.querySelector('#squadList .squad-half').textContent
  }))()`);
  check(rowHalf.n === 2 && rowHalf.label.indexOf('½') === 0,
    '«' + rowHalf.label + '» берёт половину группы: ' + rowHalf.n + ' из 3');
  await js(`document.getElementById('squadAll').click(); 1`);
  check(await js(`window.__game.Play.state.squadIds.length`) === 3, '«Всех» снова выбирает всех');

  /* Крестик, Esc и клавиша O. Раньше T открывала и сведения, и войска сразу:
     клавиша была занята дважды. Теперь O — войска, T — сведения. */
  await js(`document.getElementById('squadClose').click(); 1`);
  check(await js(`document.getElementById('squadPanel').classList.contains('hidden')`), 'крестик закрывает панель');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'o',bubbles:true})); 1`);
  check(await js(`!document.getElementById('squadPanel').classList.contains('hidden')`), 'клавиша O открывает войска');
  /* Esc при включённом приказе отменяет приказ, а панель оставляет: иначе
     одно нажатие и отменяло бы приказ, и пряталo кнопку, которой его отдали. */
  await js(`document.getElementById('squadOrder').click(); 1`);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
  const escOrder = await js(`(() => ({
    order: !!window.__game.Play.state.order,
    panel: !document.getElementById('squadPanel').classList.contains('hidden')
  }))()`);
  check(!escOrder.order && escOrder.panel, 'Esc отменяет приказ, а панель остаётся');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
  check(await js(`document.getElementById('squadPanel').classList.contains('hidden')`), 'повторный Esc закрывает панель');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',bubbles:true})); 1`);
  const keys = await js(`(() => ({
    squad: !document.getElementById('squadPanel').classList.contains('hidden'),
    drawer: document.getElementById('debugDrawer').classList.contains('open')
  }))()`);
  check(!keys.squad && keys.drawer, 'T открывает только сведения о деревне, не войска');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
  check(await js(`!document.getElementById('debugDrawer').classList.contains('open')`), 'Esc закрывает сведения');

  /* --- цвет на спрайте, а не кольца под ним (правило 2026-10-24) --------
   *
   * Заказчик: «обводка воинов не должна быть такой яркой, двухслойной… сам
   * спрайт жителя должен быть обведён цветом, кружком этих быть не должно;
   * можно только цветные кружки оставить и то только для воинов которые на
   * задании; и более прозрачным сделать всё равно».
   *
   * Проверяется не код, а пиксели кадра, как их видит игрок:
   *   - кремовых колец под выбранными воинами нет вовсе;
   *   - кольца в цвет деревни под стоящими воинами нет — ни в одиночной
   *     игре, ни в партии с двумя городами (там оно было вторым слоем);
   *   - кайма цвета деревни есть на самом спрайте (иначе спрайты никак не
   *     отличить своих от чужих);
   *   - кольцо появляется ровно у того воина, которому дали приказ, и ни у
   *     кого больше.
   *
   * Цвет деревни на время замера — пурпурный: такого нет ни в траве, ни в
   * броне, поэтому кайму и кольцо видно однозначно. Постройки и лишних
   * жителей с кадра убираем: замеряем трёх воинов, а не чужие каймы. */
  await js(`window.__pixScan = async function (b64, w, h, sprites, bodies, centers) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    const rings = centers.map(function () { return 0; });
    const outline = sprites.map(function () { return 0; });
    let cream = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4, r = d[o], gg = d[o + 1], b = d[o + 2];
        if (r > 235 && gg > 218 && b > 145 && b < 235 && r - b > 25) cream++;
        if (!(r > gg + 35 && b > gg + 18 && r > 135 && b > 115)) continue;
        let box = -1;
        for (let i = 0; i < sprites.length; i++) {
          const s = sprites[i];
          if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) { box = i; break; }
        }
        if (box >= 0) outline[box]++;
        /* Кайма спрайта — почти чистый пурпур (зелёного в нём нет), а кольцо
           полупрозрачное, и зелень травы в нём остаётся: g > 60. Так пиксели
           каймы у меча не выдают себя за кольцо. */
        if (gg <= 60) continue;
        let body = false;
        for (let i = 0; i < bodies.length; i++) {
          const s = bodies[i];
          if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) { body = true; break; }
        }
        if (body) continue;
        let best = -1, bd = 1e9;
        for (let i = 0; i < centers.length; i++) {
          const dx = x - centers[i].x, dy = y - centers[i].y, dd = dx * dx + dy * dy;
          if (dd < bd) { bd = dd; best = i; }
        }
        if (bd < 60 * 60) rings[best]++;
      }
    }
    return { cream: cream, rings: rings, outline: outline, w: w, h: h };
  }; 1`);

  const scene = await js(`(() => {
    const P=window.__game.Play, B=window.Buildings, r=P.renderer(), w=P.state.world;
    P.state.running=false;                 // картина должна стоять, пока меряем
    P.state.lastOrder=null;
    const camp=P.state.buildings.find(function (b) { return B.typeOf(b)==='warcamp'; });
    const ws=P.state.villagers.filter(function (v) { return v.warrior; }).slice(0,3);
    if(!camp || ws.length<3) return {err:'нет лагеря или трёх воинов'};
    /* Три клетки суши вокруг лагеря, максимально далеко друг от друга.
       Деревья, камни и постройки на этом кадре не рисуются: замеряем цвет
       воинов, а не то, что стоит рядом. */
    const cand=[];
    for(let dy=-4; dy<=4; dy++) for(let dx=-4; dx<=4; dx++){
      const x=camp.x+dx, y=camp.y+dy;
      if(x<2||y<2||x>=w.width-2||y>=w.height-2) continue;
      if(!w.isLand[y*w.width+x]) continue;
      cand.push({x:x+0.5,y:y+0.5});
    }
    const spots=[];
    if(cand.length) spots.push(cand[0]);
    while(spots.length<3){
      let best=null, bestD=-1;
      for(const s of cand){
        let d=1e9;
        for(const p of spots) d=Math.min(d, Math.hypot(s.x-p.x, s.y-p.y));
        if(d>bestD){ bestD=d; best=s; }
      }
      if(!best || bestD<3.2) break;
      spots.push(best);
    }
    if(spots.length<3) return {err:'нет трёх клеток суши на расстоянии', n:cand.length, camp:{x:camp.x,y:camp.y}, size:[w.width,w.height], spots:spots};
    ws.forEach(function (v,i) {
      v.x=spots[i].x; v.y=spots[i].y;
      v.path=null; v.order=null; v.combatMode=null; v.target=null; v.state='stand';
    });
    r.setBuildings([]); r.setVillagers(ws);
    r.showTrees=false; r.showRocks=false; r.showSmall=false;
    r.cam.zoom=80;
    r.centerOn((spots[0].x+spots[1].x+spots[2].x)/3, (spots[0].y+spots[1].y+spots[2].y)/3);
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('toasts').innerHTML='';
    window.__savedTownColor=w.towns[0].color;
    w.towns[0].color='#ff00ff';
    P.draw(1);
    return {ids:ws.map(function (v) { return v.id; }), spots:spots};
  })()`);
  check(!scene.err, 'сцена для замера цвета собрана' + (scene.err ? ': ' + scene.err + ' ' + JSON.stringify(scene) : ''));
  if (scene.err) throw new Error('сцена для замера не собралась: ' + scene.err);

  const geom = await js(`(() => {
    const P=window.__game.Play, r=P.renderer();
    const ws=P.state.villagers.filter(function (v) { return v.warrior; }).slice(0,3);
    const c={x:r.cssW/2,y:r.cssH/2};
    const a=ws.map(function (v) {
      const b=r.villagerBox(v,r.cam.zoom);
      return {id:v.id, cx:c.x+b.x, cy:c.y+b.y, x:c.x+b.dx, y:c.y+b.dy, w:b.dw, h:b.dh};
    });
    const x0=Math.max(0,Math.floor(Math.min.apply(null,a.map(function (q) { return q.x; }))-28));
    const y0=Math.max(0,Math.floor(Math.min.apply(null,a.map(function (q) { return q.y; }))-28));
    const x1=Math.min(r.cssW-1,Math.ceil(Math.max.apply(null,a.map(function (q) { return q.x+q.w; }))+28));
    const y1=Math.min(r.cssH-1,Math.ceil(Math.max.apply(null,a.map(function (q) { return q.y+q.h; }))+28));
    return {clip:{x:x0,y:y0,width:x1-x0,height:y1-y0}, a:a};
  })()`);
  const sprites = geom.a.map(q => ({ x: Math.round(q.x - geom.clip.x), y: Math.round(q.y - geom.clip.y), w: Math.round(q.w), h: Math.round(q.h) }));
  /* Тело — узкая рамка вокруг человека, без прозрачных полей кадра: кольцо
     шире силуэта и должно считаться, а не прятаться за кадром. */
  const bodies = geom.a.map(q => ({
    x: Math.round(q.cx - 0.34 * q.w - 2 - geom.clip.x),
    y: Math.round(q.cy - 0.95 * q.h - geom.clip.y),
    w: Math.round(0.68 * q.w + 4),
    h: Math.round(0.95 * q.h + 6)
  }));
  const centers = geom.a.map(q => ({ x: Math.round(q.cx - geom.clip.x), y: Math.round(q.cy - geom.clip.y) }));
  const scan = async () => js(`window.__pixScan(${JSON.stringify(await shotClip(geom.clip))}, ` +
    geom.clip.width + ', ' + geom.clip.height + ', ' + JSON.stringify(sprites) + ', ' +
    JSON.stringify(bodies) + ', ' + JSON.stringify(centers) + ')');

  const idlePix = await scan();
  check(idlePix.cream === 0,
    'под выбранными воинами нет кремовых колец: ' + idlePix.cream + ' px');
  check(idlePix.rings.every(n => n === 0),
    'под стоящими воинами нет цветных колец: ' + JSON.stringify(idlePix.rings));
  check(idlePix.outline.every(n => n > 8),
    'кайма цвета деревни на самом спрайте: ' + JSON.stringify(idlePix.outline) + ' px');

  /* Два города: раньше это включало второе кольцо под каждым жителем. */
  await js(`(() => {
    const P=window.__game.Play, w=P.state.world;
    w.towns.push({id:1, owner:1, name:'Враг', color:'#00ff00', alive:true,
      isBot:true, logs:0, buildings:[], villagers:[]});
    P.draw(1);
    return w.towns.length;
  })()`);
  const multiPix = await scan();
  check(multiPix.cream === 0 && multiPix.rings.every(n => n === 0),
    'в партии с двумя городами колец под стоящими тоже нет: ' +
    multiPix.cream + ' кремовых, ' + JSON.stringify(multiPix.rings));
  await js(`window.__game.Play.state.world.towns.pop(); window.__game.Play.draw(1); 1`);

  /* Приказ — единственный случай, когда кольцо остаётся. Оно тонкое и
     прозрачное, и только у того, кто его получил. */
  await js(`(() => {
    const P=window.__game.Play;
    const v=P.state.villagers.filter(function (x) { return x.warrior; })[1];
    v.order={x:v.x+2.5, y:v.y+1.5, r:2.5, issuedAt:1, done:false};
    v.state='march';
    P.draw(1);
    return 1;
  })()`);
  const missionPix = await scan();
  check(missionPix.cream === 0,
    'у воина на задании кольцо не кремовое: ' + missionPix.cream + ' px');
  check(missionPix.rings[1] > 10 && missionPix.rings[0] === 0 && missionPix.rings[2] === 0,
    'кольцо только у воина на задании: ' + JSON.stringify(missionPix.rings));
  await shot('army-colors.png');

  /* Вернуть сцену: приёмка продолжается на обычном мире. */
  await js(`(() => {
    const P=window.__game.Play, w=P.state.world, r=P.renderer();
    w.towns[0].color=window.__savedTownColor;
    document.getElementById('hud').classList.remove('hidden');
    P.state.running=true;
    r.showTrees=true; r.showRocks=true; r.showSmall=true;
    r.setBuildings(P.state.buildings);
    r.setVillagers(P.state.villagers);
    P.draw(1);
    return 1;
  })()`);

  /* Узкое окно: та же панель, те же кнопки, ничего не уехало. */
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await js(`document.getElementById('btnSquad').click(); 1`);
  await sleep(350);              // панель доигрывает plaque-in, иначе кадр полупрозрачный
  const g2 = await geometry();
  check(g2.shown && g2.panelInside,
    'в узком окне панель помещается: ' + [g2.panel.l, g2.panel.r, g2.panel.t, g2.panel.b].map(Math.round).join('..') +
    ' в ' + g2.vw + '×' + g2.vh);
  check(g2.buttons.length >= 7 && g2.outside.length === 0,
    'в узком окне все кнопки внутри дощечки' + (g2.outside.length ? ': ' + g2.outside.join(', ') : ''));
  check(!g2.panelOverflowX && !g2.docOverflowX, 'в узком окне нет горизонтальной прокрутки');
  await clearToasts();
  await shot('squad-narrow.png');

  /* 3–4 игрока: падение чужой ратуши больше не показывает хосту
     «Поражение» и не морозит мир. Своя — переводит в наблюдатели без
     доступа к стройке и войску; партия кончается только когда остался один
     город. */
  const standing = await js(`(() => {
    const P=window.__game.Play, w=P.state.world;
    w.towns.push({ id:1, owner:1, name:'Второй', color:'#d94a4a', alive:true,
      logs:0, buildings:[], villagers:[], townhall:null });
    w.towns.push({ id:2, owner:2, name:'Третий', color:'#9b59b6', alive:true,
      logs:0, buildings:[], villagers:[], townhall:null });
    P.handleTownFallen(0);
    const own = {
      spectator:P.state.spectator, over:P.state.over, running:P.state.running,
      badge:!document.getElementById('spectatorBadge').classList.contains('hidden'),
      buildDisabled:document.getElementById('btnBuild').disabled,
      canCommand:P.canCommand(),
      beginBuild:P.beginBuild('house').ok
    };
    P.handleTownFallen(1);
    return {
      own:own,
      end:{ over:P.state.over, winner:P.state.winner, result:P.state.result,
        shown:!document.getElementById('result').classList.contains('hidden'),
        title:document.getElementById('resultTitle').textContent }
    };
  })()`);
  check(standing && standing.own.spectator === true &&
    standing.own.over === false && standing.own.running === true &&
    standing.own.badge === true && standing.own.buildDisabled === true &&
    standing.own.canCommand === false && standing.own.beginBuild === false,
    'своя ратуша в 3 игроках — наблюдение, мир идёт: ' + JSON.stringify(standing && standing.own));
  check(standing && standing.end.over === true && standing.end.winner === 2 &&
    standing.end.result === 'lose' && standing.end.shown === true &&
    standing.end.title === 'Поражение',
    'последний город определяет итог, а не «владелец 1»: ' +
      JSON.stringify(standing && standing.end));

  ws.close();
  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nПАНЕЛЬ ВОЙСК ПРИНЯТА');
  kill();
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('ошибка: ' + (e.stack || e));
  kill();
  process.exit(1);
});
