#!/usr/bin/env node
/* overhead.js — сравнить стоимость обвязки по внешним счётчикам Chromium.
 * Читает runs/_overhead/{off,metrics,full}/server-samples.jsonl и пишет
 * runs/_overhead/summary.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'runs', '_overhead'));
function read(mode) {
  const f = path.join(DIR, mode, 'server-samples.jsonl');
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { return null; }
}
function med(a) { a = a.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; }
const modes = ['off', 'metrics', 'full'];
const rows = [];
for (const m of modes) {
  const s = read(m);
  if (!s || s.length < 5) { rows.push({ mode: m, missing: true }); continue; }
  /* TaskDuration — накопленные секунды работы главного потока. Делим прирост
     за окно на число секунд окна: получаем «долю секунды в секунду». */
  const first = s[1] && s[1].perf_host, last = s[s.length - 1].perf_host;
  const t0 = s[1] && s[1].sec, t1 = s[s.length - 1].sec;
  rows.push({
    mode: m, samples: s.length,
    sec: t1 - t0,
    taskPerSec: first && last && (t1 > t0) ? (last.TaskDuration - first.TaskDuration) / (t1 - t0) : null,
    scriptPerSec: first && last && (t1 > t0) ? (last.ScriptDuration - first.ScriptDuration) / (t1 - t0) : null,
    heapMB: last ? Math.round(last.JSHeapUsedSize / 1048576 * 10) / 10 : null,
    frames: med(s.map(x => x.probe && x.probe.host && x.probe.host.steps))
  });
}
let md = '# Стоимость диагностики\n\nОдин и тот же мир (S1, сид `overhead-96`, карта 96), три конфигурации.\n' +
  '`TaskDuration` — счётчик Chromium «сколько секунд главный поток был занят»;\n' +
  'делим прирост за окно на длину окна. Это внешнее число, оно есть и без обвязки.\n\n';
md += '| обвязка | сэмплов | окно, с | главный поток, с/с | скрипты, с/с | JS-heap, МБ |\n|---|---|---|---|---|---|\n';
for (const r of rows) {
  md += '| ' + r.mode + ' | ' + (r.missing ? 'нет данных' : r.samples) + ' | ' +
    (r.missing ? '—' : r.sec) + ' | ' + (r.taskPerSec != null ? r.taskPerSec.toFixed(3) : '—') + ' | ' +
    (r.scriptPerSec != null ? r.scriptPerSec.toFixed(3) : '—') + ' | ' + (r.heapMB != null ? r.heapMB : '—') + ' |\n';
}
md += '\n## Как читать\n\n' +
  '- Разница `full − off` по «главный поток, с/с» — это и есть цена всей обвязки\n' +
  '  (выборка раз в секунду, обёртки, 60 записей в секунду в кольцо).\n' +
  '- Если разница меньше шума (десятые доли процента), так и написано: обвязка\n' +
  '  не меняет того, что измеряет.\n' +
  '- `metrics` показывает отдельно цену счётчиков движка (`Metrics.on`), которые\n' +
  '  в обычной игре выключены.\n';
fs.writeFileSync(path.join(DIR, 'summary.md'), md);
console.log(md);
