#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Blender 批渲染：把提取出来的随宠模型渲染成桌宠精灵表所需的 72 帧 PNG。

设计要点（都是踩过/查过源码才这么定的）：

1. **透明背景**：film_transparent=True，直接出 alpha，不要靠删背景色。
2. **固定正交机位**：正交投影（orthographic）避免透视缩放，桌宠放大时
   角色比例才不会变；相机固定不动，只动角色（旋转/位移/缩放）。
3. **构图留白**：192x208 的格子对角色来说上下很挤，所以把角色渲染到
   方形画布居中，再由 build_sheet.py 等比贴进 192x208。
   → Blender 直接渲 1024x1024，build_sheet 再缩。
4. **动作映射**：9 行固定语义。这里把每行映射到「角色姿态 + 相机/位移」。
   真正的游戏骨骼动画要在提取阶段拿 AnimationClip 导进来再驱动，
   拿不到时先用姿态关键帧近似（见 POSE_TABLE）。

用法：
  blender -b pet.blend -P render_pet.py -- \\
      --out "E:\\hsr-pet-extract\\render" --res 1024 --samples 64

参数说明：
  --out      渲染输出根目录，会自动建 row0..row8 子目录
  --res      单帧分辨率（正方形），默认 1024
  --samples  Cycles 采样数，默认 64（桌宠素材不需要很高）
  --engine   cycles | eevee，默认 cycles（有 GPU 就更快）
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy  # type: ignore  # noqa: E402  (Blender 内置)

# 9 行固定语义，顺序必须和 build_sheet.py / Desktop-pet 契约一致
ROW_NAMES = [
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review",
]
ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6]


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--res", type=int, default=1024)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--engine", default="cycles", choices=["cycles", "eevee"])
    p.add_argument("--fbx", default="", help="可选：待导入的 FBX 路径")
    return p.parse_args(args=argv)


# ---------------------------------------------------------------- 场景搭建
def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def look_at(obj, target=(0.0, 0.0, 0.0)) -> None:
    """把 obj 的 -Z 轴对准 target（相机用）。"""
    import mathutils
    direction = mathutils.Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def model_bbox_center(objects: list) -> tuple:
    """返回所有 mesh 联合包围盒的中心（世界坐标）。"""
    import mathutils
    meshes = [o for o in objects if o.type == "MESH"]
    if not meshes:
        return (0.0, 0.0, 0.5)
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in meshes:
        mw = o.matrix_world
        for corner in o.bound_box:
            w = mw @ mathutils.Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return ((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0)


def setup_camera_framing(objects: list) -> None:
    """把相机对准模型包围盒中心，并按模型尺寸设定正交缩放。

    为什么必须这么做：桌宠渲染器只用**格子中心 8×8** 采样判「这帧非空」。
    角色如果偏心（哪怕只偏出中心十几像素），那一帧会被直接当成空帧丢弃。
    所以「角色几何中心 == 画面中心」是硬约束，不是审美问题。
    """
    cam = bpy.context.scene.camera
    if cam is None or not objects:
        return
    center = model_bbox_center(objects)
    cam.location = (center[0], center[1] - 6.0, center[2])
    look_at(cam, center)

    # 正交缩放：模型高度留 25% 余量，跳跃动作才不会被裁掉
    import mathutils
    meshes = [o for o in objects if o.type == "MESH"]
    if meshes:
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for o in meshes:
            mw = o.matrix_world
            for corner in o.bound_box:
                w = mw @ mathutils.Vector(corner)
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
        h = max(1e-6, hi[2] - lo[2])
        wdt = max(1e-6, hi[0] - lo[0])
        cam.data.ortho_scale = max(h, wdt) * 1.25
    print(f"[render] 相机构图: 中心={tuple(round(v, 3) for v in center)}, "
          f"ortho_scale={cam.data.ortho_scale:.3f}")


def setup_world_and_camera(res: int) -> bpy.types.Object:
    """透明世界 + 正交相机。相机位置/缩放随后由 setup_camera_framing 精调。"""
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    bpy.context.scene.world = world

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    # 正交缩放略大于角色高度，给跳跃动作留空间
    cam_data.ortho_scale = 2.6
    cam = bpy.data.objects.new("Camera", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = (0.0, -6.0, 1.05)
    look_at(cam, (0.0, 0.0, 1.0))
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True          # 关键：透明背景
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    return cam


def setup_lights() -> None:
    """三点光 + 一点补光，保证角色轮廓清楚、颜色接近游戏原色。

    注意：不要用纯饱和蓝/绿/品红的光，会触发桌宠渲染器的导引色清理。
    """
    def area(name, loc, energy, size, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, type="AREA")
        ld.energy = energy
        ld.size = size
        ld.color = color
        o = bpy.data.objects.new(name, ld)
        bpy.context.scene.collection.objects.link(o)
        o.location = loc
        look_at(o, (0, 0, 1))
        return o

    area("Key", (2.4, -3.0, 3.2), 900, 3.0, (1.0, 0.97, 0.92))
    area("Fill", (-3.0, -2.0, 1.6), 380, 3.5, (0.88, 0.93, 1.0))
    area("Rim", (0.0, 3.2, 2.6), 620, 2.5, (1.0, 0.95, 0.88))
    area("Bounce", (0.0, -1.6, -0.4), 140, 3.0, (1.0, 1.0, 1.0))


def setup_render(args: argparse.Namespace) -> None:
    scene = bpy.context.scene
    if args.engine == "cycles":
        scene.render.engine = "CYCLES"
        scene.cycles.samples = args.samples
        scene.cycles.use_denoising = True
        scene.cycles.film_transparent_glass = True
        # 有 GPU 就用 GPU，别让 CPU 慢慢磨
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = backend
                except TypeError:
                    continue
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type != "CPU"]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type != "CPU"
                    scene.cycles.device = "GPU"
                    print(f"[render] Cycles GPU backend = {backend}")
                    break
        except Exception as e:  # noqa: BLE001
            print(f"[render] GPU 检测失败，退回 CPU: {e}")
    else:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
        try:
            scene.eevee.taa_render_samples = args.samples
        except AttributeError:
            pass


def import_model(fbx_path: str) -> list:
    if not fbx_path:
        # 占位体：用**藏青**而不是默认灰。
        # 两个原因：(1) 浅灰在浅色背景上几乎看不见；
        #         (2) 随宠本身就是藏青+金配色，占位体顺便验证这个配色安全。
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
        obj = bpy.context.active_object
        mat = bpy.data.materials.new("PlaceholderNavy")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.11, 0.13, 0.27, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.45
        obj.data.materials.append(mat)
        return [obj]
    ext = os.path.splitext(fbx_path)[1].lower()
    before = set(bpy.data.objects)
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=fbx_path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=fbx_path)
    elif ext == ".glb" or ext == ".gltf":
        bpy.ops.import_scene.gltf(filepath=fbx_path)
    else:
        raise SystemExit(f"不支持的模型格式: {ext}")
    new = [o for o in bpy.data.objects if o not in before]
    print(f"[render] 导入 {len(new)} 个对象 from {os.path.basename(fbx_path)}")
    return new


def normalize_scale(objects: list) -> None:
    """把所有 mesh 缩放到统一高度并落到世界原点，方便固定机位构图。

    桌宠格子是固定尺寸的，模型原始尺度差几十倍都很正常，
    所以必须在这里统一，否则每只宠物都要重新调相机。

    约定：Blender 是 Z 轴朝上，所以「高度」用 Z，落地用 Z。
    横向(X)/纵深(Y) 居中。
    """
    import mathutils

    meshes = [o for o in objects if o.type == "MESH"]
    if not meshes:
        return
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    # 用所有 mesh 的联合包围盒算范围（bound_box 是物体局部坐标）
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in meshes:
        mw = o.matrix_world
        for corner in o.bound_box:
            w = mw @ mathutils.Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])

    height = max(1e-6, hi[2] - lo[2])
    target_h = 1.0
    s = target_h / height

    # 绕物体自身中心缩放（operator 会以 selection 中枢为基准）
    bpy.ops.transform.resize(value=(s, s, s))
    bpy.context.view_layer.update()

    # 缩放后把包围盒移到「水平居中 + 站在 Z=0 地面上」
    lo2 = [1e9] * 3
    hi2 = [-1e9] * 3
    for o in meshes:
        mw = o.matrix_world
        for corner in o.bound_box:
            w = mw @ mathutils.Vector(corner)
            for i in range(3):
                lo2[i] = min(lo2[i], w[i])
                hi2[i] = max(hi2[i], w[i])
    shift = mathutils.Vector((
        -(lo2[0] + hi2[0]) / 2.0,     # X 居中
        -(lo2[1] + hi2[1]) / 2.0,     # Y 居中
        -lo2[2],                      # 底面贴地
    ))
    for o in meshes:
        o.location = o.location + shift

    print(f"[render] 归一化: 原高度 {height:.3f} -> {target_h} (scale {s:.4f}), "
          f"底面已贴 Z=0")


# ---------------------------------------------------------------- 姿态表演
def pose_for(row: int, i: int, n: int) -> dict:
    """返回第 row 行第 i 帧的角色姿态参数。

    这是「没有骨骼动画时的近似表演」。真正的游戏动画应该从提取出的
    AnimationClip 驱动；这里保证动作语义对得上、且帧与帧之间连续。

    关键约束：**姿态以角色「身高中心」为支点，不是脚底**。
    因为桌宠渲染器靠「格子中心 8x8 有像素」判非空，一旦角色整体下沉
    或缩小到偏离中心，那一帧就会被当成空帧丢掉（实测 row5/row7 全被判空）。
    所以这里的 loc_z / lean 都只是小幅摆动，不会把身体推出画面中心。
    """
    t = i / max(1, n - 1) if n > 1 else 0.0
    p = {"rot_z": 0.0, "loc_x": 0.0, "loc_z": 0.0, "scale": 1.0, "lean": 0.0}

    if row == 0:                                   # idle：轻微呼吸
        p["scale"] = 1.0 + 0.022 * math.sin(t * math.tau)
    elif row in (1, 2):                            # running：位移 + 起伏 + 摆动
        d = 1 if row == 1 else -1
        # 横向摆动只作小幅（±0.12 单位 ≈ ±18px）：既能读出走路位移，
        # 又不会把身体挪出中心 8×8 采样区（身体半宽约 77px，很宽裕）。
        p["rot_z"] = d * (0.12 + 0.13 * math.sin(t * math.tau * 2))
        p["loc_x"] = d * 0.12 * math.sin(t * math.tau)
        p["loc_z"] = 0.085 * abs(math.sin(t * math.tau))  # 上下起伏要看得见
        p["lean"] = d * (0.10 + 0.10 * math.sin(t * math.tau * 2))
    elif row == 3:                                 # waving：招手
        p["rot_z"] = 0.16 * math.sin(t * math.tau * 1.5)
        p["loc_z"] = 0.035 * abs(math.sin(t * math.tau * 1.5))
        p["lean"] = 0.06
    elif row == 4:                                 # jumping：抛物线
        # 跳跃幅度必须**小**。渲染器只采样格子中心 8×8（不足 1/500 画面），
        # 角色一旦跳得太高，腾空那一帧的中心就没像素 → 被当成空帧丢掉。
        # 所以用「小幅上移 + 拉伸 + 前倾」表达跳跃，而不是真的大抛物线。
        p["loc_z"] = 0.16 * math.sin(t * math.pi)
        p["scale"] = 1.0 + 0.07 * math.sin(t * math.pi)
        p["lean"] = 0.10 * math.sin(t * math.tau)
    elif row == 5:                                 # failed：蔫下去（缩+前倾，不下沉）
        # 逐帧递增的缩小 + 倾斜，末帧最明显（约缩 22% / 歪 30°）。
        # loc_z 同步上抬做补偿，防止缩小后重心下移导致中心采样落空。
        k = t * t * (3 - 2 * t)      # smoothstep，渐变更自然
        p["scale"] = 1.0 - 0.22 * k
        p["lean"] = -0.52 * k
        p["rot_z"] = 0.30 * k
        p["loc_z"] = 0.09 * k
    elif row == 6:                                 # waiting：无聊地晃
        p["rot_z"] = 0.07 * math.sin(t * math.tau * 0.8)
        p["loc_z"] = 0.03 * math.sin(t * math.tau * 0.8)
    elif row == 7:                                 # running(忙)：专注前倾（不提脚）
        p["lean"] = 0.22
        p["rot_z"] = 0.05 * math.sin(t * math.tau * 2)
        p["loc_z"] = 0.02
    elif row == 8:                                 # review(讲话)：说话起伏
        p["scale"] = 1.0 + 0.03 * abs(math.sin(t * math.tau * 3))
        p["loc_z"] = 0.03 * abs(math.sin(t * math.tau * 3))
        p["rot_z"] = 0.06 * math.sin(t * math.tau)
    return p


def apply_pose(pivot, base_loc, p: dict) -> None:
    pivot.location = (base_loc[0], base_loc[1], base_loc[2] + p["loc_z"])
    pivot.rotation_euler = (
        math.radians(p["lean"]),   # 绕 X 前倾/后仰
        0.0,
        math.radians(p["rot_z"]),   # 绕 Z 左右摆
    )
    s = p["scale"]
    pivot.scale = (s, s, s)


# ---------------------------------------------------------------- 主流程
def main() -> None:
    args = parse_args()
    reset_scene()
    setup_world_and_camera(args.res)
    setup_lights()
    setup_render(args)

    objects = import_model(args.fbx)
    normalize_scale(objects)

    # 把模型整体挂到一个空物体上，表演时只动它（比逐帧改 mesh 稳）
    pivot = bpy.data.objects.new("PetPivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    for o in objects:
        if o.parent is None:
            o.parent = pivot
    # 支点放在「身高中心」而不是原点：normalize_scale 后模型底面在 Z=0、
    # 顶面在 Z=1，所以支点抬到 Z=0.5。这样旋转/缩放时身体绕中心摆，
    # 不会整体飘出画面（桌宠靠格子中心 8x8 判非空，偏离中心就丢帧）。
    pivot.location = (0.0, 0.0, 0.5)
    bpy.context.view_layer.update()
    base_loc = tuple(pivot.location)

    # 把相机对准模型中心（渲染器只采样格子中心 8×8，偏心就丢帧）
    setup_camera_framing(objects)

    total = 0
    for row in range(9):
        d = os.path.join(args.out, f"row{row}")
        os.makedirs(d, exist_ok=True)
        for i in range(ROW_FRAMES[row]):
            apply_pose(pivot, base_loc, pose_for(row, i, ROW_FRAMES[row]))
            bpy.context.view_layer.update()
            path = os.path.join(d, f"{i:02d}.png")
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            total += 1
        print(f"[render] row{row} {ROW_NAMES[row]:<14} {ROW_FRAMES[row]} 帧 -> {d}")

    print(f"[render] 完成，共 {total} 帧 -> {args.out}")
    print(f"[render] 下一步: python scripts/build_sheet.py \"{args.out}\" -o sheet.webp")


if __name__ == "__main__":
    main()