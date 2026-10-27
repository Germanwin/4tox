/* recalc-s3.js — пересчёт исторического S3 по полному окну.

   Старый summary считал скорость между первой и последней секундной
   выборкой и потому не видел 28-секундную тишину в хвосте. Здесь окно —
   только marks measure-start/measure-end; именем файла результат не
   подменяется.

   node recalc-s3.js <runs/S3> [out.json]
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { computeWindow } = require('./analyze');

function recalc(file) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  const marks = {};
  (run.marks || []).forEach((m) => { marks[m.label] = m.t; });
  const start = marks['measure-start'];
  const end = marks['measure-end'];
  if (!isFinite(start) || !isFinite(end)) throw new Error('measure_marks_missing:' + file);
  const sends = (run.sends || []).filter((s) => s[0] >= start && s[0] <= end);
  const secs = (run.secs || []).filter((s) => s.t >= start && s.t <= end);
  const samples = secs.map((s) => ({ t: s.t, tick: Math.round((s.simSec || 0) * 20), snapshots: s.netSeq }));
  const firstSnap = samples.length ? samples[0].snapshots : 0;
  const lastSnap = samples.length ? samples[samples.length - 1].snapshots : 0;
  return computeWindow({
    measureStart: start,
    measureEnd: end,
    startSnapshotCount: 0,
    endSnapshotCount: sends.length,
    startCommittedTick: 0,
    endCommittedTick: samples.length > 1
      ? Math.round((samples[samples.length - 1].tick - samples[0].tick) *
          1) : 0,
    samples: samples,
    retained: secs.length,
    totalEvents: (run.secs || []).length,
    ringWrapped: (run.secs || []).length > secs.length,
    ringCapacity: (run.secs || []).length
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node recalc-s3.js <runs/S3> [out.json]');
    process.exit(2);
  }
  const out = [];
  for (const r of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, r, 'host.json');
    if (!fs.existsSync(f)) continue;
    out.push(Object.assign({ run: r }, recalc(f)));
  }
  const text = JSON.stringify(out, null, 2);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], text + '\n');
  else console.log(text);
}

module.exports = { recalc: recalc };
