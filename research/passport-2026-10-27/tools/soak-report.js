#!/usr/bin/env node
/* soak-report.js — ряд по минутам для длинного прогона.
 *
 * Зачем отдельно: кольца обвязки ограничены (30000 кадров, 2000 снимков), и на
 * 15-минутном прогоне они перезаписываются. Зато секундная выборка хранит
 * НАКОПИТЕЛЬНЫЕ счётчики (`agg.sendCount`, `agg.applyCount`, `agg.ticks`,
 * `Metrics.frames`), по ним и считается темп за каждую минуту — без обрезки.
 *
 * Запуск: node tools/soak-report.js runs/S7/r1
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'runs', 'S7', 'r1'));
const host = JSON.parse(fs.readFileSync(path.join(dir, 'host.json'), 'utf8'));
const guest = JSON.parse(fs.readFileSync(path.join(dir, 'guest.json'), 'utf8'));
const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));

function byMinute(page, fields) {
  const out = [];
  const secs = page.secs || [];
  let prev = null;
  for (const s of secs) {
    if (!prev) { prev = s; continue; }
    if (s.t - prev.t < 55000) continue;   // t — миллисекунды performance.now
    const row = { fromSec: Math.round(prev.t / 1000), toSec: Math.round(s.t / 1000), dt: (s.t - prev.t) / 1000 };
    for (const [name, get] of Object.entries(fields)) {
      const a = get(prev), b = get(s);
      row[name] = (typeof a === 'number' && typeof b === 'number' && row.dt > 0)
        ? (b - a) / row.dt : null;
    }
    row.heapMB = s.mem ? Math.round(s.mem.used / 1048576 * 10) / 10 : null;
    row.heapTotalMB = s.mem ? Math.round(s.mem.total / 1048576 * 10) / 10 : null;
    row.villagers = s.nV; row.buildings = s.nB;
    row.simSec = Math.round(s.simSec * 10) / 10;
    row.netEvery = s.netEvery; row.netQueue = s.netQueue;
    row.visibility = s.vis;
    out.push(row);
    prev = s;
  }
  return out;
}

const hRows = byMinute(host, {
  sends: s => (s.agg && s.agg.sendCount),
  ticks: s => (s.agg && s.agg.ticks),
  drawMs: s => (s.agg && s.agg.drawMs),
  frames: s => (s.m && s.m.frames),
  longTasks: s => (s.agg && s.agg.longTasks)
});
const gRows = byMinute(guest, {
  applies: s => (s.agg && s.agg.applyCount),
  frames: s => (s.m && s.m.frames),
  longTasks: s => (s.agg && s.agg.longTasks)
});

let md = '# 15-минутный сетевой прогон (S7)\n\n';
md += 'Сценарий S2 (два видимых окна, localhost), ' + (sc.measure && sc.measure.actualSec) +
  ' с измерения после ' + sc.warmupSec + ' с разогрева. Сид `' + (sc.start && sc.start.seed) +
  '`, карта ' + (sc.start && sc.start.size) + '.\n\n';
md += 'Числа по минутам считаны по НАКОПИТЕЛЬНЫМ счётчикам (`agg.*`, `Metrics.frames`),\n' +
  'поэтому обрезка колец на них не влияет. `heap` — `performance.memory.usedJSHeapSize`\n' +
  'на конец минуты (до сборки мусора, поэтому это верхняя оценка, а не утечка).\n\n';
md += '| минута | секунд мира | кадры/с | шагов мира/с | снимков/с | применений/с у гостя | draw, мс/с | сеть: every | очередь | жителей | зданий | heap хоста, МБ | heap гостя, МБ | long tasks |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (let i = 0; i < hRows.length; i++) {
  const h = hRows[i], g = gRows[i] || {};
  md += '| ' + (i + 1) + ' | ' + h.simSec + ' | ' + (h.frames != null ? h.frames.toFixed(1) : '—') +
    ' | ' + (h.ticks != null ? h.ticks.toFixed(1) : '—') + ' | ' + (h.sends != null ? h.sends.toFixed(1) : '—') +
    ' | ' + (g.applies != null ? g.applies.toFixed(1) : '—') +
    ' | ' + (h.drawMs != null ? h.drawMs.toFixed(0) : '—') +
    ' | ' + h.netEvery + ' | ' + h.netQueue +
    ' | ' + h.villagers + ' | ' + h.buildings +
    ' | ' + (h.heapMB != null ? h.heapMB : '—') + ' | ' + (g.heapMB != null ? g.heapMB : '—') +
    ' | ' + (h.longTasks != null ? h.longTasks.toFixed(1) : '—') + ' |\n';
}
const first = hRows[0], last = hRows[hRows.length - 1];
md += '\n## Итог\n\n';
md += '- Темп снимков за первую минуту ' + (first && first.sends != null ? first.sends.toFixed(2) : '—') +
  '/с, за последнюю ' + (last && last.sends != null ? last.sends.toFixed(2) : '—') + '/с.\n';
md += '- Кадры: ' + (first && first.frames != null ? first.frames.toFixed(1) : '—') + ' → ' +
  (last && last.frames != null ? last.frames.toFixed(1) : '—') + ' в секунду.\n';
md += '- Heap хоста: ' + (hRows[0] && hRows[0].heapMB) + ' МБ → ' + (last && last.heapMB) + ' МБ ' +
  '(форма ряда в таблице: ровный рост без сборки или пила).\n';
md += '- Жителей: ' + (first && first.villagers) + ' → ' + (last && last.villagers) + ' (рождение по 30 с — это рост мира, а не утечка).\n';
fs.writeFileSync(path.join(dir, '..', 'summary.md'), md);
console.log(md);
