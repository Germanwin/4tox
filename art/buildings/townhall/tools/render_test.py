"""Калибровочная сцена: изометрия и свет под стиль атласа mapgen2.

Крутится из командной строки:
    blender -b -P tools/render_test.py

Кладёт renders/test.png и печатает числа для сверки с эталонными спрайтами.
"""
import bpy, bmesh, math, os, sys
from mathutils import Matrix, Vector, Euler

# ---- конвенции сцены -------------------------------------------------------
# 1 юнит модели = 1 клетка карты. Ратуша: 4 x 3 клетки, ось X — длинная.
AZ = math.radians(45.0)          # азимут камеры
EL = math.atan(1.0 / math.sqrt(2.0))   # 35.264° — истинная изометрия, ромб 2:1
ORTHO = 5.6                      # мировой размер кадра по высоте
RES_X, RES_Y = 512, 482
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'renders')
os.makedirs(OUT, exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.objects,
              bpy.data.cameras, bpy.data.lights):
        for item in list(c):
            c.remove(item)


def make_material(name, hex_rgb, rough=0.75):
    r = ((hex_rgb >> 16) & 255) / 255.0
    g = ((hex_rgb >> 8) & 255) / 255.0
    b = (hex_rgb & 255) / 255.0
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.0
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = 0.15
    mat.diffuse_color = (r, g, b, 1.0)
    return mat


def new_mesh(name, mat):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    bpy.context.collection.objects.link(ob)
    return ob


def bm_to_obj(bm, name, mat):
    ob = new_mesh(name, mat)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = False
    return ob


def add_cylinder(bm, x, y, z, r, h, seg=8, r_top=None, rot_z=0.0):
    """Цилиндр/усечённый конус, низ на z, ось Z."""
    r_top = r if r_top is None else r_top
    mat = (Matrix.Translation((x, y, z + h / 2)) @
           Matrix.Rotation(rot_z, 4, 'Z'))
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r, radius2=r_top, depth=h, matrix=mat)
    return bm


def add_box(bm, x, y, z, sx, sy, sz):
    mat = (Matrix.Translation((x, y, z + sz / 2)) @
           Matrix.Diagonal((sx, sy, sz, 1.0)))
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat)
    return bm


def add_ico(bm, x, y, z, r, subdiv=1):
    mat = Matrix.Translation((x, y, z)) @ Matrix.Diagonal((r, r, r, 1.0))
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0, matrix=mat)
    return bm


def setup_camera():
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ORTHO
    cam = bpy.data.objects.new('Cam', cam_data)
    bpy.context.collection.objects.link(cam)

    fwd = Vector((math.cos(EL) * math.cos(AZ), -math.cos(EL) * math.sin(AZ), -math.sin(EL)))
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(fwd).normalized()
    target = Vector((0.0, 0.0, 0.0))
    cam.location = target - fwd * 30.0
    R = Matrix(((right.x, up.x, -fwd.x),
                (right.y, up.y, -fwd.y),
                (right.z, up.z, -fwd.z)))
    cam.rotation_euler = R.to_euler('XYZ')
    bpy.context.scene.camera = cam
    return cam, dict(fwd=fwd, right=right, up=up)


def setup_light():
    # Направление: свет идёт сверху-слева-спереди, как на эталонных спрайтах.
    sun_dir = Vector((-0.36, -0.30, 0.88)).normalized()   # куда летит свет
    R = (-sun_dir).to_track_quat('Z', 'Y').to_matrix()
    ld = bpy.data.lights.new('Sun', 'SUN')
    ld.energy = 3.2
    ld.angle = math.radians(3.0)
    sun = bpy.data.objects.new('Sun', ld)
    sun.rotation_euler = R.to_euler('XYZ')
    bpy.context.collection.objects.link(sun)

    w = bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.62, 0.66, 0.72, 1.0)
    bg.inputs['Strength'].default_value = 0.42
    return sun


def setup_render():
    sc = bpy.context.scene
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'CYCLES'):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x = RES_X
    sc.render.resolution_y = RES_Y
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    try:
        sc.eevee.taa_render_samples = 64
    except Exception:
        pass


def build_test():
    m_wood = make_material('wood', 0x8A5A2B)
    m_straw = make_material('straw', 0xC9A855)
    # земляной прямоугольник 4 x 3 (плоскость на z=0)
    me = bpy.data.meshes.new('ground')
    ob = bpy.data.objects.new('ground', me)
    bpy.context.collection.objects.link(ob)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5,
                          matrix=Matrix.Diagonal((4.0, 3.0, 1.0, 1.0)))
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = False
    # куб-эталон: 1x1x1 на клетке (1,1), чтобы замерить проекцию
    bm = bmesh.new()
    add_box(bm, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0)
    bm_to_obj(bm, 'cube_ref', m_wood)
    # шар для проверки округлости
    bm = bmesh.new()
    add_ico(bm, -1.0, 0.5, 1.0, 0.7, 1)
    bm_to_obj(bm, 'sphere_ref', m_straw)
    # два маркера на земле для замера ромба 2:1
    m_mark = make_material('mark', 0xFF0000)
    bm = bmesh.new()
    add_box(bm, 0.0, 0.0, 0.0, 0.06, 0.06, 0.06)
    add_box(bm, 1.0, 0.0, 0.0, 0.06, 0.06, 0.06)
    add_box(bm, 0.0, 1.0, 0.0, 0.06, 0.06, 0.06)
    bm_to_obj(bm, 'marks', m_mark)
    return dict(ground=ob)


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    clear_scene()
    build_test()
    cam, vec = setup_camera()
    setup_light()
    setup_render()
    print('CAM fwd=%s right=%s up=%s' % (tuple(round(v, 4) for v in vec['fwd']),
                                          tuple(round(v, 4) for v in vec['right']),
                                          tuple(round(v, 4) for v in vec['up'])))
    print('EL=%.4f deg  ortho=%.3f  res=%dx%d  ppu=%.4f' % (
        math.degrees(EL), ORTHO, RES_X, RES_Y, RES_Y / ORTHO))
    render(os.path.join(OUT, 'test.png'))
    print('OK ->', os.path.join(OUT, 'test.png'))
