/* run-scenario.js — внешний runner: он, а не вкладка, держит границы окна.

   D01: счётчики начала и конца обязаны быть у внешнего процесса. Если
   страница/вкладка перестала исполняться, runner всё равно знает время окна
   и может сказать «покрытие 50 %, хвост 30 с», а не выдать среднее по
   активному участку за весь прогон.

   Два режима:
     node run-scenario.js --input run.json [--out summary.json]
       — пересчитать уже снятый сырой run (исторический S3 и т.п.);
     node run-scenario.js --url https://host --code ROOM --token T
                          --seconds 180 --out run.json [--interval 100]
       — поллить /api/ping и /api/status, снимая committed tick и revision
         комнаты. Это серверная часть E2E; браузерные метрики сюда не
         подменяются.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { computeWindow } = require('./analyze');

function help() {
  console.log('usage:');
  console.log('  node run-scenario.js --input run.json [--out summary.json]');
  console.log('  node run-scenario.js --url http://host --code ROOM --token T --seconds 180 --out run.json');
  console.log('options: --interval 100 --warmup 30');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

async function pollServer(args) {
  const base = String(args.url || '').replace(/\/$/, '');
  const code = String(args.code || '');
  const token = String(args.token || '');
  const seconds = Math.max(1, Number(args.seconds) || 180);
  const warmup = Math.max(0, Number(args.warmup) || 0);
  const interval = Math.max(20, Number(args.interval) || 100);
  if (!base || !code || !token) throw new Error('url_code_token_required');
  const samples = [];
  const t0 = Date.now();
  let startSnapshotCount = null, endSnapshotCount = null;
  let startCommittedTick = null, endCommittedTick = null;
  let measureStart = null, measureEnd = null;
  while (true) {
    const now = Date.now();
    const elapsed = (now - t0) / 1000;
    if (elapsed > warmup + seconds) break;
    const url = base + '/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token) + '&c0=' + now;
    let json = null;
    try {
      const r = await fetch(url);
      json = await r.json();
    } catch (e) { json = null; }
    const t = now - t0;
    if (elapsed >= warmup) {
      if (measureStart === null) {
        measureStart = t;
        startSnapshotCount = json && json.revision !== undefined ? json.revision : 0;
        startCommittedTick = json && json.tick !== undefined ? json.tick : 0;
      }
      measureEnd = t;
      endSnapshotCount = json && json.revision !== undefined ? json.revision : endSnapshotCount;
      endCommittedTick = json && json.tick !== undefined ? json.tick : endCommittedTick;
      samples.push({
        t: t,
        tick: json && json.tick !== undefined ? json.tick : null,
        snapshots: json && json.revision !== undefined ? json.revision : null,
        roomStatus: json ? json.roomStatus : null,
        serverMonoMs: json ? json.serverSendAtMs : null
      });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return {
    kind: 'server-clock-window',
    measureStart: measureStart,
    measureEnd: measureEnd,
    startSnapshotCount: startSnapshotCount,
    endSnapshotCount: endSnapshotCount,
    startCommittedTick: startCommittedTick,
    endCommittedTick: endCommittedTick,
    samples: samples,
    retained: samples.length,
    totalEvents: samples.length,
    ringWrapped: false
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return 0; }
  let run;
  if (args.input) {
    run = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  } else if (args.url) {
    run = await pollServer(args);
  } else {
    help();
    return 2;
  }
  const summary = computeWindow(run);
  const text = JSON.stringify({ run: run, summary: summary }, null, 2);
  if (args.out) {
    const out = path.resolve(args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text + '\n');
    console.log('written ' + out);
  } else {
    console.log(text);
  }
  if (summary.incomplete || summary.notReconstructable) return 1;
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(String(e && e.message || e));
    process.exitCode = 2;
  });
}

module.exports = { pollServer: pollServer, parseArgs: parseArgs };
