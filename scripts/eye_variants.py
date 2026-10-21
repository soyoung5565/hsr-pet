#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性对比：同一帧下，眼睛的 N 种处理方式，选出能正常显示的那一种。

背景：脸上一条横带发黑。已排除的因素：
  - 贴图内容正常（row1/col4、col5 = 白球黑瞳，RGB 0~231）
  - Eye 几何正常（294 顶点 / 538 面，左右眼各 ~147 顶点，对称）
  - 材质绑定正确（Eye 挂 Eye_Color_A）
  - Eye 位置正确（脸高 72.8% 处）
但「只渲 Eye」时几乎全黑，只有一条暗月牙 → 采样结果本身就暗。

这里一次渲出多个变体，直接对比像素，别再一轮轮猜：
  A 原生 UV          —— 完全不改 UV（模型作者本来就是这么用的）
  B 重映射同行(同格) —— 旧行为：左右眼压同一格
  C 重映射左右分开   —— row1 col4 / col5
  D 原生 UV + 半透明 —— 材质加 alpha（游戏里眼睛常是半透贴片）
  E C + 半透明

用法：blender -b --factory-startup -P eye_variants.py -- --model ... \
        --eye-texture ... --body-texture ... --out E:\hsr-pet-extract\eyevar
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


def build_scene(res):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    w = bpy.data.worlds.new("W")
    w.use_nodes = True
    sc.world = w
    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    cd.ortho_scale = 1.3
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
    area("R", (0, 3, 2.4), 650, 2.5, (1, .95, .88))
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 32
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


def make_mat(name, tex, rough, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    for link in list(nt.links):
        if link.to_socket.name in ("Base Color", "Alpha"):
            nt.links.remove(link)
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(tex)
    t.location = (-400, 300)
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Alpha"].default_value = alpha
    return m


def remap(eye, row, cl, cr, rows=5, cols=8):
    uv = eye.data.uv_layers.active
    if uv is None:
        return
    cw, ch = 1.0 / cols, 1.0 / rows
    for lp in eye.data.loops:
        u, v = uv.data[lp.index].uv
        c = cl if u < 0.5 else cr
        _, lu = divmod(u, cw)
        _, lv = divmod(v, ch)
        uv.data[lp.index].uv = ((c + min(lu, 1.0)) * cw,
                               (row + min(lv, 1.0)) * ch)


def face_stats(path):
    """量脸部横带的亮度，判断这变体有没有把眼睛渲出来。

    ★ 用 Blender 自己的 bpy.data.images 读像素，**不要 import PIL**
    —— Blender 自带的 Python 环境没有 PIL（实测 ModuleNotFoundError）。
    """
    img = bpy.data.images.load(path)
    try:
        px = img.pixels[:]           # RGBA float 0..1，行优先
        w, h = img.size
        # 找 alpha>0.5 的包围盒
        xs, ys = [], []
        for y in range(h):
            base = y * w * 4
            for x in range(w):
                if px[base + x * 4 + 3] > 0.5:
                    xs.append(x)
                    ys.append(y)
        if not xs:
            return None
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        # 脸部横带：角色上 18%~42% 高度处
        by0 = y0 + int((y1 - y0) * 0.18)
        by1 = y0 + int((y1 - y0) * 0.42)
        tot = dark = bright = cnt = 0
        for y in range(by0, by1):
            base = y * w * 4
            for x in range(x0, x1 + 1):
                i = base + x * 4
                if px[i + 3] <= 0.5:
                    continue
                g = (px[i] + px[i + 1] + px[i + 2]) / 3.0
                tot += g
                cnt += 1
                if g < 0.235:      # <60/255
                    dark += 1
                elif g > 0.706:    # >180/255
                    bright += 1
        if cnt == 0:
            return None
        return {
            "band_mean": tot / cnt * 255.0,
            "dark_pct": dark / cnt * 100,
            "bright_pct": bright / cnt * 100,
            "band_px": cnt,
        }
    finally:
        bpy.data.images.remove(img)


def main():
    model, eye_tex = av("--model"), av("--eye-texture")
    body_tex, out = av("--body-texture"), av("--out")
    res = int(av("--res", "560"))
    os.makedirs(out, exist_ok=True)

    results = {}
    for tag in ("A_native", "B_samecell", "C_split", "D_native_alpha",
                "E_split_alpha", "F_offset_only"):
        cam, sc = build_scene(res)
        bpy.ops.import_scene.fbx(filepath=model)
        for o in list(bpy.data.objects):
            if o.type == "MESH" and o.name == "Cube":
                bpy.data.objects.remove(o, do_unlink=True)
        meshes = [o for o in bpy.data.objects
                  if o.type == "MESH" and o.dimensions.length > 1e-6]
        eyes = [o for o in meshes if o.name.lower().startswith("eye")]
        others = [o for o in meshes if o not in eyes]

        pivot = bpy.data.objects.new("P", None)
        sc.collection.objects.link(pivot)
        for o in meshes:
            o.parent = pivot
            o.matrix_parent_inverse = mathutils.Matrix.Identity(4)
        for a in [x for x in bpy.data.objects if x.type == "ARMATURE"]:
            a.location = (0, 0, 0)
            a.rotation_euler = (0, 0, 0)

        # Eye 沿模型 +Z 推出（埋在 Body 里）
        for o in eyes:
            o.location = o.location + mathutils.Vector((0, 0, 0.05))

        # 归一化（pivot 无旋转时做）
        bpy.ops.object.select_all(action="DESELECT")
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for o in meshes:
            for c in o.bound_box:
                w = o.matrix_world @ mathutils.Vector(c)
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
        s = 1.0 / max(1e-9, hi[1] - lo[1])       # 摆正前身高在 Y
        bpy.ops.transform.resize(value=(s, s, s))
        bpy.context.view_layer.update()
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for o in meshes:
            for c in o.bound_box:
                w = o.matrix_world @ mathutils.Vector(c)
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
        ctr = mathutils.Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
        for o in meshes:
            o.matrix_world = o.matrix_world @ mathutils.Matrix.Translation(-ctr)
        bpy.context.view_layer.update()

        pivot.rotation_euler = (math.radians(90), 0, 0)
        bpy.context.view_layer.update()

        bm = make_mat("B", body_tex, 0.62)
        alpha = tag.endswith("_alpha")
        em = make_mat("E", eye_tex, 0.35, alpha=0.85 if alpha else 1.0)
        if alpha:
            em.blend_method = "BLEND"
        for o in others:
            o.data.materials.clear()
            o.data.materials.append(bm)
        for o in eyes:
            o.data.materials.clear()
            o.data.materials.append(em)
            if tag == "B_samecell":
                remap(o, 1, 4, 4)
            elif tag in ("C_split", "E_split_alpha"):
                remap(o, 1, 4, 5)

        lo = [1e9] * 3
        hi = [-1e9] * 3
        for o in meshes:
            for c in o.bound_box:
                w = o.matrix_world @ mathutils.Vector(c)
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
        cam.data.ortho_scale = max(hi[i] - lo[i] for i in range(3)) * 1.30

        p = os.path.join(out, f"{tag}.png")
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        st = face_stats(p)
        results[tag] = st
        if st:
            print(f"[var] {tag:<16} 横带均值={st['band_mean']:6.1f} "
                  f"横带暗像素={st['dark_pct']:5.1f}% "
                  f"亮%={st['bright_pct']:5.1f}%")
        else:
            print(f"[var] {tag:<16} 无有效像素")

    print("\n[var] === 汇总（横带亮像素越多 = 眼睛越清楚）===")
    best = sorted(results.items(),
                  key=lambda kv: -(kv[1]["bright_pct"] if kv[1] else -1))
    for tag, st in best:
        if st:
            print(f"   {tag:<16} 亮={st['bright_pct']:5.1f}%  "
                  f"暗={st['dark_pct']:5.1f}%")


if __name__ == "__main__":
    main()