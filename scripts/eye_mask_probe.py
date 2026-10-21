# -*- coding: utf-8 -*-
"""00_06 shows 5 blobs and a small eye width. Is that a real defect, or does the
golden skin's halo/wing art sitting on the eye plate split the diff?

Decisive test: render 00_06 with the eye plate in flat magenta. Whatever is
EYE GEOMETRY shows up magenta; everything else stays textured. That separates
'eye art is broken' from 'accessory art overlaps the eye region'."""
import bpy, sys, math, os, mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
fbx = argv[0]
out = argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
for o in list(bpy.data.objects):
    if o.name.lower().startswith('cube'):
        bpy.data.objects.remove(o, do_unlink=True)

eo = bpy.data.objects.get('Eye')
for m in bpy.data.materials:
    if 'eye' in m.name.lower() and m.node_tree:
        nt = m.node_tree
        nt.nodes.clear()
        on = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (1, 0, 1, 1)
        em.inputs['Strength'].default_value = 1.0
        nt.links.new(em.outputs['Emission'], on.inputs['Surface'])
        m.blend_method = 'OPAQUE'
        m.use_backface_culling = False
        print("eye material -> flat magenta")

for v in eo.data.vertices:
    v.co.y -= 0.004

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
scene.render.resolution_x = 900; scene.render.resolution_y = 900
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'
cd = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cd)
scene.collection.objects.link(cam); scene.camera = cam
cd.type = 'ORTHO'; cd.ortho_scale = hh * 1.35
cd.clip_start = 0.01; cd.clip_end = hh * 6.0
w = bpy.data.worlds.new("w"); scene.world = w; w.use_nodes = True
bg = w.node_tree.nodes.get('Background')
if bg:
    bg.inputs[0].default_value = (1, 1, 1, 1); bg.inputs[1].default_value = 0.0
dist = hh * 4
cam.location = (cx, cy - dist, cz)
cam.rotation_euler = mathutils.Vector((0, dist, 0)).to_track_quat('-Z', 'Y').to_euler()
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
print("RENDERED", out)
print("MAGENTA_DONE")
