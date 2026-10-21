#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Blender 批渲染 v2：用**游戏里真实的动画 clip** 驱动随宠出精灵表。

v1（render_pet.py）用程序编的近似姿态表演，动作语义对但没有游戏味道。
v2 改成直接吃 AnimeStudio 导出的 AnimationClip FBX —— 那才是官方动作。

桌面宠物 9 行 → 球棒狸 clip 映射（见 docs/球棒狸资源定位.md）：
    0 idle          <- adv_ani_mazestandby   随宠待机
    1 running-right <- adv_ani_mazewalk      随宠行走
    2 running-left  <- adv_ani_mazewalk      同一 clip，水平镜像
    3 waving        <- adv_ani_shakehand     挥手打招呼
    4 jumping       <- adv_ani_mazerun       跑动
    5 failed        <- adv_ani_kneelloop     跪坐循环＝蔫了/难过
    6 waiting       <- adv_ani_standby02     站立待机2
    7 running       <- adv_ani_mazestandby   待机当"在思考"
    8 review        <- adv_ani_photo         拍照＝互动/说话

用法：
  blender -b --factory-startup -P render_pet_anim.py -- \\
      --model  "E:\\...\\monster_w5_limao_00_model.fbx" \\
      --anims  "E:\\...\\animation" \\
      --out    "E:\\hsr-pet-extract\\render_limao" \\
      --res 1024 --samples 64 --engine cycles

关键约束（源码级硬要求，违反就丢帧）：
  * 渲染器只用**格子中心 8×8** 判「这帧非空」→ 角色几何中心必须对画面中心。
  * 高饱和青/绿/品红/蓝（通道极差 > 70）会被清成透明 → 灯光别用纯色光，
    贴图里的亮蓝也要在 build_sheet.py 里被拦下。
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

import bpy  # type: ignore  # noqa: E402

ROW_NAMES = [
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review",
]
ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6]

# 行 → clip 关键字（大小写不敏感子串匹配，先命中先用）
ROW_CLIP = [
    "mazestandby",   # 0 idle
    "mazewalk",      # 1 running-right
    "mazewalk",      # 2 running-left（镜像）
    "shakehand",     # 3 waving
    "mazerun",       # 4 jumping
    "kneelloop",     # 5 failed
    "standby02",     # 6 waiting
    "mazestandby",   # 7 running
    "photo",         # 8 review
]
# 同一 clip 被多行复用时的优先级：优先 adv_ani（随宠专用）版本
PREFER = ["adv_ani_maze", "adv_ani", "ani_"]


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--anims", default="", help="动画 FBX 所在目录")
    p.add_argument("--out", required=True)
    p.add_argument("--res", type=int, default=1024)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--engine", default="cycles", choices=["cycles", "eevee"])
    p.add_argument("--flip-left", action="store_true", default=True,
                   help="左移行是否水平镜像（默认开）")
    return p.parse_args(args=argv)


# ---------------------------------------------------------------- 工具
def look_at(obj, target) -> None:
    import mathutils
    d = mathutils.Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def bbox_center_and_size(objects):
    import mathutils
    meshes = [o for o in objects if o.type == "MESH"]
    if not meshes:
        return (0, 0, 0.5), (1, 1, 1)
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in meshes:
        mw = o.matrix_world
        for c in o.bound_box:
            w = mw @ mathutils.Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    center = tuple((lo[i] + hi[i]) / 2 for i in range(3))
    size = tuple(max(1e-6, hi[i] - lo[i]) for i in range(3))
    return center, size


# ---------------------------------------------------------------- 场景
def setup_scene(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)

    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0, 0, 0, 1)
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = world

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("Camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    scene.render.resolution_x = args.res
    scene.render.resolution_y = args.res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True          # 透明背景
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"

    # 三点光：全部中性偏暖白，**不用**饱和色光（会触发导引色清理）
    def area(name, loc, energy, size, color):
        ld = bpy.data.lights.new(name, type="AREA")
        ld.energy = energy
        ld.size = size
        ld.color = color
        o = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(o)
        o.location = loc
        look_at(o, (0, 0, 0.5))
        return o

    area("Key", (2.2, -3.0, 3.0), 1100, 3.0, (1.0, 0.97, 0.93))
    area("Fill", (-3.0, -2.2, 1.4), 420, 3.5, (0.92, 0.95, 1.0))
    area("Rim", (0.2, 3.2, 2.4), 700, 2.5, (1.0, 0.95, 0.88))
    area("Bounce", (0.0, -1.8, -0.3), 180, 3.0, (1.0, 1.0, 1.0))

    if args.engine == "cycles":
        scene.render.engine = "CYCLES"
        scene.cycles.samples = args.samples
        scene.cycles.use_denoising = True
        scene.cycles.film_transparent_glass = True
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
                    scene.cycles.device = "GPU"
                    print(f"[render] Cycles GPU = {backend}")
                    break
        except Exception as e:  # noqa: BLE001
            print(f"[render] GPU 不可用，用 CPU: {e}")
    else:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    return cam


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=True)
    return [o for o in bpy.data.objects if o not in before]


# ---------------------------------------------------------------- 动画
def find_clip(anim_dir: str, keyword: str):
    """在动画目录里挑最匹配 keyword 的 FBX。

    优先级：先按 PREFER 里的前缀模式（adv_ani_maze > adv_ani > ani_），
    再按文件名排序保证可复现。
    """
    if not anim_dir or not os.path.isdir(anim_dir):
        return None
    files = glob.glob(os.path.join(anim_dir, "*.fbx"))
    if not files:
        files = glob.glob(os.path.join(anim_dir, "**", "*.fbx"), recursive=True)
    kw = keyword.lower()
    cands = [f for f in files if kw in os.path.basename(f).lower()]
    if not cands:
        return None

    def rank(path):
        name = os.path.basename(path).lower()
        for i, pref in enumerate(PREFER):
            if pref in name:
                return i
        return len(PREFER)

    cands.sort(key=lambda p: (rank(p), os.path.basename(p)))
    return cands[0]


def action_frame_range(action):
    """返回 (first, last) 帧范围。不同 Blender 版本 API 名不一样。"""
    if hasattr(action, "frame_range"):
        fr = tuple(action.frame_range)
        return fr[0], fr[1]
    return 0.0, 30.0


def sample_action(action, frame: float) -> None:
    """把 action 的某一帧写入场景。"""
    try:
        bpy.context.scene.frame_set(int(round(frame)))
    except Exception:
        pass


# ---------------------------------------------------------------- 主流程
def main() -> None:
    args = parse_args()
    print(f"[render] 模型: {args.model}")
    cam = setup_scene(args)

    # 1) 导模型
    model_objs = import_fbx(args.model)
    meshes = [o for o in model_objs if o.type == "MESH"]
    armatures = [o for o in model_objs if o.type == "ARMATURE"]
    print(f"[render] 模型导入: mesh={len(meshes)} armature={len(armatures)}")
    if not meshes:
        raise SystemExit("模型里没有 mesh，检查 FBX 是否正确导出")

    # 2) 归一化：统一到高 1.0、底面贴 Z=0、X/Y 居中
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    center, size = bbox_center_and_size(meshes)
    s = 1.0 / size[2]
    bpy.ops.transform.resize(value=(s, s, s))
    bpy.context.view_layer.update()
    center, size = bbox_center_and_size(meshes)
    import mathutils
    shift = mathutils.Vector((-center[0], -center[1], -bbox_center_and_size(meshes)[0][2]
                              + size[2] / 2.0))
    # 让「几何中心」落在 Z=0.5（桌宠画面中心），底面则在 Z=0 附近
    for o in meshes:
        o.location = o.location + shift
    bpy.context.view_layer.update()
    center, size = bbox_center_and_size(meshes)
    print(f"[render] 归一化: size={tuple(round(v,3) for v in size)} "
          f"center={tuple(round(v,3) for v in center)}")

    # 3) 相机对准几何中心（中心 8×8 判非空的硬要求）
    cam.location = (center[0], center[1] - 6.0, center[2])
    look_at(cam, center)
    cam.data.ortho_scale = max(size[0], size[1], size[2]) * 1.3
    print(f"[render] 相机: center={tuple(round(v,3) for v in center)} "
          f"ortho={cam.data.ortho_scale:.3f}")

    # 4) 准备 pivot（左移行镜像靠它）
    pivot = bpy.data.objects.new("PetPivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    for o in model_objs:
        if o.parent is None:
            o.parent = pivot
    pivot.location = (0, 0, center[2])
    bpy.context.view_layer.update()

    # 5) 逐行渲染
    used_actions: dict[str, object] = {}
    total = 0
    for row in range(9):
        d = os.path.join(args.out, f"row{row}")
        os.makedirs(d, exist_ok=True)
        kw = ROW_CLIP[row]
        clip = find_clip(args.anims, kw)
        mirror = (row == 2 and args.flip_left)

        if clip and clip not in used_actions:
            # 导入动画 FBX：只保留它的 action，不保留里面的 mesh
            tmp = import_fbx(clip)
            for o in tmp:
                if o.type == "MESH":
                    bpy.data.objects.remove(o, do_unlink=True)
            tmp_act = bpy.data.actions.get(os.path.splitext(os.path.basename(clip))[0])
            if tmp_act is None and tmp:
                for o in tmp:
                    if o.animation_data and o.animation_data.action:
                        tmp_act = o.animation_data.action
                        break
            if tmp_act is not None:
                used_actions[clip] = tmp_act
            print(f"[render] clip[{kw}] <- {os.path.basename(clip)} "
                  f"frames={action_frame_range(tmp_act) if tmp_act else '?'}")

        act = used_actions.get(clip) if clip else None
        pivot.scale = (-1, 1, 1) if mirror else (1, 1, 1)

        for i in range(ROW_FRAMES[row]):
            if act:
                f0, f1 = action_frame_range(act)
                # 在 clip 区间内均匀取 N 帧；避开首尾各 4%（首尾常是姿势过渡）
                span = max(1e-3, f1 - f0)
                a, b = f0 + span * 0.04, f0 + span * 0.96
                t = i / max(1, ROW_FRAMES[row] - 1)
                sample_action(act, a + (b - a) * t)
            else:
                sample_action(act if act else None, 0)

            bpy.context.view_layer.update()
            path = os.path.join(d, f"{i:02d}.png")
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            total += 1

        print(f"[render] row{row} {ROW_NAMES[row]:<14} "
              f"{ROW_FRAMES[row]} 帧  clip={os.path.basename(clip) if clip else 'NONE'}"
              f"{'  [镜像]' if mirror else ''}")

    print(f"[render] 完成 {total} 帧 -> {args.out}")
    print(f"[render] 下一步: python scripts/build_sheet.py \"{args.out}\" -o sheet.webp")


if __name__ == "__main__":
    main()