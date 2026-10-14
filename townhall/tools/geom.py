"""Конвенции кадра без внешних зависимостей: проекция мира в пиксели.

Чистый Python (кроме numpy): этот модуль импортирует и Blender, и пост-обработка.
    right = (cos AZ, -sin AZ, 0)          # вправо по экрану
    up    = (-sin EL*cos AZ, -sin EL*sin AZ, cos EL)
    px = W/2 + (p·right) * ppu
    py = H/2 - (p·up)    * ppu
Камера смотрит в центр кадра, поэтому точка (0,0,0) всегда попадает в центр.
"""
import math

AZ = math.radians(45.0)
EL = math.atan(1.0 / math.sqrt(2.0))          # 35.2644° — истинная изометрия
RES_X, RES_Y = 512, 640
ORTHO = 8.00
PPU = RES_Y / ORTHO                            # ~104.9 px на юнит модели

RIGHT = (math.cos(AZ), -math.sin(AZ), 0.0)
UP = (-math.sin(EL) * math.cos(AZ), -math.sin(EL) * math.sin(AZ), math.cos(EL))

# --- параметры пост-обработки (замерены по assets/sprites/atlas.png) ---
SHADOW_RGB = (11, 14, 11)
SHADOW_ALPHA = 0.07            # гаусс тени умножается на это
OUTLINE_RGB = (14, 18, 14)
OUTLINE_DILATE = 1             # пикселей; на 105 ppu это ≈ 2 px эталона


def project(px, py, pz):
    """Мир -> пиксели кадра (x вправо, y вниз от левого верхнего угла)."""
    sx = px * RIGHT[0] + py * RIGHT[1] + pz * RIGHT[2]
    sy = px * UP[0] + py * UP[1] + pz * UP[2]
    return RES_X / 2.0 + sx * PPU, RES_Y / 2.0 - sy * PPU


def ground_ellipse(cx, cy, rx, ry, blur=0.16):
    """Эллипс на земле (мировые полуоси) -> оси эллипса на экране."""
    ux, uy = rx * RIGHT[0], rx * RIGHT[1]
    vx, vy = ry * UP[0], ry * UP[1]
    a2 = ux ** 2 + vx ** 2          # разброс по экранному X
    b2 = uy ** 2 + vy ** 2          # разброс по экранному Y
    c2 = ux * uy + vx * vy
    tr = a2 + b2
    det = a2 * b2 - c2 ** 2
    disc = max(0.0, (tr / 2.0) ** 2 - det) ** 0.5
    l1 = tr / 2.0 + disc
    l2 = max(tr / 2.0 - disc, 1e-9)
    ang = 0.5 * math.atan2(2.0 * c2, a2 - b2)
    return dict(cx=cx, cy=cy, a=math.sqrt(l1) * PPU, b=math.sqrt(l2) * PPU,
                angle_deg=math.degrees(ang), blur=blur)


# Тень: контактное пятно чуть шире пятна застройки, сдвинуто вниз-вправо
# (солнце сверху-слева, как на эталонных спрайтах).
SHADOW_SPREAD = 1.14          # во сколько шире пятна застройки
# Сдвиг пятна на экране (пиксели, вправо-вниз): смещает тень к видимому
# основанию силуэта, иначе у высокого здания пятно вылезает слева сверху.
SHADOW_SHIFT_PX = (4.0, 26.0)
SHADOW_LIFT = 0.0             # подъём пятна над землёй, юниты


def world_offset(dx_px, dy_px):
    """Сдвиг на экране -> сдвиг на земле (решаем 2x2 через right/up)."""
    det = RIGHT[0] * UP[1] - RIGHT[1] * UP[0]
    sx, sy = dx_px / PPU, -dy_px / PPU       # экранный сдвиг (y вверх)
    wx = (sx * UP[1] - sy * UP[0]) / det
    wy = (RIGHT[0] * sy - RIGHT[1] * sx) / det
    return wx, wy


def shadow_for(cx, cy, rx, ry, blur=0.15):
    return ground_ellipse(cx, cy, rx * SHADOW_SPREAD, ry * SHADOW_SPREAD, blur)


def shadows_for(variant):
    if variant == 'b':
        return [shadow_for(0.0, 0.35, 2.02, 1.90)]
    if variant == 'c':
        return [shadow_for(-0.30, 0.0, 1.95, 1.52),
                shadow_for(0.0, -0.36, 0.92, 0.92)]
    return [shadow_for(0.0, 0.0, 2.02, 1.52)]
