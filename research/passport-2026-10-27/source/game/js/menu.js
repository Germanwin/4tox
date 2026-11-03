/* menu.js — главное меню: выбор острова, сид и кнопка «Играть».

   Меню стоит поверх живого острова (js/play.js, режим «диорама»), поэтому
   здесь нет ни фона, ни картинок: фон рисует движок игры.

   Две вещи, которые сделаны намеренно:

   1. КАРТОЧКА РАЗМЕРА ПОКАЗЫВАЕТ НАСТОЯЩИЙ ОСТРОВ. Миниатюра — не рисунок и
      не иконка: это сгенерированный мир того самого размера, нарисованный
      схемой (Play.paintThumbnail). Сид превью постоянный, иначе выбор размера
      превращался бы в лотерею: сегодня карточка красивая, завтра — клякса.

   2. ПРЕВЬЮ СЧИТАЮТСЯ ПО ОДНОМУ И НЕ СРАЗУ. Мир на 128 клеток генерируется
      заметно дольше, чем на 48, а меню обязано открыться мгновенно. Поэтому
      карточки рисуются по очереди, в промежутках между кадрами. */

(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Постоянные сиды превью — по одному на размер. 160 в карточках нет, но
     размер поддержан движком и SIZES: сид держим и для него, чтобы режимы,
     которые спросят 160, получали тот же остров, что и остальные размеры. */
  var PREVIEW_SEED = {
    48: 'тихая-долина-101',
    64: 'зелёная-пойма-202',
    96: 'каменная-грива-303',
    128: 'вольная-согра-404',
    160: 'широкая-пойма-505',
    192: 'дальний-плёс-606',
    256: 'великий-берег-707'
  };

  // 48 остаётся скрытой карточкой для тестов; 160 поддержан движком, но
  // карточки в меню нет — игрок выбирает 64/96/128/192/256.
  var SIZES = [48, 64, 96, 128, 192, 256];

  /* Превью не крупнее 128: форма острова масштабно-инвариантна (частоты шума
     считаются от размера), а генерация 256 — это сотни миллисекунд, которых
     меню не должно ждать ради картинки 132 × 100. Сид превью при этом
     настоящий, размер — уменьшенный. */
  var PREVIEW_MAX = 128;

  var el = {};
  var actions = {};
  var selected = 64;
  var selectedMode = 'solo';       // solo | bot | mp
  var drawn = {};
  var queue = [];

  function init(bind) {
    actions = bind || {};

    el.menu = $('menu');
    el.sizes = $('sizes');
    el.modes = $('modes');
    el.seed = $('seed');
    el.play = $('btnPlay');

    if (el.modes) {
      el.modes.addEventListener('click', function (e) {
        var card = e.target && e.target.closest ? e.target.closest('[data-mode]') : null;
        if (card) selectMode(card.dataset.mode);
      });
    }

    el.sizes.addEventListener('click', function (e) {
      var card = e.target && e.target.closest ? e.target.closest('[data-size]') : null;
      if (card) select(parseInt(card.dataset.size, 10));
    });

    // Стрелки переводят выбор на соседнюю карточку: список размеров — это
    // выбор из семи (пять карточек и два служебных размера), и мышью тыкать
    // в него необязательно.
    el.sizes.addEventListener('keydown', function (e) {
      var i = SIZES.indexOf(selected);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { select(SIZES[Math.min(SIZES.length - 1, i + 1)]); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { select(SIZES[Math.max(0, i - 1)]); e.preventDefault(); }
    });

    $('dice').addEventListener('click', function () { rollSeed(); });
    el.seed.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') start();
    });
    el.play.addEventListener('click', start);

    /* Клавиши меню: R — другой сид, Enter — играть. Клавиши партии (H, C, V,
       N) живут в js/play.js и в меню молчат: там нечего искать и некем
       следить. */
    global.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (global.Keys ? global.Keys.typing(e)
          : (e.target && /input|select|textarea/i.test(e.target.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      /* Имя клавиши — по физическому месту (mapgen2/js/keys.js): на русской
         раскладке `e.key` для R приходит как «к», и другой сид не выпадал. */
      var k = global.Keys ? global.Keys.name(e) : String(e.key || '').toLowerCase();
      if (k === 'r') { rollSeed(); e.preventDefault(); }
      else if (k === 'enter') { start(); e.preventDefault(); }
    });

    select(64);
  }

  function start() {
    if (el.menu.classList.contains('hidden')) return;
    if (selectedMode === 'mp' && actions.mp) { actions.mp(); return; }
    actions.play && actions.play(seed(), selected, { mode: selectedMode });
  }

  function selectMode(mode) {
    if (mode !== 'solo' && mode !== 'bot' && mode !== 'mp') return;
    selectedMode = mode;
    if (el.modes) {
      var cards = el.modes.children;
      for (var i = 0; i < cards.length; i++) {
        var on = cards[i].dataset.mode === mode;
        cards[i].classList.toggle('selected', on);
        cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
  }

  function select(size) {
    if (SIZES.indexOf(size) < 0 || size === selected) {
      // Повторный клик по выбранной карточке — это тоже «играть»: так ведёт
      // себя кнопка, а не радиокнопка, и это привычнее.
      return;
    }
    selected = size;
    var cards = el.sizes.children;
    for (var i = 0; i < cards.length; i++) {
      var on = parseInt(cards[i].dataset.size, 10) === size;
      cards[i].classList.toggle('selected', on);
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function rollSeed() {
    el.seed.value = global.randomSeed();
    el.seed.focus();
    el.seed.select && el.seed.select();
  }

  function seed() {
    var s = (el.seed.value || '').trim();
    return s || global.randomSeed();
  }

  function setSeed(s) { el.seed.value = s; }

  /* ------------------------------ экраны ------------------------------- */

  function show() {
    el.menu.classList.remove('hidden', 'leaving');
    // Анимация входа перезапускается только снятием и возвратом класса:
    // без reflow браузер считает, что класс не менялся.
    el.menu.classList.remove('entering');
    void el.menu.offsetWidth;
    el.menu.classList.add('entering');
    if (!el.seed.value) rollSeed();
    fillPreviews();
  }

  function hide() {
    el.menu.classList.add('hidden');
    el.menu.classList.remove('entering', 'leaving');
  }

  // Уход меню — с анимацией: за ней видно, как остров выходит на первый план.
  function leave(done) {
    el.menu.classList.add('leaving');
    setTimeout(function () {
      el.menu.classList.add('hidden');
      el.menu.classList.remove('leaving', 'entering');
      if (done) done();
    }, 420);
  }

  function isOpen() { return !el.menu.classList.contains('hidden'); }

  /* Прямоугольник пустой колонки, в которую движок ставит остров заставки
     (js/play.js, frameDiorama). Меню раскладывает себя само, и только оно
     знает, сколько места осталось справа; движку остаётся спросить.

     null — колонки нет: узкое окно, доска занимает весь экран, и остров
     встаёт по центру. */
  function artBox() {
    var art = el.menu ? el.menu.querySelector('.menu-art') : null;
    if (!art || !art.offsetParent) return null;      // display: none — не видно
    var r = art.getBoundingClientRect();
    if (r.width < 140) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /* ------------------------------ превью ------------------------------- */

  /* Карточки рисуются по одной, между кадрами: меню открывается сразу, а
     миниатюры досыпаются. Генерация мира на 128 клеток — это не то, что
     стоит делать до первого кадра меню. */
  function fillPreviews() {
    var cards = el.sizes.children;
    queue = [];
    for (var i = 0; i < cards.length; i++) {
      var size = parseInt(cards[i].dataset.size, 10);
      if (drawn[size]) continue;
      queue.push({ size: size, canvas: cards[i].querySelector('canvas') });
    }
    step();
  }

  function step() {
    if (!queue.length) return;
    var job = queue.shift();
    paint(job.size, job.canvas);
    global.setTimeout(step, 24);
  }

  function paint(size, canvas) {
    if (!canvas || drawn[size]) return;
    try {
      var seedText = PREVIEW_SEED[size] || ('превью-' + size);
      var previewSize = Math.min(size, PREVIEW_MAX);
      var world = global.WorldGen.generate({ seed: seedText, size: previewSize });
      global.Play.paintThumbnail(canvas, world);
      drawn[size] = true;
    } catch (e) {
      // Миниатюра — украшение: не получилась, карточка остаётся с морем.
    }
  }

  global.Menu = {
    init: init,
    show: show,
    hide: hide,
    leave: leave,
    isOpen: isOpen,
    artBox: artBox,
    select: select,
    selectMode: selectMode,
    size: function () { return selected; },
    mode: function () { return selectedMode; },
    seed: seed,
    setSeed: setSeed,
    rollSeed: rollSeed,
    start: start
  };
})(typeof window !== 'undefined' ? window : globalThis);
