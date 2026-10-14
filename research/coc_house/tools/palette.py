"""Палитра дома в стиле Clash of Clans: цвет + характер поверхности.

Цвета заданы в sRGB (шестнадцатерично), в Blender уходят линейными —
иначе рендер заметно светлее задуманного.
"""

PALETTE = {
    # камень: тёплый светло-серый, чуть рукотворная кладка
    'stone':      dict(hex='A1977F', rough=0.92, jitter=0.050),
    'stone_lit':  dict(hex='B4AA92', rough=0.92, jitter=0.050),
    'stone_mid':  dict(hex='8C8370', rough=0.92, jitter=0.040),
    'stone_dark': dict(hex='6A645A', rough=0.94, jitter=0.028),
    # кровля и дерево каркаса
    'slate':      dict(hex='56648C', rough=0.80, jitter=0.035),
    'ridge':      dict(hex='63482F', rough=0.84, jitter=0.030),
    # столярка
    'wood':       dict(hex='9C7247', rough=0.85, jitter=0.045),
    'wood_lit':   dict(hex='AF855A', rough=0.85, jitter=0.045),
    'wood_dark':  dict(hex='755336', rough=0.87, jitter=0.035),
    # металл
    'metal':      dict(hex='787880', rough=0.44, metallic=0.85, jitter=0.020),
    'metal_dark': dict(hex='4B4B52', rough=0.48, metallic=0.85, jitter=0.020),
    # тёплый свет окон и фонаря
    'glass':      dict(hex='FFCB84', rough=0.30, emit='FFC46E', emit_strength=2.6),
    # зелень
    'leaf':       dict(hex='5D7134', rough=0.94, jitter=0.060),
    'leaf_lit':   dict(hex='6F8540', rough=0.94, jitter=0.060),
    # земля под домом
    'grass':      dict(hex='7F8C52', rough=1.0, gradient=('8E9A5C', '66703E')),
}


def srgb_to_linear(hex_str):
    """sRGB-строка -> линейный RGB для Blender."""
    h = hex_str.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def block_var(name):
    """Стабильный «шум» 0..1 по имени детали — разброс тона."""
    h = 2166136261
    for ch in name:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return (h % 1000) / 999.0
