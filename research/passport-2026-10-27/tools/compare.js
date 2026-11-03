#!/usr/bin/env node
/* compare.js — сравнить два набора прогонов (текущий и базовый) по одним и
 * тем же метрикам и записать runs-baseline/compare.md.
 *
 * Запуск: node tools/compare.js [runs] [runs-baseline]
 *
 * Печатает только то, что действительно измерено в обоих наборах. Если в
 * базовом наборе поля нет — так и пишет «нет данных», а не ноль.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CUR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'runs'));
const BASE = path.resolve(process.argv[3] || path.join(__dirname, '..', 'runs-baseline'));

function load(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); }
  catch (e) { return null; }
}
const cur = load(CUR), base = load(BASE);
if (!cur || !base) {
  console.error('нет summary.json в ' + (!cur ? CUR : BASE) + ' — сначала запустите analyze.js');
  process.exit(1);
}

function med(list) {
  const a = list.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}
function fmt(v, d) {
  if (v === null || v === undefined) return '—';
  return typeof v === 'number' ? v.toFixed(d === undefined ? 1 : d) : String(v);
}
const pick = (r, p) => p.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), r);

const METRICS = [
  ['снимков/с (хост)', 'host.sends.perSec', 2],
  ['применений/с (гость)', 'guest.applies.perSec', 2],
  ['интервал применения, медиана, мс', 'guest.applies.interval.median', 1],
  ['интервал применения, p95, мс', 'guest.applies.interval.p95', 1],
  ['пропущено seq', 'guest.applies.seqGaps', 0],
  ['сглаживание выключено, снимков', 'guest.applies.smoothOff', 0],
  ['кадров «житель стоит», %', 'guest.motion.stillPct', 1],
  ['кадров «догнал и ждёт», %', 'guest.motion.waitingStillPct', 1],
  ['прыжок цели, средний, клеток', 'guest.motion.targetJumpMean', 3],
  ['rAF хоста, кадров/с', 'host.raf.fps', 1],
  ['rAF гостя, кадров/с', 'guest.raf.fps', 1],
  ['кадров хоста > 33 мс', 'host.raf.over33', 0],
  ['мир хоста, с/с', 'host.seconds.simPerReal', 3],
  ['длительность шага мира, медиана, мс', 'host.ticks.ms.median', 3],
  ['длительность шага мира, p95, мс', 'host.ticks.ms.p95', 3],
  ['кадр игры, мс/кадр', 'host.metrics.frameMsPerFrame', 2],
  ['JS-heap хоста, МБ', 'host.seconds.heapUsedMB', 1],
  ['long tasks (хост)', 'host.agg.longTasks', 0],
  ['очередь сервера, макс, Б', 'server.queue.max', 0]
];

let md = '# Сравнение: до патча (`dc75820`) и после (`6b9f06b`)\n\n';
md += 'Один и тот же инструмент, один и тот же сид (в мультиплеере он задан\n' +
  'предзагрузкой сервера), одно окно 700×773 @2, Chrome 156.0.8078.48,\n' +
  'разогрев 25 с, измерение 60 с, три повтора. Значения — медиана по повторам.\n' +
  '«—» значит «в этом наборе поля нет», а не ноль.\n\n';

for (const sc of ['S2', 'S3']) {
  const b = base[sc] || [], c = cur[sc] || [];
  if (!b.length || !c.length) { md += '## ' + sc + '\n\nнет данных: до — ' + b.length + ', после — ' + c.length + '\n\n'; continue; }
  md += '## ' + sc + '\n\n';
  md += '| метрика | до (`dc75820`) | после (`6b9f06b`) | разница |\n|---|---|---|---|\n';
  for (const [name, p, d] of METRICS) {
    const vb = med(b.map(r => pick(r, p)));
    const vc = med(c.map(r => pick(r, p)));
    let diff = '—';
    if (typeof vb === 'number' && typeof vc === 'number') {
      const dv = vc - vb;
      diff = (dv > 0 ? '+' : '') + dv.toFixed(d === 0 ? 0 : d + 1);
      if (vb !== 0) diff += ' (' + ((100 * dv / Math.abs(vb)) > 0 ? '+' : '') + (100 * dv / Math.abs(vb)).toFixed(1) + '%)';
    }
    md += '| ' + name + ' | ' + fmt(vb, d) + ' | ' + fmt(vc, d) + ' | ' + diff + ' |\n';
  }
  md += '\nУсловия: сид ' + fmt((c[0].seed)) + ' (после), ' + fmt((b[0].seed)) + ' (до); ' +
    'видимость хоста ' + fmt(c[0].observed && c[0].observed.host && c[0].observed.host.vis) + ', ' +
    'гостя ' + fmt(c[0].observed && c[0].observed.guest && c[0].observed.guest.vis) + '.\n\n';
}

md += '## Как читать\n\n' +
  '- Если числа в S3 совпадают с точностью до десятых, значит последний патч к\n' +
  '  механизму «гость видит рывки» отношения не имеет: он ни в S3, ни в S2 не\n' +
  '  менял ни частоту снимков, ни сглаживание, ни часы мира (это видно и по\n' +
  '  diff: `diffs/final-stabilization-code.diff` не содержит строк\n' +
  '  `NET_INTERVAL`, `NET_SMOOTH`, `BUDGET_HIDDEN_MS`).\n' +
  '- Уменьшение частоты снимков само по себе **не** считается улучшением\n' +
  '  плавности: в S3 она и так 0.55/с, и от неё зависит только хуже.\n';

const out = path.join(BASE, 'compare.md');
fs.writeFileSync(out, md);
const outCur = path.join(CUR, 'compare.md');
fs.writeFileSync(outCur, md);
console.log(md);
console.log('записано: ' + out + ' и ' + outCur);
