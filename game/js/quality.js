/* quality.js — один выбор качества рендера на игру.

   auto: coarse pointer (телефон/планшет) — DPR ≤1.5 и мобильные атласы,
         desktop — DPR ≤2 и обычные.
   low:  DPR 1, мобильные атласы.
   high: DPR ≤2, обычные (не «сколько угодно», иначе 2.07 Мпикс полотна на
         маленьком экране).

   CSS-размеры и координаты ввода не меняются: меняется только внутренняя
   плотность canvas. Выбор хранится в localStorage и применяется до загрузки
   атласов, поэтому desktop+mobile одновременно не грузятся. */
(function (global) {
  'use strict';

  var KEY = '4tox.quality';
  var TIERS = { auto: 1, low: 1, high: 1 };
  var current = 'auto';
  try {
    var saved = global.localStorage && global.localStorage.getItem(KEY);
    if (saved && TIERS[saved]) current = saved;
  } catch (e) { /* приватный режим */ }

  function coarse() {
    try {
      if (global.matchMedia && global.matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) { /* старый браузер */ }
    return !!(global.navigator && global.navigator.maxTouchPoints > 0);
  }

  function dpr() {
    return Math.max(1, Number(global.devicePixelRatio) || 1);
  }

  function dprCap() {
    if (current === 'low') return 1;
    if (current === 'high') return Math.min(dpr(), 2);
    return coarse() ? 1.5 : 2;
  }

  function useMobile() {
    return current === 'low' || (current === 'auto' && coarse());
  }

  function set(tier) {
    if (!TIERS[tier]) return current;
    current = tier;
    try { if (global.localStorage) global.localStorage.setItem(KEY, tier); } catch (e) {}
    return current;
  }

  function snap() {
    return {
      tier: current, coarse: coarse(), mobileAtlases: useMobile(),
      dpr: dpr(), dprCap: dprCap(),
      devicePixelRatio: global.devicePixelRatio || 1
    };
  }

  global.Quality = {
    tier: function () { return current; },
    set: set,
    coarse: coarse,
    dprCap: dprCap,
    useMobile: useMobile,
    snap: snap
  };
})(typeof window !== 'undefined' ? window : globalThis);
