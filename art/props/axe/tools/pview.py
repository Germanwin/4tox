"""Осмотр модели: несколько видов топора в один лист -> renders/pview.png

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P tools/pview.py -- --variant a --views iso,side,front,back

Нужен при правке формы: конвенции пайплайна (изометрия 45/35.26) показывают
топор только с одной стороны, а профиль лезвия и толщину головы надо видеть
сбоку и спереди. Лист собирается тем же python3, где есть Pillow.
"""
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'townhall', 'tools'))

import bpy
from mathutils import Matrix, Vector

import thpipe as P
import axe as A

RENDERS = os.path.join(ROOT, 'renders')

P.RES_X, P.RES_Y = 480, 600
P.ORTHO = 0.72

# вид: (азимут, подъём) в градусах
VIEWS = dict(
    iso=(45.0, 35.2644),
    side=(0.0, 8.0),
    front=(90.0, 8.0),
    back=(270.0, 8.0),
    top=(45.0, 70.0),
    low=(45.0, 20.0),
)


def argv():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def opt(name, default=None):
    a = argv()
    if name in a:
        i = a.index(name)
        if i + 1 < len(a) and not a[i + 1].startswith('--'):
            return a[i + 1]
        return True
    return default


def camera_at(az_deg, el_deg, center_z):
    """Камера вокруг вертикали: az 0 — смотрим с -Y, дальше по часовой."""
    az, el = math.radians(az_deg), math.radians(el_deg)
    fwd = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el),
                  -math.sin(el))).normalized()
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = P.ORTHO
    cam = bpy.data.objects.new('Cam', cam_data)
    bpy.context.collection.objects.link(cam)
    right = fwd.cross(Vector((0, 0, 1)))
    if right.length < 1e-6:
        right = Vector((1, 0, 0))
    right.normalize()
    up = right.cross(fwd).normalized()
    target = Vector((0.0, 0.0, center_z))
    cam.location = target - fwd * 20.0
    R = Matrix(((right.x, up.x, -fwd.x),
                (right.y, up.y, -fwd.y),
                (right.z, up.z, -fwd.z)))
    cam.rotation_euler = R.to_euler('XYZ')
    bpy.context.scene.camera = cam


def main():
    variant = str(opt('--variant', 'a'))
    names = str(opt('--views', 'side,front,iso,top')).split(',')
    center_z = float(opt('--center', 0.26))
    samples = int(opt('--samples', 32))

    files = []
    for name in names:
        az, el = VIEWS[name]
        P.clear_scene()
        A.reset_palette()
        P.setup_light()
        P.setup_render(samples=samples)
        P.ORTHO = 0.72
        A.build(variant)
        camera_at(az, el, center_z)
        path = os.path.join(RENDERS, 'pview_%s.png' % name)
        P.render_to(path)
        files.append(path)
        print('VIEW %s az=%.1f el=%.1f -> %s' % (name, az, el, path))

    sheet = os.path.join(RENDERS, 'pview.png')
    # Blender-питон без Pillow: лист собирает системный python (тот же, что
    # у compose_axe.py). Путь можно переопределить --py или переменной AXE_PY.
    py = str(opt('--py', os.environ.get(
        'AXE_PY',
        '/Users/hermmoment/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3')))
    code = (
        'from PIL import Image, ImageDraw\n'
        'import sys\n'
        'files = %r\n'
        'names = %r\n'
        'ims = [Image.open(f).convert("RGBA") for f in files]\n'
        'w, h = ims[0].size\n'
        'n = len(ims)\n'
        'cols = min(n, 2)\n'
        'rows = (n + cols - 1) // cols\n'
        'bg = Image.new("RGBA", (w * cols, h * rows), (250, 250, 250, 255))\n'
        'd = ImageDraw.Draw(bg)\n'
        'for i, im in enumerate(ims):\n'
        '    x, y = (i %% cols) * w, (i // cols) * h\n'
        '    bg.alpha_composite(im, (x, y))\n'
        '    d.text((x + 8, y + 6), names[i], fill=(20, 20, 20, 255))\n'
        'bg.convert("RGB").save(%r)\n'
        'print("SHEET", %r)\n'
    ) % (files, names, sheet, sheet)
    subprocess.run([py, '-c', code], check=True)


if __name__ == '__main__':
    main()
