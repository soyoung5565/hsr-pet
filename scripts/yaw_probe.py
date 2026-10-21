#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性诊断：把球棒狸按 0/90/180/270 度四个朝向各渲一帧。

用途：确定模型正面到底朝哪个轴。桌宠必须「脸对用户」，而实测不转的时候
拍到的是**背面**（只有爪印和背包）。

历史坑（上一版脚本踩的，别再踩）：
  1. **不能**在循环里反复 read_factory_settings + import_fbx —— 每次新建一套
     材质/图片，4 个角度跑下来直接 OOM（fatal error C9008）。解法：一次导入，
     只改 yaw 复用同一套资源。
  2. pivot 必须是**顶层**，mesh 直接挂它。若把 pivot 也挂到 armature 下面，
     pivot 与 mesh 成兄弟节点，转 pivot 对 mesh 完全无效（四张图像素级一样）。
  3. 归一化必须在**挂完父级之后**做，否则重挂父级会把 matrix_parent_inverse
     重置，归一化结果丢失（中心跑到 y=84.5）。
  4. 对中的平移是 **-c 不是 +c**。上一版把 `+c` 写进了第二段重复代码里，
     结果 90/180/270 三个朝向全渲成空帧，把第一段的好结果覆盖掉了 ——
     这就是「yaw_90/180/270 字节数完全相同且 alpha 全 0」的原因。
     **本版本只有一段渲染循环**，并在渲染后断言非空。
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy  # type: ignore  # noqa: E402
import mathutils  # type: ignore  # noqa: E402

_SAMPLES = [16]  # build_scene 要用，写成模块级避免传参穿来穿去


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--texture", required=True)
    p.add_argument("--eye-texture", default="")
    p.add_argument("--out", required=True)
    p.add_argument("--res", type=int, default=420)
    p.add_argument("--samples", type=int, default=16)
    p.add_argument("--axis-fix", type=float, default=90.0,
                   help="绕 X 轴预旋转（度）。w5_limao_00 是 Y-up：头顶=+Y，"
                        "Blender 屏幕上方=+Z，不转就拍到脚底。绕 X +90° 修正。")
    p.add_argument("--yaw", type=float, default=-1.0,
                   help="绕 Y 轴固定水平转向。-1 = 不指定，脚本自己扫六个面。")
    p.add_argument("--eye-cell", default="1,4,5",
                   help="眼睛 atlas 格子 row,colLeft,colRight（0基）。"
                        "row1/col4=左眼，row1/col5=右眼（互为镜像）。"
                        "★两个 UV 岛必须分开映射，压同一格会左右眼重叠糊脸。"
                        "传空字符串则不重映射")
    return p.parse_args(args=argv)


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


def build_scene(res):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene

    w = bpy.data.worlds.new("W")
    w.use_nodes = True
    sc.world = w

    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    cam.location = (0, -6, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = cam

    def area(n, l, e, sz, col):
        ld = bpy.data.lights.new(n, type="AREA")
        ld.energy, ld.size, ld.color = e, sz, col
        o = bpy.data.objects.new(n, ld)
        sc.collection.objects.link(o)
        o.location = l
        d = mathutils.Vector((0, 0, 0)) - o.location
        o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

    # 中性/暖白光。不要饱和色光：会触发桌宠的导引色清理（见素材规格第 3 节）
    area("K", (2, -3, 3), 1000, 3, (1, .97, .93))
    area("F", (-3, -2, 1), 400, 3.5, (.92, .95, 1))
    area("R", (0, 3, 2.4), 650, 2.5, (1, .95, .88))

    sc.render.engine = "CYCLES"
    sc.cycles.samples = _SAMPLES[0]
    sc.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = backend
            except TypeError:
                continue
            prefs.get_devices()
            if [d for d in prefs.devices if d.type != "CPU"]:
                for d in prefs.devices:
                    d.use = d.type != "CPU"
                sc.cycles.device = "GPU"
                print(f"[yaw] Cycles GPU = {backend}")
                break
    except Exception as e:  # noqa: BLE001
        print(f"[yaw] 用 CPU: {e}")

    sc.render.film_transparent = True
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    return cam, sc


def attach_materials(meshes, body_tex, eye_tex):
    """Eye 是独立 mesh，UV 范围与 Body 不同 → 必须挂各自的图，
    否则眼睛去 Body 图采样，脸会花成一片乱码（第一次渲染的真实故障）。"""
    def make(name, tex, rough):
        if not tex or not os.path.isfile(tex):
            return None
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        for link in list(nt.links):
            if link.to_socket.name == "Base Color":
                nt.links.remove(link)
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(tex)
        node.location = (-400, 300)
        nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = rough
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
        return m

    body_mat = make("Body", body_tex, 0.62)
    eye_mat = make("Eye", eye_tex, 0.35) or body_mat

    for o in meshes:
        o.data.materials.clear()
        if o.name.lower().startswith("eye") and eye_mat is not body_mat:
            o.data.materials.append(eye_mat)
            print(f"[yaw] {o.name} -> 眼睛贴图")
        elif body_mat is not None:
            o.data.materials.append(body_mat)
            print(f"[yaw] {o.name} -> 基础色贴图")


def remap_eye_uv(eye_obj, row: int, col_left: int, col_right: int | None = None,
                 grid_rows: int = 5, grid_cols: int = 8):
    """把 Eye mesh 的 UV 压到贴图 atlas 里的**单个格子**。

    ★ Eye 有**两个 UV 岛**（U<0.5 左眼 151 个 / U≥0.5 右眼 143 个），
    在图集里是互为镜像的一对（row1/col4=左眼，row1/col5=右眼）。
    压到同一格会让左右眼重叠打架 → 脸一片黑。两个岛必须分开映射。
    """
    uv_layer = eye_obj.data.uv_layers.active
    if uv_layer is None:
        print("[yaw] Eye 没有 UV 层，跳过重映射")
        return
    if col_right is None:
        col_right = col_left
    cw = 1.0 / grid_cols
    ch = 1.0 / grid_rows
    for loop in eye_obj.data.loops:
        u, v = uv_layer.data[loop.index].uv
        col = col_left if u < 0.5 else col_right
        _, lu = divmod(u, cw)   # 先折算到「所在格子」的局部 0..1
        _, lv = divmod(v, ch)
        uv_layer.data[loop.index].uv = ((col + min(lu, 1.0)) * cw,
                                        (row + min(lv, 1.0)) * ch)
    print(f"[yaw] Eye UV 重映射 -> row{row} 左眼col{col_left} 右眼col{col_right}")


def alpha_stats(path):
    """渲完立刻自检：空帧要当场炸出来，不能等下一次才发现。"""
    img = bpy.data.images.load(path)
    try:
        px = list(img.pixels)
        return sum(1 for i in range(3, len(px), 4) if px[i] > 0.01)
    finally:
        bpy.data.images.remove(img)


def main():
    global _SAMPLES
    args = parse_args()
    _SAMPLES[0] = args.samples
    os.makedirs(args.out, exist_ok=True)

    cam, sc = build_scene(args.res)
    bpy.ops.import_scene.fbx(filepath=args.model)
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name == "Cube":
            bpy.data.objects.remove(o, do_unlink=True)   # 调试立方体 bbox ±1
    ms = [o for o in bpy.data.objects
          if o.type == "MESH" and o.dimensions.length > 1e-6]
    arm = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    print(f"[yaw] mesh={len(ms)} armature={len(arm)}")

    # ── 变换链：先建 pivot 并把 mesh 挂上去，再归一化（顺序反了就丢结果）──
    pv = bpy.data.objects.new("P", None)
    sc.collection.objects.link(pv)
    for o in ms:
        o.parent = pv
        o.matrix_parent_inverse = mathutils.Matrix.Identity(4)
    for a in arm:
        a.location = (0, 0, 0)
        a.rotation_euler = (0, 0, 0)
    pv.location = (0, 0, 0)
    pv.rotation_euler = (0, 0, 0)
    pv.scale = (1, 1, 1)
    bpy.context.view_layer.update()

    # 世界空间对中：直接改 matrix_world，与父级状态无关（最不容易错）
    lo, hi = bb(ms)
    c = mathutils.Vector([(lo[i] + hi[i]) / 2.0 for i in range(3)])
    for o in ms:
        o.matrix_world = o.matrix_world @ mathutils.Matrix.Translation(-c)
    bpy.context.view_layer.update()

    # 缩放到「高度 1.0」。此时 pivot 原点 == 角色几何中心，绕它转不会甩出去。
    lo, hi = bb(ms)
    pv.scale = (1.0 / max(1e-9, hi[2] - lo[2]),) * 3
    bpy.context.view_layer.update()

    lo, hi = bb(ms)
    size = [hi[i] - lo[i] for i in range(3)]
    ctr = [(lo[i] + hi[i]) / 2.0 for i in range(3)]
    print(f"[yaw] 归一化 scale={pv.scale[0]:.4f} "
          f"size={tuple(round(v, 4) for v in size)} "
          f"center={tuple(round(v, 4) for v in ctr)}")
    if max(abs(v) for v in ctr) > 1e-3:
        print(f"[yaw] ⚠ 中心未对到原点 |max|={max(abs(v) for v in ctr):.5f}，构图会偏")
    cam.data.ortho_scale = max(size) * 1.30

    attach_materials(ms, args.texture, args.eye_texture)

    # 看脸的前提：眼睛 UV 必须压到「正常睁眼」那一格，否则正面也认不出是脸
    if args.eye_cell:
        parts = [int(v) for v in args.eye_cell.split(",")]
        if len(parts) == 3:
            r, cl, cr = parts
        else:
            r, cl, cr = parts[0], parts[1], parts[1]
        for o in ms:
            if o.name.lower().startswith("eye"):
                remap_eye_uv(o, r, cl, cr)

    # ── 轴向修正：把模型的头顶转到 Blender 的 +Z ──────────────────
    # 实测 w5_limao_00 是 Y-up（头顶=+Y），Blender 屏幕上方是 +Z。
    # 不修正的话相机拍到的是脚底 —— 这是第一版废掉的真正原因，
    # 而当时只用 yaw（绕Z）扫了四个侧面，**从来没验证过"上"是哪个轴**。
    axis_fix = math.radians(args.axis_fix)
    pv.rotation_euler = (axis_fix, 0.0, 0.0)
    bpy.context.view_layer.update()
    lo, hi = bb(ms)
    dx, dy, dz = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]
    print(f"[yaw] axis-fix={args.axis_fix}°（绕X）→ "
          f"尺寸 X={dx:.3f} Y={dy:.3f} Z={dz:.3f}")
    print(f"[yaw] 原模型最高维度={max(dx, dy, dz):.3f}；"
          f"转完后最高维度={'Z(头顶朝上 ✓)' if dz >= max(dx, dy) else '不是Z → 轴向仍不对'}")
    cam.data.ortho_scale = max(dx, dy, dz) * 1.30

    # ── 六面体探测：前后左右 + 顶视 + 底视 ─────────────────────────
    # 相机固定在 (0,-6,0) 看向原点（正脸方向），
    # 只改 pivot 的水平转向。顶/底另用俯仰角单独渲两张，用于确认轴向。
    shots = []
    if args.yaw >= 0:
        shots = [("fixed", args.yaw)]
    else:
        shots = [("front_0", 0), ("right_90", 90), ("back_180", 180), ("left_270", 270)]

    results = []
    for tag, yaw in shots:
        pv.rotation_euler = (axis_fix, 0.0, math.radians(yaw))
        bpy.context.view_layer.update()
        path = os.path.join(args.out, f"face_{tag}.png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        n = alpha_stats(path)
        print(f"[yaw] {tag} ({yaw}°) -> {path}  非空像素={n}")
        results.append((tag, n))

    # 俯视/仰视：临时把相机搬到 +Z / -Z 拍一眼，确认「上」确实是 Z
    cam.rotation_euler = (0.0, 0.0, 0.0)          # 从 +Z 往下看
    cam.location = (0.0, 0.0, 6.0)
    pv.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    top_path = os.path.join(args.out, "axis_top.png")
    sc.render.filepath = top_path
    bpy.ops.render.render(write_still=True)
    print(f"[yaw] 顶视(从+Z往下看) -> {top_path}  非空像素={alpha_stats(top_path)}")

    cam.rotation_euler = (math.radians(180), 0.0, 0.0)  # 从 -Z 往上看
    cam.location = (0.0, 0.0, -6.0)
    bpy.context.view_layer.update()
    bot_path = os.path.join(args.out, "axis_bottom.png")
    sc.render.filepath = bot_path
    bpy.ops.render.render(write_still=True)
    print(f"[yaw] 底视(从-Z往上看) -> {bot_path}  非空像素={alpha_stats(bot_path)}")

    empty = [t for t, n in results if n == 0]
    if empty:
        raise SystemExit(f"❌ 朝向 {empty} 渲染成空帧 —— 构图/对中有 bug，别看图，先修")
    print(f"[yaw] ✅ {len(results)} 个朝向全部非空；"
          f"看图确认哪个是脸，再决定 --yaw")


if __name__ == "__main__":
    main()