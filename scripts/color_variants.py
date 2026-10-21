#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性渲出 Body 材质的几种分层方案，用来定「颜色到底哪儿不对」。

背景：现在只用 Body_Color_A 一张图，但游戏材质 JSON 显示实际是
  _DiffuseRampMultiTex / _DiffuseCoolRampMultiTex / _LightMap / Ramp 渐变
多层叠加。只用最基础那张 → 颜色发灰、没有游戏里的通透感。

这里一次渲多种方案，直接对比：
  A 现状          Color_A 直连 Base Color（当前做法）
  B + LightMap    Color_A × LightMap（乘算，补 AO/阴影）
  C + Ramp 暖     Color_A 经 Warm_Ramp 查表（模拟游戏 ramp 分层）
  D 9 套配色对比  00/01/02/03 各渲一版，看哪套是随宠实际用的
  E 提饱和        A 的基础上调高饱和/对比（廉价但立竿见影）

用法：blender -b --factory-startup -P color_variants.py -- --model ...
        --tex-dir ... --out E:\\hsr-pet-extract\\colorvar
"""
from __future__ import annotations

import math
import os
import sys

import bpy  # type: ignore  # noqa: E402
import mathutils  # type: ignore  # noqa: E402


def av(key, default=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return argv[argv.index(key) + 1] if key in argv else default


def build_scene(res=400):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    w = bpy.data.worlds.new("W")
    w.use_nodes = True
    sc.world = w
    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam

    def area(n, l, e, s, col):
        ld = bpy.data.lights.new(n, type="AREA")
        ld.energy, ld.size, ld.color = e, s, col
        o = bpy.data.objects.new(n, ld)
        sc.collection.objects.link(o)
        o.location = l
        d = mathutils.Vector((0, 0, 0)) - o.location
        o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

    area("K", (2, -3, 4), 1200, 3, (1, .97, .93))
    area("F", (-3, -2, 2), 500, 3.5, (.92, .95, 1))
    area("R", (0, 3, 3), 700, 2.5, (1, .95, .88))
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 40
    try:
        sc.cycles.sample_clamp_indirect = 4.0
    except AttributeError:
        pass
    sc.render.film_transparent = True
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    return cam, sc


def load_model_and_frame(model, pitch_deg=30.0):
    """导入 + 归一化 + 摆正 + 相机定位，返回 (meshes, pivot, cam)。"""
    bpy.ops.import_scene.fbx(filepath=model)
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name == "Cube":
            bpy.data.objects.remove(o, do_unlink=True)
    ms = [o for o in bpy.data.objects
          if o.type == "MESH" and o.dimensions.length > 1e-6]
    sc = bpy.context.scene
    pv = bpy.data.objects.new("P", None)
    sc.collection.objects.link(pv)
    for o in ms:
        o.parent = pv
        o.matrix_parent_inverse = mathutils.Matrix.Identity(4)
    for a in [x for x in bpy.data.objects if x.type == "ARMATURE"]:
        a.location = (0, 0, 0)
        a.rotation_euler = (0, 0, 0)
    for o in ms:
        o.location = (0, 0, 0)
    bpy.context.view_layer.update()

    def bb(objs):
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for o in objs:
            for c in o.bound_box:
                w = o.matrix_world @ mathutils.Vector(c)
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
        return lo, hi

    bpy.ops.object.select_all(action="DESELECT")
    for o in ms:
        o.select_set(True)
    bpy.context.view_layer.objects.active = ms[0]
    lo, hi = bb(ms)
    s = 1.0 / max(1e-9, hi[1] - lo[1])
    bpy.ops.transform.resize(value=(s, s, s))
    bpy.context.view_layer.update()
    lo, hi = bb(ms)
    c = mathutils.Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
    for o in ms:
        o.matrix_world = o.matrix_world @ mathutils.Matrix.Translation(-c)
    bpy.context.view_layer.update()
    pv.rotation_euler = (math.radians(90), 0, 0)
    bpy.context.view_layer.update()
    lo, hi = bb(ms)
    extent = max(hi[i] - lo[i] for i in range(3))
    return ms, pv, sc, extent


def simple_mat(tex, rough=0.62):
    m = bpy.data.materials.new("m")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    for l in list(nt.links):
        if l.to_socket.name == "Base Color":
            nt.links.remove(l)
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(tex)
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    return m


def lightmap_mat(color_tex, lightmap_tex, rough=0.62):
    """Color_A × LightMap —— 补上游戏里的 AO/烘焙阴影。"""
    m = bpy.data.materials.new("mLM")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    for l in list(nt.links):
        if l.to_socket.name == "Base Color":
            nt.links.remove(l)
    tc = nt.nodes.new("ShaderNodeTexImage")
    tc.image = bpy.data.images.load(color_tex)
    tc.location = (-700, 300)
    tl = nt.nodes.new("ShaderNodeTexImage")
    tl.image = bpy.data.images.load(lightmap_tex)
    tl.location = (-700, -100)
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs["Fac"].default_value = 1.0
    mix.location = (-350, 150)
    nt.links.new(tc.outputs["Color"], mix.inputs[1])
    nt.links.new(tl.outputs["Color"], mix.inputs[2])
    nt.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    return m


def sat_mat(tex, rough=0.62, sat=1.45, bright=1.10):
    """A 基础上提饱和 + 提亮（模拟游戏里 Ramp 带来的通透感）。"""
    m = bpy.data.materials.new("mSat")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    for l in list(nt.links):
        if l.to_socket.name == "Base Color":
            nt.links.remove(l)
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(tex)
    t.location = (-800, 300)
    hsv = nt.nodes.new("ShaderNodeHueSaturation")
    hsv.inputs["Saturation"].default_value = sat
    hsv.inputs["Value"].default_value = bright
    hsv.location = (-450, 300)
    nt.links.new(t.outputs["Color"], hsv.inputs["Color"])
    nt.links.new(hsv.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    return m


def render(tag, model, tex, out, pitch_deg=30.0, res=400, eye_tex=None):
    cam, sc = build_scene(res)
    ms, pv, sc2, extent = load_model_and_frame(model, pitch_deg)
    sc = sc2
    p = math.radians(pitch_deg)
    cam.location = (0, -6.0 * math.cos(p), 6.0 * math.sin(p))
    cam.rotation_euler = (math.radians(90) - p, 0, 0)
    cam.data.ortho_scale = extent * 1.30

    eye_mat = simple_mat(eye_tex, 0.35) if eye_tex and os.path.isfile(eye_tex) else None
    for o in ms:
        mat = tex(o)          # 传入一个函数，按 mesh 决定材质
        o.data.materials.clear()
        o.data.materials.append(
            eye_mat if (o.name.lower().startswith("eye") and eye_mat) else mat)
    path = os.path.join(out, f"{tag}.png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"[cv] {tag:<14} -> {path}")


def main():
    model = av("--model")
    td = av("--tex-dir")
    out = av("--out")
    os.makedirs(out, exist_ok=True)
    c00 = os.path.join(td, "Monster_W5_Limao_00_Body_Color_A.png")
    lm00 = os.path.join(td, "Monster_W5_Limao_00_Body_LightMap.png")
    eye = os.path.join(td, "Monster_W5_Limao_00_Eye_Color_A.png")

    # A 现状
    render("A_current", model, lambda o: simple_mat(c00), out, eye_tex=eye)
    # B + LightMap
    render("B_lightmap", model,
           lambda o: lightmap_mat(c00, lm00), out, eye_tex=eye)
    # C 提饱和
    render("C_sat145", model,
           lambda o: sat_mat(c00, sat=1.45, bright=1.10), out, eye_tex=eye)
    # D 提饱和更强
    render("D_sat190", model,
           lambda o: sat_mat(c00, sat=1.90, bright=1.18), out, eye_tex=eye)
    # E 配色 01 / 02
    for i in (1, 2, 3):
        f = os.path.join(td, f"Monster_W5_Limao_{i:02d}_Body_Color_A.png")
        if os.path.isfile(f):
            render(f"E_color{i:02d}", model,
                   lambda o, f=f: sat_mat(f, sat=1.45, bright=1.10),
                   out, eye_tex=eye)
    print(f"[cv] 完成，图在 {out}")


if __name__ == "__main__":
    main()