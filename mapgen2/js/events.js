/* events.js — журнал событий мира: атака, разрушение, остановка роста.

   Зачем отдельный модуль. Игрок не понимает, атакуют ли его и что остановило
   экономику (наблюдение 11 задания). Всплывашка на каждый удар — это шум и
   потеря самого события; журнал — это короткая память, в которую смотрят
   ПОСЛЕ того, как что-то пошло не так.

   Здесь только ПРАВИЛА событий: что считается событием, как повтор
   складывается в счётчик, сколько событий помнить. Кто и когда показывает —
   HUD (журнал, метка на мини-карте), а не движок.

   Событие адресуется ВЛАДЕЛЬЦУ: у чужих деревень свой журнал. Это важно в
   сети: клиент видит только свои события, а не «кто на кого напал».

   Атака НЕ создаётся на удар. Первое реальное попадание по своему объекту
   создаёт одно событие, следующие удары того же владельца в течение
   ATTACK_GAP секунд только увеличивают счётчик у него же. Так «на деревню
   напали» не превращается в поток.

   Клиент сети не считает мир, поэтому события атаки/разрушения он выводит из
   СВОИХ дельт снимка (hp уменьшился, постройка стала завалом) и кладёт их
   сюда же — правила одинаковые, источник разный (game/js/play.js). */
(function (global) {
  'use strict';

  var MAX = 40;              // сколько событий помнит журнал
  var ATTACK_GAP = 8;        // с: чаще этого атака одного владельца не пишется
  var GROWTH_GAP = 30;       // с: «рост остановлен» не чаще раза в полминуты

  function init(world) {
    world.events = [];
    world._evSeq = 0;
    world._evAgg = {};
    return world.events;
  }

  function list(world) {
    if (!world) return [];
    if (!world.events) init(world);
    return world.events;
  }

  function push(world, ev) {
    if (!world || !ev) return null;
    var arr = list(world);
    ev.t = world.time || 0;
    ev.id = ++world._evSeq;
    if (ev.owner === undefined) ev.owner = 0;
    if (ev.x === undefined) ev.x = null;
    if (ev.y === undefined) ev.y = null;
    arr.push(ev);
    if (arr.length > MAX) arr.splice(0, arr.length - MAX);
    return ev;
  }

  /* Одно событие на владельца не чаще gap секунд. Повтор не теряется: у
     последнего события растёт count, а координаты обновляются на свежие —
     «напали ещё раз вот здесь». */
  function throttled(world, kind, owner, text, gap, extra) {
    if (!world) return null;
    var key = kind + ':' + owner;
    var agg = world._evAgg || (world._evAgg = {});
    var now = world.time || 0;
    var last = agg[key];
    if (last && last.ev && now - last.t < (gap || ATTACK_GAP)) {
      last.t = now;
      last.ev.count = (last.ev.count || 1) + 1;
      last.ev.t = now;
      if (extra) {
        if (extra.x !== undefined) last.ev.x = extra.x;
        if (extra.y !== undefined) last.ev.y = extra.y;
        if (extra.text) last.ev.text = extra.text;
      }
      return last.ev;
    }
    var ev = push(world, {
      kind: kind, owner: owner === undefined ? 0 : owner,
      x: extra && extra.x !== undefined ? extra.x : null,
      y: extra && extra.y !== undefined ? extra.y : null,
      text: text || '', count: 1
    });
    agg[key] = { t: now, ev: ev };
    return ev;
  }

  /* «На деревню напали» — по первому реальному урону своему объекту.
     x, y — где ударили: по ним ставится метка на мини-карте и работает
     «к месту атаки». Один владелец — одно событие на ATTACK_GAP секунд. */
  function attack(world, owner, x, y, text) {
    return throttled(world, 'attack', owner,
      text || 'на деревню напали', ATTACK_GAP, { x: x, y: y });
  }

  /* «Рост остановлен» — причина словами. Не чаще GROWTH_GAP секунд на
     владельца: иначе журнал забьётся одной и той же строкой. */
  function growthStop(world, owner, reason) {
    return throttled(world, 'growth-stop', owner,
      reason || 'жители не появляются', GROWTH_GAP, null);
  }

  /* Отказ стройки/приказа/найма. Это ответ на действие игрока, а не событие
     мира: без задержки, потому что игрок ждёт объяснения сейчас. */
  function refuse(world, owner, kind, text, x, y) {
    return push(world, {
      kind: kind || 'build-refused', owner: owner === undefined ? 0 : owner,
      x: x === undefined ? null : x, y: y === undefined ? null : y,
      text: text || 'действие отклонено', count: 1
    });
  }

  /* Последние события. owner задан — только его; n — сколько вернуть. */
  function recent(world, n, owner) {
    var arr = list(world);
    var out = [];
    for (var i = arr.length - 1; i >= 0 && out.length < (n || MAX); i--) {
      var ev = arr[i];
      if (owner !== undefined && ev.owner !== owner) continue;
      out.push(ev);
    }
    return out.reverse();
  }

  /* Сколько событий у владельца новее, чем id. Нужно HUD: он не перерисовывает
     журнал, если новых нет. */
  function sinceId(world, owner, id) {
    var arr = list(world);
    var n = 0;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i].id <= (id || 0)) break;
      if (owner === undefined || arr[i].owner === owner) n++;
    }
    return n;
  }

  global.Events = {
    init: init,
    list: list,
    push: push,
    throttled: throttled,
    attack: attack,
    growthStop: growthStop,
    refuse: refuse,
    recent: recent,
    sinceId: sinceId,
    MAX: MAX,
    ATTACK_GAP: ATTACK_GAP,
    GROWTH_GAP: GROWTH_GAP
  };
})(typeof window !== 'undefined' ? window : globalThis);
