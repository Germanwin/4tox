"""thpal.py — палитра ратуши как ДАННЫЕ (без bpy).

Нужна, чтобы проекты могли сверить свои цвета с ратушей, не поднимая Blender:
`townhall.py::palette()` зовёт `thpipe.make_material`, а тот требует bpy.
Список обязан совпадать с `townhall.py::palette()` — сверяет `check_palette.py`.
"""
HEX = dict([
    ('wall',    0x93714A),
    ('timber',  0x5E3D1E),
    ('beam',    0x8A6238),
    ('plank',   0xA07C4C),
    ('thatch',  0xA8823C),
    ('thatch2', 0x8E6C2C),
    ('stone',   0x8E9498),
    ('stone2',  0x6E747A),
    ('moss',    0x466B34),
    ('dark',    0x1A140E),
    ('dirt',    0x7A6244),
    ('iron',    0x3A3A3E),
])
