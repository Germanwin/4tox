"""Палитра топора: цели эталона и семьи тонов. БЕЗ Blender.

Таблица читается и сборкой модели (axe.py, там Blender), и пост-обработкой
(compose_axe.py, там Pillow) — как wave_shapes.py у волн. Значения сняты
пикселями атласа `mapgen2/assets/sprites/atlas.png`:

  дерево (стволы):  #553321 свет · #452D1C сред · #32200F тень
  валуны:           #787F85 свет · #6C7377 сред · #44484A тень
      (кадр rock_boulder_0: светлых фасетов 28% площади, средних 33%,
       теневых 24%; у камешка и кластера те же тона)
  камень/железо головы: валуны как есть — камень; на ступень темнее и
      холоднее — железо (кованая голова)
  кожа обвязки:     #3A2614 · #2A1B0E · #1C1108 (темнее дерева, холоднее)

Это ЦВЕТА СПРАЙТА, а не материалы: солнце и небо сцены поднимают тон,
поэтому базовые цвета подбирает калибровка (tools/calib_render.py ->
tools/calib_solve.py -> palette_cal.json).
"""

TARGET = dict(
    wood=0x553321,        # ствол, светлый фасет
    wood_mid=0x452D1C,    # ствол, средний фасет
    wood_dark=0x32200F,   # ствол, тёмный фасет / торец комля
    iron=0x6E767C,        # железо, светлый фасет
    iron_mid=0x636B72,    # железо, средний фасет
    iron_dark=0x454B50,   # железо, тёмный фасет
    leather=0x2A1B0E,     # ремень оплётки
    leather_lt=0x3A2614,
    leather_dk=0x1C1108,
)

TARGET_STONE = dict(stone=0x787F85, stone_mid=0x6C7377, stone_dark=0x44484A)

# Семьи: порядок тонов — свет, средний, тень.
FAMILY = dict(
    wood=('wood', 'wood_mid', 'wood_dark'),
    iron=('iron', 'iron_mid', 'iron_dark'),
    stone=('stone', 'stone_mid', 'stone_dark'),
    leather=('leather_lt', 'leather', 'leather_dk'),
)


def target_of(key):
    """Цвет эталона для имени тона ('wood_mid' и т. п.)."""
    return TARGET.get(key, TARGET_STONE.get(key))


def check_table():
    """Словарь для сверки рендера с эталоном: имя тона -> RGB."""
    out = {}
    for key, val in list(TARGET.items()) + list(TARGET_STONE.items()):
        out[key] = ((val >> 16) & 255, (val >> 8) & 255, val & 255)
    return out
