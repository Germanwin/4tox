/* tree-hits.js — тряска деревьев по ударам из сетевого снимка.

   Сервер считает рубку и шлёт в снимке пары «id дерева + возраст удара».
   Клиент не повторяет правила рубки: он только применяет уже случившийся
   удар к тому же дереву. Возраст нужен, чтобы кадр, приехавший с задержкой,
   начинал затухание не с нуля, а с той же фазы, что у хоста.

   Модуль ничего не решает про игру: нет дерева, оно уже срублено или id
   чужой — удар тихо пропускается. Повторный тот же удар безвреден: время
   удара ставится одно и то же, и затухание не продлевается.

   Индекс id -> дерево пересобирается только когда сменился состав объектов
   (длина и objectRev). Обход тысячи объектов на каждый удар не нужен. */
(function (global) {
  'use strict';

  function index(world) {
    var objs = world.objects || [];
    var rev = world.objectRev || 0;
    var c = world._treeHitIndex;
    if (c && c.n === objs.length && c.rev === rev) return c.map;
    var map = new Map();
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (!o || o.kind !== 'tree' || o.id === undefined || o.removed) continue;
      map.set(String(o.id), o);
    }
    world._treeHitIndex = { n: objs.length, rev: rev, map: map };
    return map;
  }

  /* time — часы отрисовки (renderer.time). Возвращает число применённых
     ударов: это удобно и тесту, и диагностике, на игру оно не влияет. */
  function apply(world, hits, time) {
    if (!world || !hits || !hits.length) return 0;
    var map = index(world);
    var now = Number(time);
    if (!isFinite(now)) now = 0;
    var applied = 0;
    for (var i = 0; i < hits.length; i++) {
      var hit = hits[i];
      if (!hit || hit.id === undefined || hit.id === null) continue;
      var tree = map.get(String(hit.id));
      if (!tree) continue;
      var age = Number(hit.age);
      if (!isFinite(age) || age < 0) age = 0;
      /* Дольше затухания (0.4 с у Renderer.treeShake) удару уже нечего
         показывать; такой кадр опоздал, и дерево не должно дёргаться. */
      if (age > 400) continue;
      tree.shake = 1;
      tree._shakeT = now - age / 1000;
      applied++;
    }
    return applied;
  }

  global.TreeHits = { apply: apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TreeHits;
})(typeof window !== 'undefined' ? window : globalThis);
