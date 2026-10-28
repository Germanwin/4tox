/* pending.js — ожидающие действия сетевого клиента (UX-01).

   Зачем отдельный слой. Действие гостя выполняет БРАУЗЕР ХОСТА, а гость видит
   только следующий снимок. Раньше `placeBuild` отправлял команду и сразу
   стирал призрак: кадр «призрак → пусто → авторитетный дом» — и есть та
   жалоба, что дом у гостя исчезает. Сеть лишь делала дырку заметнее; дефект
   был клиентский.

   Здесь живёт ОТОБРАЖЕНИЕ ожидания, а не вторая симуляция:

   * ожидающая постройка сразу стоит там, куда её поставили, и не исчезает до
     авторитетного появления или явного отказа;
   * в мир она НЕ входит: `state.buildings`, симуляция, работники и истинная
     проходимость о ней не знают. При выборе новых мест она учитывается
     отдельным списком (`buildings()` — в canPlace);
   * у действия есть `commandId` (номер команды), созданный ДО отправки;
   * согласование — по id из результата хоста, а если результат ещё не пришёл —
     по версии снимка и точному совпадению типа/поворота/владельца/пятна среди
     ПОЯВИВШИХСЯ построек. Одних координат недостаточно: они же бывают у
     старого дома на том же месте;
   * старый снимок (seq <= отправки) ожидание не стирает;
   * applied раньше снимка и снимок раньше applied — оба порядка допустимы;
   * применённая, но уже снесённая постройка завершает ожидание по версии
     применения (иначе ждали бы исчезнувший id вечно);
   * отказ/просрочка снимают ожидание и возвращают резерв; сетевой таймаут —
     статус `unknown` («результат уточняется»), а не отказ: команду не
     повторяем и второй дом не создаём;
   * казна: `available = казна снимка − резерв ожидающих`. Подтверждение
     освобождает резерв ровно один раз — деньги уже списаны в мире, второй раз
     их не вычитаем.

   Модуль ничего не решает о мире: только помнит ожидание, считает резерв и
   сопоставляет его с результатом/снимком. Правила мира остаются в движке. */
(function (global) {
  'use strict';

  var LIMIT = 60;               // больше этого ожиданий не держим
  var HISTORY = 120;            // ограниченный след для диагностики
  /* Сроки, после которых ожидание перестаёт держать резерв. Без них
     потерянный result + уже видимый дом оставляли резерв навсегда; 60 таких
     ожиданий — и новые дома молча не ставились. */
  var VISUAL_SETTLE_MS = 10000;
  var UNKNOWN_TIMEOUT_MS = 30000;
  var list = [];
  var seq = 0;
  var owner = 0;
  var seenIds = Object.create(null);
  var lastSnapSeq = 0;
  var history = [];

  function nowMs() {
    return (global.performance && global.performance.now)
      ? global.performance.now() : Date.now();
  }

  function trace(rec) {
    rec.t = nowMs();
    history.push(rec);
    if (history.length > HISTORY) history.shift();
  }

  function reset(o) {
    list.length = 0;
    seq = 0;
    owner = o || 0;
    seenIds = Object.create(null);
    lastSnapSeq = 0;
    history.length = 0;
  }

  function find(commandId) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].commandId === commandId) return list[i];
    }
    return null;
  }

  function trim() {
    while (list.length > LIMIT) list.shift();
  }

  /* Постройка для отображения. Обычная постройка движка (тот же атлас, пятно и
     поворот), только с id ожидания и признаком pending. В мир её не кладут. */
  function madeOf(spec, act, i) {
    var B = global.Buildings;
    if (!B || !B.make) return null;
    var b = B.make({
      type: spec.type, variant: spec.variant || 'a', rot: spec.rot || 0,
      x: spec.x, y: spec.y, owner: act.owner, town: act.owner,
      id: 'pend:' + act.id + ':' + i
    });
    if (b) {
      b.pending = true;
      b._pendingFor = act.commandId;
      b._pendingAt = act.at;
    }
    return b;
  }

  function add(kind, o) {
    o = o || {};
    /* Потолок 60 — это запрет НОВОГО действия, а не вытеснение старого.
       trim(), который сдвигал list[0], мог выбросить ещё не согласованную
       операцию и молча освободить её резерв. */
    if (list.length >= LIMIT) {
      trace({ kind: 'pending-limit', action: kind, commandId: o.commandId });
      return null;
    }
    var act = {
      id: ++seq, kind: kind, commandId: o.commandId, n: o.n,
      owner: o.owner === undefined ? owner : o.owner,
      cost: o.cost || 0,
      label: o.label || '',
      at: nowMs(),
      sentSeq: o.sentSeq || lastSnapSeq,
      status: 'pending', reason: '',
      ids: [], appliedSeq: 0, made: [], items: null,
      campId: o.campId, villagerId: o.villagerId, x: o.x, y: o.y
    };
    if (o.items && o.items.length) {
      act.items = o.items.map(function (it) {
        return { type: it.type, variant: it.variant || 'a', rot: it.rot || 0,
          x: it.x, y: it.y };
      });
      for (var i = 0; i < act.items.length; i++) {
        var mb = madeOf(act.items[i], act, i);
        if (mb) act.made.push(mb);
      }
    } else if (o.spec) {
      act.items = [{
        type: o.spec.type, variant: o.spec.variant || 'a',
        rot: o.spec.rot || 0, x: o.spec.x, y: o.spec.y
      }];
      var one = madeOf(act.items[0], act, 0);
      if (one) act.made.push(one);
    }
    list.push(act);
    trace({ kind: 'add', commandId: act.commandId, action: kind,
      ids: act.made.map(function (b) { return b.id; }), cost: act.cost });
    return act;
  }

  function addBuild(o) { return add('build', o); }
  function addLine(o) { return add('line', o); }
  function addMark(kind, o) { return add(kind || 'mark', o); }

  /* Постройки ожидания — для отрисовки и для проверки места. */
  function buildings() {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      /* Визуально согласованное уже нарисовано авторитетным объектом: второй
         (призрачный) дом в той же клетке не рисуем. Резерв при этом ещё
         держится до точного результата — resourceSettled и visualSettled
         разные вещи. */
      if (list[i].visualSettled) continue;
      for (var j = 0; j < list[i].made.length; j++) out.push(list[i].made[j]);
    }
    return out;
  }

  /* Сколько брёвен ещё не отражено снимком. Резерв отдельный от казны:
     available = villageLogs() − reserved(). Подтверждение/отказ освобождают
     его РОВНО один раз. */
  function reserved(o) {
    var who = o === undefined ? owner : o, sum = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || a.owner !== who) continue;
      if (a.kind !== 'build' && a.kind !== 'line') continue;
      sum += a.cost || 0;
    }
    return sum;
  }

  function finish(act, how, snapSeq, ids) {
    var idx = list.indexOf(act);
    if (idx >= 0) list.splice(idx, 1);
    trace({ kind: 'reconciled', commandId: act.commandId, how: how,
      snapSeq: snapSeq || 0,
      ids: ids || act.ids || act.made.map(function (b) { return b.id; }) });
  }

  function drop(act, how, reason) {
    var idx = list.indexOf(act);
    if (idx >= 0) list.splice(idx, 1);
    trace({ kind: 'dropped', commandId: act.commandId, how: how,
      reason: reason || '' });
  }

  /* Точное совпадение ожидаемой постройки с авторитетной: владелец, тип,
     поворот и клетка. Координаты — только ОДНО из полей, не единственное. */
  function sameSpec(b, it) {
    var B = global.Buildings;
    if (!b || !it) return false;
    /* Владелец сверяется с действием в reconcile: в item его нет намеренно —
       ожидание принадлежит одной деревне. */
    if (B && B.typeOf && B.typeOf(b) !== it.type) return false;
    if ((b.rot || 0) !== (it.rot || 0)) return false;
    if (Math.floor(b.x) !== Math.floor(it.x) ||
        Math.floor(b.y) !== Math.floor(it.y)) return false;
    return true;
  }

  /* Результат команды с хоста. res: {state|status, reason, ids|buildingIds,
     appliedSeq|seq}. Зовётся из game/js/play.js (sendCommand). */
  function result(commandId, res) {
    if (commandId === undefined || commandId === null) return null;
    var act = find(commandId);
    if (!act) {
      trace({ kind: 'late-result', commandId: commandId,
        state: (res && (res.state || res.status)) || '?' });
      return null;
    }
    var state = (res && (res.state || res.status)) || 'unknown';
    act.reason = (res && res.reason) || '';
    if (state === 'applied') {
      act.status = 'applied';
      act.ids = (res.ids || res.buildingIds || []).slice();
      act.appliedSeq = res.appliedRevision || res.appliedSeq || res.seq || 0;
      act.reasonCode = res.reasonCode || null;
      trace({ kind: 'applied', commandId: commandId, ids: act.ids,
        appliedSeq: act.appliedSeq });
      if (!act.ids.length && (act.kind === 'order' || act.kind === 'hire' ||
          act.kind === 'train' || act.kind === 'fire')) {
        /* У этих действий нет объекта мира, который надо ждать: результат и
           есть подтверждение. */
        drop(act, 'applied-mark', '');
      }
      return act;
    }
    if (state === 'rejected' || state === 'expired') {
      act.status = state;
      trace({ kind: 'refused', commandId: commandId, state: state,
        reason: act.reason });
      drop(act, state, act.reason);
      return act;
    }
    /* unknown / pending / timeout: ожидание ОСТАЁТСЯ, команду не повторяем. */
    act.status = 'unknown';
    trace({ kind: 'unknown', commandId: commandId, reason: act.reason });
    return act;
  }

  /* Свежий снимок. Применение идёт ОДНИМ проходом: у каждого ожидания ровно
     один исход в этом кадре. */
  function reconcile(snap) {
    if (!snap) return 0;
    var snapSeq = snap.seq || 0;
    if (snapSeq) lastSnapSeq = Math.max(lastSnapSeq, snapSeq);
    var blds = snap.buildings || [];
    var present = Object.create(null), i, j, b;
    for (i = 0; i < blds.length; i++) {
      b = blds[i];
      if (b && b.id !== undefined) present[b.id] = 1;
    }
    var done = 0;
    for (i = list.length - 1; i >= 0; i--) {
      var act = list[i];
      if (!act) continue;
      if (!snapSeq || snapSeq <= act.sentSeq) continue;   // старый снимок
      /* Поиск, найм, обучение и приказ не имеют объекта, который надо ждать
         в снимке: их подтверждение — ТОЧНЫЙ результат, а не число снимков.
         Никакого «два снимка спустя» здесь больше нет: потерянный результат
         остаётся unknown и уточняется через command-state. */
      if (act.kind !== 'build' && act.kind !== 'line') continue;

      /* 1. Результат уже назвал id — сверяем по id. Это главный путь. */
      if (act.ids && act.ids.length) {
        var all = true;
        for (j = 0; j < act.ids.length; j++) if (!present[act.ids[j]]) { all = false; break; }
        if (all) { finish(act, 'ids-visible', snapSeq); done++; continue; }
        /* Применено, но в снимке ПОЗЖЕ версии применения id нет: постройку
           успели снести. Ждать исчезнувший id вечно нельзя. Два шага запаса —
           чтобы не принять за снос ещё не доехавший снимок. */
        if (act.appliedSeq && snapSeq > act.appliedSeq + 2) {
          finish(act, 'applied-then-gone', snapSeq); done++;
        }
        continue;
      }

      /* 2. Снимок пришёл раньше результата. Ищем РОВНО те постройки, которых
         не было в прошлом снимке. Это только ВИЗУАЛЬНОЕ согласование: резерв
         не снимаем и ожидание не закрываем, пока не пришёл точный результат.
         Иначе поздний rejected не отменил бы уже «согласованное» действие. */
      var cand = [];
      for (j = 0; j < blds.length; j++) {
        b = blds[j];
        if (!b || b.id === undefined || seenIds[b.id]) continue;
        if ((b.owner === undefined ? 0 : b.owner) !== act.owner) continue;
        for (var k = 0; k < act.items.length; k++) {
          if (sameSpec(b, act.items[k])) { cand.push(b); break; }
        }
      }
      if (!audit(act, cand, blds)) continue;
      if (cand.length === act.items.length) {
        act.visualSettled = true;
        act.visualIds = cand.map(function (x) { return x.id; });
        trace({ kind: 'visual-settled', commandId: act.commandId,
          ids: act.visualIds, snapSeq: snapSeq });
      }
      /* Часть серии уже видна, а результата нет — ждём: серия атомарна. */
    }
    /* Запоминаем состав снимка: следующий «новый» считается от него. */
    seenIds = Object.create(null);
    for (i = 0; i < blds.length; i++) if (blds[i] && blds[i].id !== undefined) seenIds[blds[i].id] = 1;

    /* Потерянный result не должен держать резерв вечно. Если постройка уже
       видна в снимке, мир её принял; если результата нет 30 с и объекта нет —
       команда потерялась. В обоих случаях снимаем ожидание, иначе казна
       навсегда меньше на цену, а 60-е ожидание блокирует новые действия. */
    var now = nowMs();
    for (i = list.length - 1; i >= 0; i--) {
      var old = list[i];
      if (!old) continue;
      var age = now - old.at;
      if (old.visualSettled && age > VISUAL_SETTLE_MS) {
        finish(old, 'visual-timeout', snapSeq);
        done++;
      } else if (old.status === 'unknown' && age > UNKNOWN_TIMEOUT_MS) {
        drop(old, 'unknown-timeout', 'результат не пришёл');
      }
    }
    return done;
  }

  /* Кандидаты должны быть уникальны и не принадлежать другому ожиданию. */
  function audit(act, cand, blds) {
    if (!cand.length || cand.length !== act.items.length) return false;
    var used = Object.create(null), i, j;
    for (i = 0; i < cand.length; i++) {
      if (used[cand[i].id]) return false;
      used[cand[i].id] = 1;
    }
    for (i = 0; i < list.length; i++) {
      var other = list[i];
      if (!other || other === act) continue;
      for (j = 0; j < cand.length; j++) {
        if (other.ids && other.ids.indexOf(cand[j].id) >= 0) return false;
      }
    }
    return true;
  }

  function status() {
    var unresolved = 0, oldest = 0, now = nowMs();
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'unknown') unresolved++;
      var age = now - list[i].at;
      if (age > oldest) oldest = age;
    }
    return { count: list.length, unresolved: unresolved,
      oldestMs: oldest, reserved: reserved(owner),
      lastSnapSeq: lastSnapSeq };
  }

  /* Ожидания, о которых нужно спросить сервер (результат не пришёл). */
  function unresolved() {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'unknown' && list[i].n !== undefined) out.push(list[i]);
    }
    return out;
  }

  /* Сколько ожиданий такого вида уже отправлено (и, если задан campId,
     только для этой постройки). По нему HUD не отправляет лишний найм в
     занятые места: снимок ещё не знает о наших командах (UX-01). */
  function pendingCount(kind, campId) {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      if (kind && a.kind !== kind) continue;
      if (campId !== undefined && a.campId !== campId) continue;
      n++;
    }
    return n;
  }

  function hasPendingFor(o) {
    o = o || {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      if (o.villagerId !== undefined && a.villagerId === o.villagerId) return true;
      if (o.campId !== undefined && a.campId === o.campId) return true;
    }
    return false;
  }

  function pendingAt(cell) {
    if (!cell) return null;
    var B = global.Buildings;
    var blds = buildings();
    for (var i = 0; i < blds.length; i++) {
      if (B && B.cells) {
        var cells = B.cells(blds[i]);
        for (var j = 0; j < cells.length; j++) {
          if (cells[j].x === cell.x && cells[j].y === cell.y) return blds[i];
        }
      }
    }
    return null;
  }

  function exportState() {
    return {
      count: list.length,
      reserved: reserved(owner),
      lastSnapSeq: lastSnapSeq,
      actions: list.map(function (a) {
        return { kind: a.kind, commandId: a.commandId, status: a.status,
          reason: a.reason, ids: a.ids.slice(), appliedSeq: a.appliedSeq,
          ageMs: Math.round(nowMs() - a.at) };
      }),
      history: history.slice(-HISTORY)
    };
  }

  global.Pending = {
    reset: reset,
    addBuild: addBuild,
    addLine: addLine,
    addMark: addMark,
    result: result,
    reconcile: reconcile,
    buildings: buildings,
    reserved: reserved,
    status: status,
    unresolved: unresolved,
    hasPendingFor: hasPendingFor,
    pendingCount: pendingCount,
    pendingAt: pendingAt,
    exportState: exportState,
    list: function () { return list.slice(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
