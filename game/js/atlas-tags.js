/* atlas-tags.js — ровно один tier метаданных атласов.

   Desktop и mobile atlas.js различаются координатами кадров и ppu, поэтому
   грузить оба «на всякий случай» нельзя: это и лишний трафик, и два набора
   имён, между которыми легко выбрать не тот. Скрипт выполняется во время
   разбора страницы (после quality.js) и пишет теги выбранного tier.

   Изображения по-прежнему грузятся позже, по meta.atlas; здесь только
   метаданные. Для генератора карт остаётся статический desktop-набор. */
(function () {
  'use strict';
  var mobile = !!(window.Quality && window.Quality.useMobile());
  var assets = [
    'sprites', 'waves', 'villager', 'armored_villager',
    'townhall', 'starter_house', 'lumbercamp', 'barracks', 'warcamp', 'ruins'
  ];
  for (var i = 0; i < assets.length; i++) {
    var src = '../mapgen2/assets/' + assets[i] +
      (mobile ? '/mobile/atlas.js' : '/atlas.js');
    document.write('<script src="' + src + '"><' + '/script>');
  }
})();
