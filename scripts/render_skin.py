# -*- coding: utf-8 -*-
"""render_v6 — explicit texture binding for every skin.

MEASURED root cause of the colour defect (mesh_mat_map.py):
  * SP family  : materials ship 2 texture nodes, textures auto-load. Works.
  * raccoon_00 : EVERY material has texnodes=0 — the FBX carries no image
                 bindings at all — AND Raccoon_01/02/04/05/06 and
                 Weapon_01/02/04/05 have NO material slot whatsoever.
    The previous script skipped any material without a texture node, so those
    meshes fell through to Blender's default grey/black -> 6 of 10 skins rendered
    at meanRGB ~(10,10,10).

Fix: bind textures explicitly by NAME, discovered from the texture directory,
and assign the Body material to any mesh that has no material slot.
Textures are chosen by the material's own name (…_03_Body_Mat -> …_03_Body_Color)."""
import bpy, sys, math, os, re, glob, mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
fbx = argv[0]
out = argv[1]
res = int(argv[2]) if len(argv) > 2 else 900
yaw = float(argv[3]) if len(argv) > 3 else 0.0
eyetex = argv[4] if len(argv) > 4 else '-'
mode = argv[5] if len(argv) > 5 else 'orig'
EYEOFF = 0.004

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
for o in list(bpy.data.objects):
    if o.name.lower().startswith('cube'):
        bpy.data.objects.remove(o, do_unlink=True)

# ---- texture directory = sibling 'texture' folder of the FBX -------------
texdir = os.path.join(os.path.dirname(fbx), 'texture')
avail = {}
for p in glob.glob(os.path.join(texdir, '*.png')):
    avail[os.path.basename(p)] = p
print("texture dir: %s  (%d png)" % (texdir, len(avail)))


def pick(skin_prefix, kind):
    """kind in Body/Weapon/Item/Eyes -> the _Color png for that part."""
    want = '%s_%s_Color.png' % (skin_prefix, kind)
    if want in avail:
        return avail[want]
    for n, p in avail.items():
        if n.startswith(skin_prefix) and ('_%s_Color' % kind) in n:
            return p
    return None


# skin prefix from the FBX filename. Art FBXs are named Art_<SkinStem> while the
# textures are named <SkinStem>_Body_Color.png — strip the leading 'Art_'.
stem = os.path.splitext(os.path.basename(fbx))[0]
prefix = re.sub(r'^Art_', '', stem)
print("skin prefix: %s (from %s)" % (prefix, stem))

# ---- assign Body material to meshes that have none ------------------------
body_mat = None
for m in bpy.data.materials:
    if 'body' in m.name.lower():
        body_mat = m
        break
unassigned = []
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    if not any(ms.material for ms in o.material_slots):
        if body_mat:
            o.data.materials.append(body_mat)
            unassigned.append(o.name)
print("meshes given the Body material (%d): %s" % (len(unassigned), unassigned))

if mode == 'noeye':
    e = bpy.data.objects.get('Eye')
    if e:
        bpy.data.objects.remove(e, do_unlink=True)
elif eyetex and eyetex != '-' and os.path.exists(eyetex):
    img = bpy.data.images.load(eyetex, check_existing=False)
    bound = 0
    for m in bpy.data.materials:
        if 'eye' not in m.name.lower() or not m.node_tree:
            continue
        nt = m.node_tree
        nodes = [n for n in nt.nodes if n.type == 'TEX_IMAGE']
        if not nodes:
            nodes = [nt.nodes.new('ShaderNodeTexImage')]
        for n in nodes:
            n.image = img
            n.interpolation = 'Linear'
            n.extension = 'REPEAT'
            bound += 1
    print("EYE TEXTURE -> %s (%d node(s))" % (os.path.basename(eyetex), bound))
    assert bound > 0, "eye texture bound to 0 nodes"

if mode != 'noeye' and EYEOFF and bpy.data.objects.get('Eye'):
    for v in bpy.data.objects['Eye'].data.vertices:
        v.co.y -= EYEOFF

# ---- build every material with an explicitly bound texture ---------------
for m in bpy.data.materials:
    if not m.use_nodes or not m.node_tree:
        continue
    name = m.name
    low = name.lower()
    is_eye = 'eye' in low
    kind = 'Eyes' if is_eye else ('Weapon' if 'weapon' in low
                                  else ('Item' if 'item' in low else 'Body'))
    path = None if is_eye else pick(prefix, kind)
    if is_eye:
        nodes = [n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
        if not nodes:
            et = bpy.data.images.get('eyefix3')
            nodes = None
        if not path and nodes:
            im = nodes[0].image
        else:
            im = None
    else:
        im = bpy.data.images.load(path, check_existing=True) if path else None
    if im is None:
        print("MAT %-42s NO TEXTURE FOUND (kind=%s) -> skip" % (m.name, kind))
        continue

    nt = m.node_tree
    nt.nodes.clear()
    on = nt.nodes.new('ShaderNodeOutputMaterial')
    img = nt.nodes.new('ShaderNodeTexImage')
    img.image = im
    img.interpolation = 'Linear'
    img.extension = 'REPEAT'

    if is_eye:
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = 1.0
        nt.links.new(img.outputs['Color'], em.inputs['Color'])
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(img.outputs['Alpha'], mix.inputs['Fac'])
        nt.links.new(tr.outputs['BSDF'], mix.inputs[1])
        nt.links.new(em.outputs['Emission'], mix.inputs[2])
        nt.links.new(mix.outputs['Shader'], on.inputs['Surface'])
        m.blend_method = 'BLEND'
        try:
            m.shadow_method = 'NONE'
        except Exception:
            pass
        note = 'alpha-mixed unlit + BLEND'
    else:
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = 1.0
        nt.links.new(img.outputs['Color'], em.inputs['Color'])
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(img.outputs['Alpha'], mix.inputs['Fac'])
        nt.links.new(tr.outputs['BSDF'], mix.inputs[1])
        nt.links.new(em.outputs['Emission'], mix.inputs[2])
        nt.links.new(mix.outputs['Shader'], on.inputs['Surface'])
        m.blend_method = 'BLEND'
        note = 'alpha-mixed unlit'
    m.use_backface_culling = False
    print("MAT %-42s %-24s tex=%s" % (m.name, note, os.path.basename(im.name)))

# hide empties and effect meshes that have no material (game FX slots)
for o in bpy.data.objects:
    if o.type == 'MESH' and not any(ms.material for ms in o.material_slots):
        o.hide_render = True

mn = [1e9] * 3; mx = [-1e9] * 3
for o in bpy.data.objects:
    if o.type == 'MESH' and not o.hide_render:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            for i in range(3):
                mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
cx = (mn[0] + mx[0]) / 2; cy = (mn[1] + mx[1]) / 2; cz = (mn[2] + mx[2]) / 2
hh = max(mx[2] - mn[2], mx[0] - mn[0], mx[1] - mn[1])

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x = res
scene.render.resolution_y = res
scene.render.film_transparent = True
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0

cd = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cd)
scene.collection.objects.link(cam); scene.camera = cam
cd.type = 'ORTHO'; cd.ortho_scale = hh * 1.35
cd.clip_start = 0.01; cd.clip_end = hh * 6.0

w = bpy.data.worlds.new("w"); scene.world = w; w.use_nodes = True
bg = w.node_tree.nodes.get('Background')
if bg:
    bg.inputs[0].default_value = (1, 1, 1, 1)
    bg.inputs[1].default_value = 0.0

a = math.radians(yaw); dist = hh * 4.0
x = cx + dist * math.sin(a); y = cy - dist * math.cos(a); z = cz + hh * 0.05
cam.location = (x, y, z)
cam.rotation_euler = mathutils.Vector((cx - x, cy - y, cz - z)).to_track_quat('-Z', 'Y').to_euler()
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
print("RENDERED", out)
print("V6_DONE")
