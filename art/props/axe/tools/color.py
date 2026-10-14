"""Цвет без внешних зависимостей: sRGB <-> линейное, hex.

Чистый Python: модуль читают и Blender (axe.py), и пост-обработка
(calib_solve.py). Пересчёт базовых цветов идёт в ЛИНЕЙНОМ пространстве:
солнце и небо сцены поднимают тон, а sRGB-гамма делает это неравномерно
по каналам, поэтому умножение hex на коэффициент врёт.
"""


def lin(c):
    """sRGB 0..1 -> линейное."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb(c):
    """Линейное -> sRGB 0..1."""
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def to_lin(hex_rgb):
    """hex в том виде, как его читает глаз (sRGB) -> линейные значения."""
    return [lin(((hex_rgb >> s) & 255) / 255.0) for s in (16, 8, 0)]


def lin_hex(lin_rgb):
    """Линейные значения -> hex для thpipe.make_material.

    Важно: make_material кладёт цифры hex в Base Color КАК ЕСТЬ, то есть
    трактует их как линейные, а не как sRGB. Поэтому базовые цвета палитры
    (и всё, что пишется в palette_cal.json) — линейные: как sRGB они выглядят
    темнее, чем краска на спрайте.
    """
    out = 0
    for c in lin_rgb:
        out = (out << 8) | int(round(max(0.0, min(1.0, c)) * 255))
    return out


def from_lin_hex(hex_rgb):
    return [((hex_rgb >> s) & 255) / 255.0 for s in (16, 8, 0)]


def hex_str(hex_rgb):
    return '#%06X' % hex_rgb


def scaled(hex_target, lift):
    """Базовый цвет по цели эталона: цель / lift в линейном пространстве."""
    return lin_hex([c / lift for c in to_lin(hex_target)])
