#!/usr/bin/env node
/* analyze.js — превращает сырые прогоны паспорта в числа.
 *
 * Что делает: читает runs/<scenario>/<run>/{scenario,host,guest}.json и
 * server-samples.jsonl, режет выборки по меткам measure-start/measure-end,
 * которые обвязка ставит на странице, и пишет:
 *
 *   runs/<scenario>/<run>/summary.json  — числа одного прогона
 *   runs/<scenario>/summary.json        — все повторы сценария + сводка
 *   runs/<scenario>/summary.md          — то же человеческим языком
 *   runs/summary.md                     — таблица по всем сценариям
 *
 * Почему режем по меткам, а не по «плану»: опрос страниц раз в секунду сам
 * занимает время, поэтому фактическое окно измерения длиннее запланированного.
 * Числа считаются по факту, план печатается рядом.
 *
 * Запуск: node tools/analyze.js [каталог-прогонов]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'runs'));

/* ------------------------------------------------------------ статистика */
function nums(a) { return a.filter(x => typeof x === 'number' && isFinite(x)); }
function stat(list) {
  const a = nums(list).slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return { n: 0, median: null, p95: null, p99: null, max: null, mean: null, sum: 0 };
  const q = p => a[Math.min(n - 1, Math.floor(p * n))];
  let sum = 0;
  for (const v of a) sum += v;
  return {
    n, min: a[0], median: q(0.5), p95: q(0.95),
    /* p99 из десятка записей — это максимум, и выдавать его за p99 нельзя:
       при n < 100 поле остаётся null, а n виден рядом. */
    p99: n >= 100 ? q(0.99) : null,
    max: a[n - 1], mean: sum / n, sum
  };
}
function diffs(list) {
  const out = [];
  for (let i = 1; i < list.length; i++) out.push(list[i] - list[i - 1]);
  return out;
}
/* Гистограмма интервалов: нужна не средняя, а ФОРМА распределения — «раз в
   секунду» иначе не отличить от «среднее 900 мс из-за одной паузы». Края
   выбраны так, чтобы были видны и 60 к/с, и секунда, и больше. */
const BUCKETS = [0, 10, 20, 30, 45, 60, 90, 120, 200, 400, 800, 1200, 2000, 1e9];
const BUCKET_NAMES = ['<10', '10-20', '20-30', '30-45', '45-60', '60-90', '90-120',
  '120-200', '200-400', '400-800', '800-1200', '1200-2000', '>2000'];
function hist(list) {
  const a = nums(list);
  if (!a.length) return null;
  const out = {};
  BUCKET_NAMES.forEach((n, i) => { out[n] = 0; });
  for (const v of a) {
    for (let i = 0; i < BUCKET_NAMES.length; i++) {
      if (v >= BUCKETS[i] && v < BUCKETS[i + 1]) { out[BUCKET_NAMES[i]]++; break; }
    }
  }
  out.n = a.length;
  return out;
}
function r(x, d) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * Math.pow(10, d || 2)) / Math.pow(10, d || 2); }
function pct(a, b) { return b ? r(100 * a / b, 1) : null; }

/* --------------------------------------------------------------- прогон */
function loadRun(dir) {
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; } };
  const sc = rd('scenario.json');
  if (!sc) return null;
  const run = { dir, scenario: sc, host: rd('host.json'), guest: rd('guest.json'), samples: [] };
  try {
    const lines = fs.readFileSync(path.join(dir, 'server-samples.jsonl'), 'utf8').split('\n');
    for (const ln of lines) { if (ln.trim()) run.samples.push(JSON.parse(ln)); }
  } catch (e) { /* нет сэмплов — не ошибка */ }
  return run;
}

function windowOf(page) {
  if (!page || !page.marks) return null;
  const s = page.marks.find(m => m.label === 'measure-start');
  const e = page.marks.find(m => m.label === 'measure-end');
  if (!s) return null;
  return { from: s.t, to: e ? e.t : (page.nowWall ? Infinity : Infinity), s, e };
}
function between(list, w, idx) {
  if (!w) return list;
  return list.filter(x => x && x[idx] >= w.from && (w.to === Infinity || x[idx] <= w.to));
}

function pageSummary(page, role) {
  if (!page || page.err) return { err: page ? page.err : 'нет страницы' };
  const out = { info: page.info, errors: (page.errors || []).slice(0, 40), errorCount: (page.errors || []).length };
  const w = windowOf(page);
  out.window = w ? { from: r(w.from, 1), to: r(w.to, 1), sec: r((w.to - w.from) / 1000, 2) } : null;

  const frames = between(page.frames || [], w, 0);
  const ft = frames.map(f => f[0]);
  const fd = diffs(ft);
  out.raf = stat(fd);
  out.raf.fps = fd.length && (ft[ft.length - 1] - ft[0]) > 0
    ? r(1000 * fd.length / (ft[ft.length - 1] - ft[0]), 1) : null;
  out.raf.over33 = fd.filter(x => x > 33).length;
  out.raf.over100 = fd.filter(x => x > 100).length;
  out.raf.over1000 = fd.filter(x => x > 1000).length;
  out.raf.histogram = hist(fd);
  out.raf.hiddenFrames = frames.filter(f => f[8] === 1).length;
  out.raf.count = frames.length;

  const ticks = between(page.ticks || [], w, 0);
  out.ticks = { n: ticks.length };
  out.ticks.dtSum = r(ticks.reduce((a, k) => a + (k[1] || 0), 0), 3);
  out.ticks.dt = stat(ticks.map(k => k[1]));
  out.ticks.ms = stat(ticks.map(k => k[2]));
  if (w && w.to > w.from) {
    out.ticks.perSec = r(ticks.length / ((w.to - w.from) / 1000), 2);
    out.ticks.worldSecPerRealSec = r(out.ticks.dtSum / ((w.to - w.from) / 1000), 3);
  }

  const secs = (page.secs || []).filter(s => w ? (s.t >= w.from && s.t <= w.to) : true);
  if (secs.length >= 2) {
    const a = secs[0], z = secs[secs.length - 1];
    const dt = (z.t - a.t) / 1000;
    out.seconds = {
      n: secs.length, spanSec: r(dt, 2),
      simDelta: r(z.simSec - a.simSec, 3),
      simPerReal: r((z.simSec - a.simSec) / dt, 3),
      netSeqDelta: z.netSeq - a.netSeq,
      netSeqPerSec: r((z.netSeq - a.netSeq) / dt, 2),
      vis: secs.map(s => s.vis),
      role: z.role,
      lastNetEvery: z.netEvery, lastQueue: z.netQueue, gzip: z.netGzip,
      staleCount: secs.filter(s => s.netStale).length,
      hostGoneCount: secs.filter(s => s.netHostGone).length,
      dropped: z.simDropped,
      faults: secs.filter(s => s.fault).length,
      heapUsedMB: z.mem ? r(z.mem.used / 1048576, 1) : null,
      heapTotalMB: z.mem ? r(z.mem.total / 1048576, 1) : null
    };
    /* Счётчики движка — дельтой между первым и последним секундным срезом. */
    const m0 = a.m || {}, m1 = z.m || {};
    const dm = {};
    for (const k of ['steps', 'stepMs', 'longSteps', 'maxStepMs', 'frames', 'frameMs', 'frameMaxMs',
      'frameOver16', 'frameOver33', 'frameOver50', 'caughtUpSec', 'droppedSec', 'catchUpMs',
      'paths', 'nodes', 'fails', 'budgetHits', 'pathDeferred', 'pathFairServed',
      'snaps', 'snapMs', 'snapBytes', 'snapGzBytes', 'snapApplyMs', 'births', 'combatMs', 'attacks']) {
      if (typeof m1[k] === 'number' || typeof m0[k] === 'number') {
        dm[k] = r((m1[k] || 0) - (m0[k] || 0), 3);
      }
    }
    dm.stepMsPerStep = dm.steps ? r(dm.stepMs / dm.steps, 3) : null;
    dm.frameMsPerFrame = dm.frames ? r(dm.frameMs / dm.frames, 3) : null;
    out.metrics = dm;
    out.metricsRawLast = z.m || null;
    out.agg = z.agg || null;
  }

  const applies = between(page.applies || [], w, 0);
  out.applies = { count: applies.length };
  if (applies.length) {
    const at = applies.map(a => a[0]);
    const ai = diffs(at);
    out.applies.interval = stat(ai);
    out.applies.histogram = hist(ai);
    /* Скорость считаем по ФАКТИЧЕСКОМУ отрезку удержанных записей, а не по
       всему окну: кольцо обвязки ограничено, и на длинном прогоне старые
       записи вытесняются. Иначе 12 снимков/с в 15-минутном soak выглядели бы
       как 2.2/с. */
    const span = (at[at.length - 1] - at[0]) / 1000;
    out.applies.perSec = span > 0 ? r((applies.length - 1) / span, 2) : null;
    out.applies.ringWrapped = applies.length >= 2000;
    out.applies.ms = stat(applies.map(a => a[4]));
    const seqs = applies.map(a => a[1]).filter(x => x >= 0);
    let gaps = 0, dup = 0;
    for (let i = 1; i < seqs.length; i++) {
      const d = seqs[i] - seqs[i - 1];
      if (d > 1) gaps += d - 1;
      if (d <= 0) dup++;
    }
    out.applies.seqGaps = gaps; out.applies.outOfOrder = dup;
    out.applies.smoothOff = applies.filter(a => a[3] === 0).length;
    out.applies.smoothOn = applies.filter(a => a[3] === 1).length;
    const ht = applies.map(a => a[2]).filter(x => x >= 0);
    out.applies.hostTimeSpan = ht.length ? r(ht[ht.length - 1] - ht[0], 3) : null;
  }

  const sends = between(page.sends || [], w, 0);
  out.sends = { count: sends.length };
  if (sends.length) {
    out.sends.interval = stat(diffs(sends.map(s => s[0])));
    out.sends.histogram = hist(diffs(sends.map(s => s[0])));
    const span = (sends[sends.length - 1][0] - sends[0][0]) / 1000;
    out.sends.perSec = span > 0 ? r((sends.length - 1) / span, 2) : null;
    out.sends.ringWrapped = sends.length >= 2000;
    out.sends.durMs = stat(sends.map(s => s[1]));
    out.sends.jsonBytes = stat(sends.map(s => s[2]).filter(x => x > 0));
    out.sends.queue = stat(sends.map(s => s[3]).filter(x => x >= 0));
    out.sends.gzipOn = sends.filter(s => s[4] === 1).length;
    out.sends.failed = sends.filter(s => s[5] === -1).length;
    out.sends.ok = sends.filter(s => s[5] === 1).length;
  }

  /* Раннее окно: первые 30 с измерения. Нужно затем, что в S3 страница хоста
     в трёх прогонах из трёх перестаёт выполняться примерно на 66-й секунде
     жизни страницы (см. runs/S3/README.md). Считать темп по всему окну в этом
     случае нельзя: среднее смешивает «раз в секунду» и «не считает вовсе». */
  if (w) {
    const cut = w.from + 30000;
    const ap = (page.applies || []).filter(a => a[0] >= w.from && a[0] <= Math.min(cut, w.to));
    const sd = (page.sends || []).filter(a => a[0] >= w.from && a[0] <= Math.min(cut, w.to));
    const fr = (page.frames || []).filter(f => f[0] >= w.from && f[0] <= Math.min(cut, w.to));
    const early = { windowSec: Math.min(30, (w.to - w.from) / 1000) };
    if (sd.length > 1) {
      const span = (sd[sd.length - 1][0] - sd[0][0]) / 1000;
      early.sendsPerSec = span > 0 ? r((sd.length - 1) / span, 2) : null;
      early.sendsInterval = stat(diffs(sd.map(x => x[0])));
    }
    if (ap.length > 1) {
      const span = (ap[ap.length - 1][0] - ap[0][0]) / 1000;
      early.appliesPerSec = span > 0 ? r((ap.length - 1) / span, 2) : null;
      early.appliesInterval = stat(diffs(ap.map(x => x[0])));
    }
    if (fr.length > 2) early.rafFps = r(1000 * (fr.length - 1) / (fr[fr.length - 1][0] - fr[0][0]), 1);
    /* Где страница перестала давать новые записи (если перестала). */
    /* «Страница перестала» считаем только по данным, которых без неё быть не
       может: снимки у хоста и применения у гостя. Кадры не годятся — гость
       продолжает рисовать и после того, как данные перестали приходить. */
    const lastOf = arr => (arr && arr.length ? arr[arr.length - 1][0] : null);
    const lasts = [lastOf(page.sends), lastOf(page.applies)].filter(x => x !== null);
    if (lasts.length && w.to - Math.max(...lasts) > 5000) {
      early.stoppedAtSec = r((Math.max(...lasts) - w.from) / 1000, 1);
      early.silenceSec = r((w.to - Math.max(...lasts)) / 1000, 1);
    }
    out.early = early;
  }

  /* Движение наблюдаемого жителя: сколько кадров он стоит на месте, хотя
     цель (позиция из снимка) уехала; какой длины прыжки цели. */
  const who = page.watch;
  const fv = frames.filter(f => f[3] !== null && !isNaN(f[3]));
  if (fv.length > 2) {
    let still = 0, moved = 0, targetJumps = 0, jumpDist = 0, maxJump = 0, maxRenderedStep = 0;
    let waitingStill = 0;
    for (let i = 1; i < fv.length; i++) {
      const p = fv[i - 1], c = fv[i];
      const dR = Math.abs(c[3] - p[3]) + Math.abs(c[4] - p[4]);
      const dT = Math.abs(c[5] - p[5]) + Math.abs(c[6] - p[6]);
      if (dR < 1e-6) still++; else moved++;
      if (dR > maxRenderedStep) maxRenderedStep = dR;
      if (dT > 1e-6) { targetJumps++; jumpDist += dT; if (dT > maxJump) maxJump = dT; }
      const lag = Math.abs(c[3] - c[5]) + Math.abs(c[4] - c[6]);
      if (dR < 1e-6 && lag < 1e-3) waitingStill++;   // догнал и ждёт следующий снимок
    }
    out.motion = {
      villagerId: who, frames: fv.length,
      stillFrames: still, movedFrames: moved,
      stillPct: pct(still, still + moved),
      waitingStillFrames: waitingStill,
      waitingStillPct: pct(waitingStill, fv.length),
      targetJumps, targetJumpMean: targetJumps ? r(jumpDist / targetJumps, 3) : null,
      targetJumpMax: r(maxJump, 3),
      maxRenderedStep: r(maxRenderedStep, 3)
    };
  }
  return out;
}

function serverSummary(samples) {
  if (!samples.length) return { n: 0 };
  const pick = (o, p) => p.split('.').reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), o);
  const field = p => samples.map(s => pick(s, p)).filter(x => typeof x === 'number');
  const out = { n: samples.length };
  for (const [name, p] of [
    ['queue', 'streamStats.queue'], ['wireQueue', 'streamStats.wireQueue'],
    ['queueAge', 'streamStats.queueAge'], ['gzipQueue', 'streamStats.gzipQueue'],
    ['pendingSnapshot', 'streamStats.pendingSnapshot'], ['dropped', 'streamStats.dropped'],
    ['coalesced', 'streamStats.coalesced'], ['bytes', 'streamStats.bytes'],
    ['hostSim', 'probe.host.simSec'], ['guestSim', 'probe.guest.simSec'],
    ['hostSeq', 'probe.host.seq'], ['guestSeq', 'probe.guest.seq']
  ]) {
    const v = field(p);
    if (v.length) out[name] = stat(v);
  }
  out.lastRaw = samples[samples.length - 1];
  return out;
}

/* ------------------------------------------------------------------ main */
function listDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch (e) { return []; }
}

const scenarios = listDirs(DIR).filter(d => /^S\d/.test(d)).sort();
const all = {};
for (const sc of scenarios) {
  const runs = listDirs(path.join(DIR, sc)).filter(d => /^r\d+/.test(d)).sort();
  const each = [];
  for (const rn of runs) {
    const run = loadRun(path.join(DIR, sc, rn));
    if (!run) continue;
    const s = {
      run: rn,
      scenario: run.scenario.scenario,
      headless: run.scenario.headless,
      measurePlannedSec: run.scenario.measureSec,
      measureActualSec: run.scenario.measure && run.scenario.measure.actualSec,
      seed: run.scenario.start && run.scenario.start.seed,
      size: run.scenario.start && run.scenario.start.size,
      players: run.scenario.start && run.scenario.start.players,
      sameWindow: run.scenario.sameWindow,
      windows: run.scenario.windows,
      chrome: run.scenario.chrome,
      ua: run.scenario.userAgent,
      observed: run.scenario.observed,
      host: pageSummary(run.host, 'host'),
      guest: pageSummary(run.guest, 'client'),
      server: serverSummary(run.samples)
    };
    fs.writeFileSync(path.join(DIR, sc, rn, 'summary.json'), JSON.stringify(s, null, 2));
    each.push(s);
  }
  all[sc] = each;
}

/* ------------------------------------------------------------------ текст */
function fmt(v, d) { return v === null || v === undefined ? '—' : (typeof v === 'number' ? v.toFixed(d === undefined ? 1 : d) : String(v)); }
function med(x) { return x && x.median !== null ? x.median : null; }

let md = '# Сводка прогонов\n\nВсе числа — по сырым выборкам из `runs/<scenario>/<run>/*.json`.\n' +
  'Окно измерения — фактическое (`measure.actualSec`), а не запланированное.\n\n';
md += '| сценарий | повтор | окно, с | роль хоста | rAF хоста, к/с | rAF гостя, к/с | снимков/с (хост→гость) | мир хоста, с/с | vis хоста | vis гостя |\n';
md += '|---|---|---|---|---|---|---|---|---|---|\n';
for (const sc of scenarios) {
  for (const s of all[sc]) {
    md += '| ' + sc + ' | ' + s.run + ' | ' + fmt(s.measureActualSec, 1) + ' | ' +
      fmt(s.host && s.host.seconds && s.host.seconds.role) + ' | ' +
      fmt(s.host && s.host.raf && s.host.raf.fps) + ' | ' +
      fmt(s.guest && s.guest.raf && s.guest.raf.fps) + ' | ' +
      fmt(s.host && s.host.sends && s.host.sends.perSec, 2) + ' / ' + fmt(s.guest && s.guest.applies && s.guest.applies.perSec, 2) + ' | ' +
      fmt(s.host && s.host.seconds && s.host.seconds.simPerReal, 3) + ' | ' +
      fmt(s.observed && s.observed.host && s.observed.host.vis) + ' | ' +
      fmt(s.observed && s.observed.guest && s.observed.guest.vis) + ' |\n';
  }
}
/* Сводка по сценарию: медиана по повторам. Медиана, а не среднее: три
   прогона — это три числа, и одно выпавшее не должно двигать итог. */
function medOf(list) {
  const a = list.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}
md += '\n## Сводка по сценариям (медиана по повторам)\n\n';
md += '| сценарий | повторов | rAF хост | rAF гость | снимков/с хост | применений/с гость | интервал применения мед/p95, мс | smooth off | кадров «стоит» | кадров «догнал и ждёт» | мир хоста с/с | longtask | heap, МБ | очередь сервера, Б |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const sc of scenarios) {
  const runs = all[sc];
  if (!runs.length) continue;
  const g = k => medOf(runs.map(k));
  md += '| ' + sc + ' | ' + runs.length + ' | ' +
    fmt(g(x => x.host && x.host.raf && x.host.raf.fps)) + ' | ' +
    fmt(g(x => x.guest && x.guest.raf && x.guest.raf.fps)) + ' | ' +
    fmt(g(x => x.host && x.host.sends && x.host.sends.perSec), 2) + ' | ' +
    fmt(g(x => x.guest && x.guest.applies && x.guest.applies.perSec), 2) + ' | ' +
    fmt(g(x => x.guest && x.guest.applies && x.guest.applies.interval && x.guest.applies.interval.median), 1) + ' / ' +
    fmt(g(x => x.guest && x.guest.applies && x.guest.applies.interval && x.guest.applies.interval.p95), 1) + ' | ' +
    fmt(g(x => (x.guest && x.guest.applies && (x.guest.applies.smoothOn || 0) + (x.guest.applies.smoothOff || 0) > 0)
      ? x.guest.applies.smoothOff : null), 0) + ' | ' +
    fmt(g(x => x.guest && x.guest.motion && x.guest.motion.stillPct), 1) + '% | ' +
    fmt(g(x => x.guest && x.guest.motion && x.guest.motion.waitingStillPct), 1) + '% | ' +
    fmt(g(x => x.host && x.host.seconds && x.host.seconds.simPerReal), 3) + ' | ' +
    fmt(g(x => x.host && x.host.agg && x.host.agg.longTasks), 0) + ' | ' +
    fmt(g(x => x.host && x.host.seconds && x.host.seconds.heapUsedMB), 1) + ' | ' +
    fmt(g(x => x.server && x.server.queue && x.server.queue.max), 0) + ' |\n';
}
md += '\n## Детали по сценариям\n';
for (const sc of scenarios) {
  const runs = all[sc];
  if (!runs.length) { md += '\n### ' + sc + '\n\nнет прогонов\n'; continue; }
  md += '\n### ' + sc + '\n\n';
  md += '| повтор | сеть: применение снимка, мс (мед/p95/max) | пропущено seq | smooth off | кадров без движения | прыжок цели, клеток (сред/max) | шаг кадра хоста, мс (мед/p95/max) | шаг мира, мс (мед/p95/max) |\n';
  md += '|---|---|---|---|---|---|---|---|\n';
  for (const s of runs) {
    const a = s.guest && s.guest.applies;
    const m = s.guest && s.guest.motion;
    const ht = s.host && s.host.ticks && s.host.ticks.ms;
    const hs = s.host && s.host.ticks && s.host.ticks.dt;
    md += '| ' + s.run + ' | ' + (a && a.interval ? fmt(a.interval.median) + ' / ' + fmt(a.interval.p95) + ' / ' + fmt(a.interval.max) : '—') +
      ' | ' + fmt(a && a.seqGaps, 0) + ' | ' + fmt(a && a.smoothOff, 0) +
      ' | ' + (m ? fmt(m.stillPct) + '% (' + fmt(m.waitingStillPct) + '%)' : '—') +
      ' | ' + (m ? fmt(m.targetJumpMean, 2) + ' / ' + fmt(m.targetJumpMax, 2) : '—') +
      ' | ' + (ht ? fmt(ht.median, 2) + ' / ' + fmt(ht.p95, 2) + ' / ' + fmt(ht.max, 2) : '—') +
      ' | ' + (hs ? fmt(hs.median, 3) + ' / ' + fmt(hs.p95, 3) + ' / ' + fmt(hs.max, 3) : '—') + ' |\n';
  }
  const first = runs[0];
  md += '\nУсловия: сид `' + fmt(first.seed) + '`, карта ' + fmt(first.size) + ', игроков ' + fmt(first.players) +
    ', headless=' + first.headless + ', окно ' + (first.sameWindow ? 'одно (вкладки)' : 'два') +
    ', Chrome ' + fmt(first.chrome) + '.\n';
}
fs.writeFileSync(path.join(DIR, 'summary.md'), md);
fs.writeFileSync(path.join(DIR, 'summary.json'), JSON.stringify(all, null, 2));
console.log(md);
console.log('записано: ' + path.join(DIR, 'summary.md'));
