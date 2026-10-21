#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：Eye mesh 到底有没有被 Body 挡住 / 有没有贴上正确的表情。

背景：渲出来脸上一条横带发黑（实测占脸部 14% 像素 max<60，集中在 y33..77）。
猜是没用的，直接量：
  1. 从脸的正前方(相机方向)往里打射线，看 Eye 面是不是被 Body 先命中；
  2. 渲一张「只有 Eye、不带 Body」的图，确认 Eye 自身贴图是否正常；
  3. 渲一张「Eye 强制推出 0.15」的图，看推出够不够。

用法：blender -b --factory-startup -P eye_diag.py -- --model ... \
        --eye-texture ... --out E:\hsr-pet-extract\eyediag
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


def scene(res=420):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    w = bpy.data.worlds.new("W")
    w.use_nodes = True
    sc.world = w
    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    cd.ortho_scale = 1.4
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    cam.location = (0, -6, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = cam

    def area(n, l, e, s, col):
        ld = bpy.data.lights.new(n, type="AREA")
        ld.energy, ld.size, ld.color = e, s, col
        o = bpy.data.objects.new(n, ld)
        sc.collection.objects.link(o)
        o.location = l
        d = mathutils.Vector((0, 0, 0)) - o.location
        o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

    area("K", (2, -3, 3), 1000, 3, (1, .97, .93))
    area("F", (-3, -2, 1), 400, 3.5, (.92, .95, 1))
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 24
    sc.render.film_transparent = True
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    return cam, sc


def uv_remap(eye_obj, row, col_left, col_right, grid_rows=5, grid_cols=8):
    uv = eye_obj.data.uv_layers.active
    if uv is None:
        print("[diag] Eye 无 UV 层")
        return
    cw, ch = 1.0 / grid_cols, 1.0 / grid_rows
    for loop in eye_obj.data.loops:
        u, v = uv.data[loop.index].uv
        col = col_left if u < 0.5 else col_right
        _, lu = divmod(u, cw)
        _, lv = divmod(v, ch)
        uv.data[loop.index].uv = ((col + min(lu, 1.0)) * cw,
                                  (row + min(lv, 1.0)) * ch)
    print(f"[diag] Eye UV -> row{row} 左col{col_left} 右col{col_right}")


def set_tex(objs, tex, rough=0.4):
    for o in objs:
        m = bpy.data.materials.new("m_" + o.name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        for link in list(nt.links):
            if link.to_socket.name == "Base Color":
                nt.links.remove(link)
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(tex)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = rough
        o.data.materials.clear()
        o.data.materials.append(m)


def main():
    model = av("--model")
    eye_tex = av("--eye-texture")
    out = av("--out", r"E:\hsr-pet-extract\eyediag")
    os.makedirs(out, exist_ok=True)

    cam, sc = scene()
    bpy.ops.import_scene.fbx(filepath=model)
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name == "Cube":
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.data.objects
              if o.type == "MESH" and o.dimensions.length > 1e-6]
    eyes = [o for o in meshes if o.name.lower().startswith("eye")]
    bodies = [o for o in meshes if o not in eyes]
    print(f"[diag] mesh={len(meshes)} eye={len(eyes)} body={len(bodies)}")
    if not eyes:
        raise SystemExit("❌ 没找到 Eye mesh")

    # 摆正：绕 X +90°（+Y 头顶 → +Z；+Z 脸 → -Y 相机）
    for o in meshes:
        o.rotation_euler = (math.radians(90), 0, 0)
        o.location = (0, 0, 0)
    bpy.context.view_layer.update()

    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in meshes:
        for cpt in o.bound_box:
            wpt = o.matrix_world @ mathutils.Vector(cpt)
            for i in range(3):
                lo[i] = min(lo[i], wpt[i])
                hi[i] = max(hi[i], wpt[i])
    print(f"[diag] 摆正后 bbox Z={lo[2]:.3f}..{hi[2]:.3f} (身高 {hi[2]-lo[2]:.3f})")
    cam.data.ortho_scale = max(hi[i] - lo[i] for i in range(3)) * 1.3

    # ── 测试1：射线检测 Eye 是否被 Body 遮挡 ────────────────────
    print("\n[diag] === 射线检测（从相机 -Y 朝 +Y 打）===")
    dg = bpy.context.evaluated_depsgraph_get()
    for eye in eyes:
        mw = eye.matrix_world
        # 眼睛几何中心
        pts = [mw @ mathutils.Vector(c) for c in eye.bound_box]
        ctr = sum(pts, mathutils.Vector()) / 8.0
        hit_eye, hit_body, _, _, _, _ = sc.ray_cast(
            dg, ctr + mathutils.Vector((0, -3, 0)), mathutils.Vector((0, 1, 0)))
        print(f"  从眼睛中心沿 -Y 射线: 先命中 "
              f"{'Body(被挡!)' if hit_body and not hit_eye else 'Eye(可见 ✓)'}"
              f"  命中点 z={ctr.z:.3f}")
        print(f"    眼睛中心 z={ctr.z:.3f}  "
              f"Body该高度前表面 z=?（见上方 bbox Z 上限 {hi[2]:.3f}）")

    # ── 测试2：只渲 Eye ─────────────────────────────────────────
    for o in bodies:
        o.hide_render = True
    set_tex(eyes, eye_tex, 0.35)
    uv_remap(eyes[0], 1, 4, 5)
    sc.render.filepath = os.path.join(out, "eye_only.png")
    bpy.ops.render.render(write_still=True)
    print(f"\n[diag] 只渲 Eye -> {sc.render.filepath}")

    # ── 测试3：Eye 推出后再渲（带 Body）─────────────────────────
    for o in bodies:
        o.hide_render = False
    for off in (0.0, 0.05, 0.15):
        for o in bodies:
            o.hide_render = False
        for o in meshes:
            o.location = (0, 0, 0)
        for o in eyes:
            o.location = (0, 0, off)
        bpy.context.view_layer.update()
        sc.render.filepath = os.path.join(out, f"offset_{off:.2f}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[diag] eye-offset={off} -> {sc.render.filepath}")

    print(f"\n[diag] 完成，图在 {out}")


if __name__ == "__main__":
    main()