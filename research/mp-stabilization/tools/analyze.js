/* analyze.js — честные метрики окна, а не «средние по активному участку».

   D01 старого паспорта: скорость мира считалась между первой и последней
   секундной выборкой. Если источник перестал выдавать выборки за 28 секунд
   до конца окна, эти 28 секунд не входили в знаменатель, и остановившийся
   прогон выглядел здоровым.

   Здесь окно задаётся ТОЛЬКО measureStart/measureEnd. Полная частота —
   дельта интегральных счётчиков / всё окно. Активный участок — отдельное
   поле с явным именем. Покрытие, ведущий/хвостовой/самый длинный разрыв считаются
   с учётом границ окна. retained-записи, все события и ringWrapped — разные
   величины.

   Если конечный счётчик недоступен, это incomplete: показываем нижнюю
   границу и длительность потери наблюдения, а не ноль и не PASS. Если
   кольцо вытеснило начало и интегрального счётчика нет — not_reconstructable.
 */
'use strict';

function num(x) {
  return (typeof x === 'number' && isFinite(x)) ? x : null;
}

function medianGap(samples) {
  if (!samples || samples.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i].t - samples[i - 1].t);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

function computeWindow(input) {
  input = input || {};
  const start = num(input.measureStart);
  const end = num(input.measureEnd);
  if (start === null || end === null || end < start) {
    throw new Error('measure_start_end_required');
  }
  const windowMs = end - start;
  const windowSec = windowMs / 1000;
  const samples = (input.samples || [])
    .map((s) => ({ t: num(s.t), tick: num(s.tick), snapshots: num(s.snapshots) }))
    .filter((s) => s.t !== null && s.t >= start && s.t <= end)
    .sort((a, b) => a.t - b.t);

  const startSnap = num(input.startSnapshotCount);
  const endSnap = num(input.endSnapshotCount);
  const startTick = num(input.startCommittedTick);
  const endTick = num(input.endCommittedTick);
  const haveCounters = startSnap !== null && endSnap !== null &&
    startTick !== null && endTick !== null;
  const incomplete = !haveCounters;
  const ringWrapped = !!input.ringWrapped;
  const ringCapacity = num(input.ringCapacity);
  const retained = num(input.retained);
  const totalEvents = num(input.totalEvents);
  const notReconstructable = !!input.notReconstructable ||
    (ringWrapped && !haveCounters);

  const fullWindow = {
    snapshotHz: haveCounters ? (endSnap - startSnap) / windowSec : null,
    simRate: haveCounters ? (endTick - startTick) * 0.05 / windowSec : null,
    snapshotCountDelta: haveCounters ? endSnap - startSnap : null,
    committedTickDelta: haveCounters ? endTick - startTick : null
  };

  const first = samples.length ? samples[0].t : null;
  const last = samples.length ? samples[samples.length - 1].t : null;
  const leadingGapMs = first === null ? windowMs : Math.max(0, first - start);
  const trailingGapMs = last === null ? windowMs : Math.max(0, end - last);
  let longestGapMs = Math.max(leadingGapMs, trailingGapMs);
  for (let i = 1; i < samples.length; i++) {
    longestGapMs = Math.max(longestGapMs, samples[i].t - samples[i - 1].t);
  }
  const sampleCoverage = windowMs > 0 ? Math.max(0, Math.min(1,
    (last !== null && first !== null ? (last - first) : 0) / windowMs)) : 0;

  const activeStart = first;
  const activeEnd = last;
  const activeMs = activeStart === null ? 0 : Math.max(0, activeEnd - activeStart);
  let activeSnapshotDelta = null, activeTickDelta = null;
  if (samples.length >= 2) {
    const a = samples[0], b = samples[samples.length - 1];
    if (a.snapshots !== null && b.snapshots !== null) activeSnapshotDelta = b.snapshots - a.snapshots;
    if (a.tick !== null && b.tick !== null) activeTickDelta = b.tick - a.tick;
  }
  const activeWindow = {
    label: 'active_window_between_observations',
    startMs: activeStart === null ? null : activeStart - start,
    endMs: activeEnd === null ? null : activeEnd - start,
    ms: activeMs,
    snapshotHz: activeMs > 0 && activeSnapshotDelta !== null
      ? activeSnapshotDelta / (activeMs / 1000) : null,
    simRate: activeMs > 0 && activeTickDelta !== null
      ? activeTickDelta * 0.05 / (activeMs / 1000) : null
  };

  const lowerBound = {
    snapshotHz: haveCounters ? null : (samples.length > 0
      ? (samples[samples.length - 1].snapshots !== null
        ? (samples[samples.length - 1].snapshots - (samples[0].snapshots || 0)) / windowSec
        : null) : 0),
    simRate: haveCounters ? null : (samples.length > 1 && samples[samples.length - 1].tick !== null
      ? (samples[samples.length - 1].tick - samples[0].tick) * 0.05 / windowSec : 0)
  };

  return {
    windowMs: windowMs,
    windowSec: windowSec,
    fullWindow: fullWindow,
    activeWindow: activeWindow,
    sampleCoverage: sampleCoverage,
    leadingGapMs: leadingGapMs,
    trailingGapMs: trailingGapMs,
    longestGapMs: longestGapMs,
    medianSampleGapMs: medianGap(samples),
    retained: retained === null ? samples.length : retained,
    totalEvents: totalEvents === null ? samples.length : totalEvents,
    ringWrapped: ringWrapped,
    ringCapacity: ringCapacity,
    incomplete: incomplete,
    notReconstructable: notReconstructable,
    lowerBound: incomplete ? lowerBound : null,
    samples: samples.length,
    lastObservationAgeMs: trailingGapMs
  };
}

function analyzeRun(run) {
  run = run || {};
  const out = computeWindow({
    measureStart: run.measureStart,
    measureEnd: run.measureEnd,
    startSnapshotCount: run.startSnapshotCount,
    endSnapshotCount: run.endSnapshotCount,
    startCommittedTick: run.startCommittedTick,
    endCommittedTick: run.endCommittedTick,
    samples: run.samples,
    retained: run.retained,
    totalEvents: run.totalEvents,
    ringWrapped: run.ringWrapped,
    ringCapacity: run.ringCapacity,
    notReconstructable: run.notReconstructable
  });
  if (run.host && typeof run.host === 'object') {
    out.delivery = {
      note: 'интервал между применениями — не end-to-end latency',
      applyIntervalsMs: Array.isArray(run.host.applyIntervalsMs) ? run.host.applyIntervalsMs.slice() : null,
      rttMs: num(run.host.rttMs),
      commandTrace: Array.isArray(run.host.commandTrace) ? run.host.commandTrace.slice(0, 200) : null
    };
  }
  return out;
}

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node analyze.js <run.json>');
    process.exit(2);
  }
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = analyzeRun(run);
  console.log(JSON.stringify(out, null, 2));
  if (out.incomplete || out.notReconstructable) process.exit(1);
}

module.exports = { computeWindow: computeWindow, analyzeRun: analyzeRun, medianGap: medianGap };
