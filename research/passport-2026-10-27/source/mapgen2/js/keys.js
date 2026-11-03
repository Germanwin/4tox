/* keys.js — какая клавиша нажата, независимо от раскладки клавиатуры.

   Заказчик (2026-10-24): «ей можно управлять только с мака; друзья на
   Windows не могут редактировать здания, с трудом их ставят и вообще плохо
   управляется; тупо ЛКМ не работает».

   Одна из причин — РАСКЛАДКА. Обе оболочки (игра и генератор) сравнивали
   `KeyboardEvent.key` с латинскими буквами. У игрока с русской раскладкой
   физическая W приходит как «ц», R — как «к», O — как «щ», и молчат сразу
   WASD, поворот постройки, панель войск и остальные буквы. На маке
   разработчика раскладка английская, поэтому там всё работало, а на Windows с
   русской раскладкой — нет.

   Здесь имя клавиши берётся по ФИЗИЧЕСКОМУ МЕСТУ (`KeyboardEvent.code`:
   «KeyW»), а `key` остаётся запасным вариантом для старых браузеров без
   `code`. Для игровых горячих клавиш это правильнее текста: игрок жмёт ту
   кнопку, на которой нарисована W, а не ту, на которой в его раскладке
   написано «ц». Текст (сид острова, имя в лобби) набирается в поле ввода, и
   его `Keys.name` не трогает — см. `Keys.typing`.

   Имя — всегда в нижнем регистре и в «латинском» виде: 'w', 'r', 'o', '=',
   'escape', 'arrowup'. Стрелки, Esc, Enter, Delete, Backspace тоже переводятся
   сюда, чтобы у оболочек не было двух разных языков клавиш.

   Приёмка: game/tools/menu.js — «ц» на месте W двигает камеру, «к» на месте R
   поворачивает постройку; mapgen2/tools/controls.js — то же для стрелок.
*/
(function (global) {
  'use strict';

  var LETTER = /^Key([A-Z])$/;
  var DIGIT = /^(?:Digit|Numpad)([0-9])$/;

  /* Клавиши, у которых `code` не буква и не цифра. Таблица, а не цепочка
     `if`: добавить клавишу — одна строка, и порядок здесь ни при чём. */
  var SPECIAL = {
    Minus: '-', NumpadSubtract: '-',
    Equal: '=', NumpadAdd: '+',
    BracketLeft: '[', BracketRight: ']',
    Backquote: '`',
    Space: ' ',
    Escape: 'escape',
    Enter: 'enter', NumpadEnter: 'enter',
    Tab: 'tab',
    ArrowUp: 'arrowup', ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
    Delete: 'delete', Backspace: 'backspace',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    Semicolon: ';', Quote: "'"
  };

  /* Имя клавиши по физическому месту. `e.key` остаётся запасным вариантом:
     старый браузер без `code`, синтетическое событие, экзотическая
     раскладка — во всех случаях лучше ответить хоть чем-то, чем промолчать. */
  function name(e) {
    if (!e) return '';
    var code = e.code || '';
    var m = LETTER.exec(code);
    if (m) return m[1].toLowerCase();
    m = DIGIT.exec(code);
    if (m) return m[1];
    if (SPECIAL[code]) return SPECIAL[code];
    return String(e.key || '').toLowerCase();
  }

  /* Клавиша пришла в поле ввода: сид набирают, имя в лобби пишут, а не летят
     по карте. Одна проверка на все оболочки — раньше она была скопирована в
     четыре обработчика и в одном месте уже отличалась. */
  function typing(e) {
    var t = e && e.target;
    if (!t) return false;
    var tag = String(t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    return !!t.isContentEditable;
  }

  global.Keys = { name: name, typing: typing };
})(typeof window !== 'undefined' ? window : globalThis);
