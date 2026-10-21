import bpy, math, mathutils, sys, os
argv=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def av(k,d=None): return argv[argv.index(k)+1] if k in argv else d
model=av("--model"); body=av("--body"); eye=av("--eye"); out=av("--out")
bpy.ops.wm.read_factory_settings(use_empty=True)
sc=bpy.context.scene
w=bpy.data.worlds.new("W"); w.use_nodes=True; sc.world=w
cd=bpy.data.cameras.new("C"); cd.type="ORTHO"
cam=bpy.data.objects.new("C",cd); sc.collection.objects.link(cam); sc.camera=cam
def area(n,l,e,s,c):
    ld=bpy.data.lights.new(n,type="AREA"); ld.energy,ld.size,ld.color=e,s,c
    o=bpy.data.objects.new(n,ld); sc.collection.objects.link(o); o.location=l
    d=mathutils.Vector((0,0,0))-o.location; o.rotation_euler=d.to_track_quat('-Z','Y').to_euler()
area("K",(2,-3,3),1000,3,(1,.97,.93)); area("F",(-3,-2,1),400,3.5,(.92,.95,1)); area("R",(0,3,2),650,2.5,(1,.95,.88))
sc.render.engine="CYCLES"; sc.cycles.samples=32
sc.render.film_transparent=True; sc.render.resolution_x=420; sc.render.resolution_y=420
sc.render.image_settings.file_format="PNG"; sc.render.image_settings.color_mode="RGBA"
bpy.ops.import_scene.fbx(filepath=model)
for o in list(bpy.data.objects):
    if o.type=="MESH" and o.name=="Cube": bpy.data.objects.remove(o,do_unlink=True)
ms=[o for o in bpy.data.objects if o.type=="MESH" and o.dimensions.length>1e-6]
pv=bpy.data.objects.new("P",None); sc.collection.objects.link(pv)
for o in ms:
    o.parent=pv; o.matrix_parent_inverse=mathutils.Matrix.Identity(4)
for a in [x for x in bpy.data.objects if x.type=="ARMATURE"]:
    a.location=(0,0,0); a.rotation_euler=(0,0,0)
for o in ms: o.location=(0,0,0)
bpy.context.view_layer.update()
def bb(objs):
    lo=[1e9]*3; hi=[-1e9]*3
    for o in objs:
        for c in o.bound_box:
            wv=o.matrix_world@mathutils.Vector(c)
            for i in range(3): lo[i]=min(lo[i],wv[i]); hi[i]=max(hi[i],wv[i])
    return lo,hi
bpy.ops.object.select_all(action="DESELECT")
for o in ms: o.select_set(True)
bpy.context.view_layer.objects.active=ms[0]
lo,hi=bb(ms); s=1.0/max(1e-9,hi[1]-lo[1])
bpy.ops.transform.resize(value=(s,s,s)); bpy.context.view_layer.update()
lo,hi=bb(ms); c=mathutils.Vector([(lo[i]+hi[i])/2 for i in range(3)])
for o in ms: o.matrix_world=o.matrix_world@mathutils.Matrix.Translation(-c)
bpy.context.view_layer.update()
pv.rotation_euler=(math.radians(90),0,0); bpy.context.view_layer.update()
lo,hi=bb(ms); ext=max(hi[i]-lo[i] for i in range(3))
p=math.radians(30); cam.location=(0,-6*math.cos(p),6*math.sin(p))
cam.rotation_euler=(math.radians(90)-p,0,0); cd.ortho_scale=ext*1.3
def mat(name,tex,rough):
    m=bpy.data.materials.new(name); m.use_nodes=True
    nt=m.node_tree; b=nt.nodes.get("Principled BSDF")
    for l in list(nt.links):
        if l.to_socket.name=="Base Color": nt.links.remove(l)
    t=nt.nodes.new("ShaderNodeTexImage"); t.image=bpy.data.images.load(tex)
    nt.links.new(t.outputs["Color"],b.inputs["Base Color"])
    b.inputs["Roughness"].default_value=rough; b.inputs["Metallic"].default_value=0.0
    return m
bm=mat("B",body,0.62); em=mat("E",eye,0.35)
eyes=[o for o in ms if o.name.lower().startswith("eye")]
others=[o for o in ms if o not in eyes]
for o in others:
    o.data.materials.clear(); o.data.materials.append(bm)
for o in eyes:
    o.data.materials.clear(); o.data.materials.append(em)
# 变体1: 只渲 Eye(隐藏Body)
for o in others: o.hide_render=True
sc.render.filepath=os.path.join(out,"1_eyeonly.png"); bpy.ops.render.render(write_still=True)
print("[v] 1 eye-only")
# 变体2: 全渲, offset 0
for o in others: o.hide_render=False
for o in eyes: o.location=(0,0,0)
bpy.context.view_layer.update()
sc.render.filepath=os.path.join(out,"2_offset0.png"); bpy.ops.render.render(write_still=True)
print("[v] 2 offset0")
# 变体3: offset 0.3 (大幅推)
for o in eyes: o.location=(0,0,0.3)
bpy.context.view_layer.update()
lo,hi=bb(ms)
sc.render.filepath=os.path.join(out,"3_offset03.png"); bpy.ops.render.render(write_still=True)
print("[v] 3 offset0.3")
