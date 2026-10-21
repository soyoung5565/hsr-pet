#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""渲染球棒狸真实模型 → 桌宠精灵表 9 行。

与 render_pet_anim.py 的区别：
  * 这个脚本**只用模型 + 程序姿态**（因为 AnimeStudio 当前版本导不出 AnimationClip，
    见 docs/球棒狸资源定位.md 的说明）；
  * 姿态仍然是「身体摆动」，不依赖骨骼动画，所以 90 根骨头用不上（但保留，
    因为模型是带骨架的，将来能直接接真 clip）。

已踩过的坑（都写在这里了）：
  1. `bpy.data.images.load()` 返回的 Image **没有 use_nodes 属性**（Blender 4.2），
     要用 `nodes.new('ShaderNodeTexImage')` 手动建纹理节点再连线。
  2. 模型里混着一个 `Cube`（调试用占位立方体，bbox ±1），
     归一化前不删会把整只角色压成一个小点。
  3. 多个 mesh 各贴一张 2048² 图会占爆显存；共用一张图 + 一个材质即可
     （Eye/Photo 除外，它们用 Body 图只是近似，后面要换成各自的图）。
  4. **相机构图**：桌宠渲染器只用格子中心 8×8 判非空 →
     相机必须正对角色几何中心，ortho_scale 要留够余量，
     否则跳跃帧会因角色上移而被判空帧（实测 row4 曾整帧丢失）。

用法：
  blender -b --factory-startup -P render_limao.py -- \\
      --model "E:\\...\\Monster_W5_Limao_00_Model.fbx" \\
      --texture "E:\\...\\Monster_W5_Limao_00_Body_Color_A.png" \\
      --out "E:\\hsr-pet-extract\\render_limao" --res 1024 --engine cycles
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy  # type: ignore  # noqa: E402
import mathutils  # type: ignore  # noqa: E402

ROW_NAMES = [
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review",
]
ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--texture", default="")
    p.add_argument("--eye-texture", default="")
    p.add_argument("--eye-cell", default="1,4,5",
                   help="眼睛 atlas 里的格子 row,colLeft,colRight（0 基）。\n"
                        "视觉核对：第2行(=row1)第5格(=col4)是左眼白球黑瞳，"
                        "第6格(=col5)是右眼为其镜像。\n"
                        "★两个 UV 岛必须给不同列，压同一格会让左右眼重叠糊脸。\n"
                        "传空字符串则不重映射")
    p.add_argument("--out", required=True)
    p.add_argument("--res", type=int, default=1024)
    p.add_argument("--samples", type=int, default=48)
    p.add_argument("--engine", default="cycles", choices=["cycles", "eevee"])
    p.add_argument("--margin", type=float, default=1.30,
                   help="相机正交范围 = 角色最大边 × 该系数。"
                        "越大角色越小、动作位移余量越多（1.25~1.45 合理）")
    p.add_argument("--axis-fix", type=float, default=90.0,
                   help="绕 X 轴预旋转多少度（度）。★必须项，不是可选调参。\n"
                        "★实测 w5_limao_00 的轴向（两条硬证据）：\n"
                        "  1. 头顶 = +Y：Eye 顶点 Y=0.813~1.142，贴着 Body 的 Y 上限 1.313\n"
                        "     → 模型是 **Y-up**，而 Blender 屏幕上方是 +Z\n"
                        "  2. 脸朝 = +Z：Eye 顶点 Z=0.075~0.329，全落在 Body Z 的正半边\n"
                        "     （Body Z 跨 -0.553..0.553，中心≈0）\n"
                        "  相机在 (0,-6,0) 朝 +Y 看。用旋转矩阵验证过：\n"
                        "     **rx=90, ry=0, rz=0 一次就同时满足**「头顶+Y→+Z」且「脸+Z→-Y(相机)」，\n"
                        "     不需要再绕 Z（我一度以为要两轴，矩阵算完是错的）。\n"
                        "  不转的话相机拍到的是脚底 —— 这是第一版废掉的真正原因。")
    p.add_argument("--yaw", type=float, default=0.0,
                   help="绕 **Y** 轴（Blender 竖直轴）水平转向，度。\n"
                        "★axis-fix 之后头顶朝 +Z，所以水平转向必须绕 Y（绕 Z 会躺着翻跟头）。\n"
                        "yaw=0 即正脸（相机在 -Y）。")
    p.add_argument("--val", type=float, default=1.0,
                   help="明度倍率（1.0=原样）。\n"
                        "⚠ 实测调参已经到顶了，别再往这条路上加码（2026-10-12）：\n"
                        "  游戏截图目标  均色 135/89/64  饱和 0.545  明度 0.529\n"
                        "  原样输出       均色 187/179/171 饱和 0.081  明度 0.733\n"
                        "  --sat 5 --val 0.60 → 均色 174/155/129 饱和 0.253 明度 0.684\n"
                        "**根本原因：Body_Color_A 贴图自身饱和只有 0.181**，"
                        "HueSaturation 节点在该基础上拉不到 0.545。\n"
                        "→ 差距不在灯光/参数，而在**贴图选错或缺 Ramp 分层**"
                        "（游戏材质 JSON 里有 _DiffuseRampMultiTex / _DiffuseCoolRampMultiTex /\n"
                        "  _LightMap / Warm_Ramp / Cool_Ramp，我只用了最基础的 Color_A）。\n"
                        "要真正对齐游戏观感，必须把 shader 的多层还原出来，不能靠调色硬凑。")
    p.add_argument("--sat", type=float, default=1.0,
                   help="基础色贴图饱和度倍率（1.0 = 原样）。\n"
                        "★对齐游戏内截图用的（2026-10-12 实测）：\n"
                        "  游戏参考图  饱和 0.138 / 明度 0.557 / 均色 142/134/126\n"
                        "  原样输出    饱和 0.098 / 明度 0.659 / 均色 168/160/152\n"
                        "→ 明度已达标，差在饱和。1.0 是原样；往上调才能补到 0.138 附近。\n"
                        "注意：饱和度和明度不完全独立，提饱和通常也会带一点提亮，\n"
                        "所以最终值要重渲后按上面三个指标复核，别拍脑袋。")
    p.add_argument("--cam-pitch", type=float, default=30.0,
                   help="相机俯仰角（度）。0=平视，90=正俯视。\n"
                        "★用户指定 **轻微俯视 20~35°**（能略微看到头顶，"
                        "桌宠贴桌面时最自然的观感）。\n"
                        "参考图是正脸偏上视角；我一度改成 65° 属于误读，已改回。\n"
                        "相机位置按此角算：\n"
                        "  loc  = (0, -D·cos(pitch), D·sin(pitch))\n"
                        "  rotX = 90° - pitch\n"
                        "（Blender 相机默认看向 -Z，所以 rotX=90 时正好水平朝 +Y 看）")
    p.add_argument("--eye-offset", type=float, default=0.0,
                   help="把 Eye mesh 沿脸朝向(+Z)推出的距离。默认 0 = 不推。\n"
                        "★实测结论：**推了也没用，别动它**（2026-10-12 核查）。\n"
                        "逐高度剖面（Body 前表面 Z vs Eye 该高度 max Z）：\n"
                        "  Y 0.813~0.95  Eye 被埋 0.02~0.13（贴片下半段本就该藏皮下）\n"
                        "  Y 0.96 ~1.01  Eye 天然凸出 0.001~0.04\n"
                        "  Y 1.01 ~1.14  Eye 又被埋 0.07~0.14（贴片上半段）\n"
                        "实测把 offset 从 0 扫到 0.15，眼部横带暗像素始终 10.2~10.6% 纹丝不动。\n"
                        "根本原因：**游戏里这只随宠就没有眼球**，眼部外观是 Body 贴图上的\n"
                        "白爪印图案；Eye mesh 虽存在（294 顶点/538 面）但不出现在最终画面上。\n"
                        "→ 保持 0。需要给脸加眼睛的话应改 Body 贴图，不是动 mesh。")
    return p.parse_args(args=argv)


def bbox(meshes):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in meshes:
        mw = o.matrix_world
        for c in o.bound_box:
            w = mw @ mathutils.Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def setup_world_camera(res):
    bpy.ops.wm.read_factory_settings(use_empty=True)

    world = bpy.data.worlds.new("World")
    world.use_nodes=True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0, 0, 0, 1)
    # ★ 环境光保持 0（黑背景 + 强度 0 = 纯净透明背景，不给模型任何环境照明）。
    #   历史教训：曾设 0.35 想提亮，实测明度从 0.659 冲到 0.751 反而过头
    #   （目标 0.557，见下方 --sat 的取值依据）。别再凭感觉调亮度。
    bg.inputs[1].default_value = 0.0
    bpy.context.scene.world = world

    cd = bpy.data.cameras.new("Cam")
    cd.type = "ORTHO"
    cam = bpy.data.objects.new("Camera", cd)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    sc = bpy.context.scene
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"

    def area(name, loc, energy, size, color):
        ld = bpy.data.lights.new(name, type="AREA")
        ld.energy = energy
        ld.size = size
        ld.color = color
        o = bpy.data.objects.new(name, ld)
        bpy.context.scene.collection.objects.link(o)
        o.location = loc
        d = mathutils.Vector((0, 0, 0.5)) - o.location
        o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return o

    # 全部中性/暖白光。**不要**用饱和色光：会触发桌宠的导引色清理。
        #
    # ★ 这组灯光是照着实测数据定的（2026-10-12），别凭感觉调：
    #   游戏参考图      均色 142/134/126  饱和 0.138  明度 0.557
    #   本灯光(当前)    均色 168/160/152  饱和 0.098  明度 0.659  ← 明度已达标
    # → 明度够，真正的差在**饱和度低**（0.098 vs 0.138），靠 --sat 补，不靠加灯。
    # 历史教训：曾误以为「太暗」把灯加到 5 盏+环境光0.35，结果明度飙到 0.751 过头。
    #   起因是**测量方法错**——用「非白色像素」统计，把角色身上的白色当背景剔掉了。
    area("Key", (2.2, -3.0, 3.0), 1000, 3.0, (1.0, 0.97, 0.93))
    area("Fill", (-3.0, -2.2, 1.4), 400, 3.5, (0.92, 0.95, 1.0))
    area("Rim", (0.2, 3.2, 2.4), 650, 2.5, (1.0, 0.95, 0.88))
    area("Bounce", (0.0, -1.8, -0.3), 170, 3.0, (1.0, 1.0, 1.0))
    return cam


def remap_eye_uv(eye_obj, row: int, col_left: int, col_right: int | None = None,
                 grid_rows: int = 5, grid_cols: int = 8,
                 content_h: float = 0.043):
    """把 Eye mesh 的 UV 映射到贴图 atlas 里的某个表情。

    ★ 这版是按实测重写的（2026-10-12），之前两版都因为算错格子而失效：

    实测 Eye_Color_A.png 是 **2048²，5 行 × 8 列**排布 40 个表情，但——
    **每个表情的实际内容高度只有约 0.043 UV**（像素 172~261、581~670 …各 89px），
    而格子高度是 1/5 = 0.2。**内容只占格子的 1/5，其余是留白**。

      之前错在哪：
        v1) 以为「整格都是内容」，把 UV 铺满 0.2 高 → 采样到上下相邻格的留白
            → 采到纯黑/透明 → 脸上一片黑（这就是「脸发黑」的真正原因）
        v2) 行列索引也搞反了：Blender UV 的 V=0 在**底部**，图像 y=0 在**顶部**，
            两者行序相反。按图像行号当 UV 行号 → 取到隔壁表情

    正确映射（行内容中心 v = row/5 + 0.1）：
        row1 = 第二个表情（贴图自上而下第 2 行，UV v≈0.673..0.716）
               实测含「黑瞳26% + 白高光57%」= 游戏里的正常睁眼 ✓

    左右眼是两个独立 UV 岛（U<0.5 左眼 / U>=0.5 右眼），
    图集里是**互为镜像**的一对，所以要给不同列。
    """
    uv_layer = eye_obj.data.uv_layers.active
    if uv_layer is None:
        print("[render] Eye 没有 UV 层，跳过重映射")
        return
    if col_right is None:
        col_right = col_left
    ch = 1.0 / grid_rows
    cw = 1.0 / grid_cols
    # 目标格内内容的纵向区间（居中）
    v_c = (row + 0.5) * ch
    v0, v1 = v_c - content_h / 2.0, v_c + content_h / 2.0

    # 先算出当前 UV 在原图集里的位置（用于判断是左眼岛还是右眼岛）
    for loop in eye_obj.data.loops:
        u, v = uv_layer.data[loop.index].uv
        is_left_island = u < 0.5
        col = col_left if is_left_island else col_right
        u0 = col * cw
        nu = u0 + min(max(u, 0.0), 1.0) * cw        # 铺满该格宽度
        nv = v0 + min(max(v, 0.0), 1.0) * (v1 - v0)
        uv_layer.data[loop.index].uv = (nu, nv)
    print(f"[render] Eye UV -> row{row}(v{v0:.3f}~{v1:.3f}, 内容高{content_h}) "
          f"左眼col{col_left} 右眼col{col_right}")


def apply_materials(meshes, body_tex, eye_tex, args_sat=1.0, args_val=1.0):
    """按 mesh 挂对应贴图。

    实测坑：`Eye` 是**独立 mesh**，UV 范围与 Body 不同（Eye 在 uvV 0.29~0.67，
    Photo 在 uvU 0~0.06）。如果给所有 mesh 都挂 Body 图，
    眼睛就会去 Body 图的对应区域采样 —— 渲出来是一片灰度乱码，脸直接花掉
    （这是第一次渲染的真实故障，不是猜测）。
    → Eye 必须挂 Eye_Color_A；Photo 用 Body 图即可（它几乎不显眼）。
    """
    def make_mat(name, tex_path, rough, sat=1.0, val=1.0):
        if not tex_path or not os.path.isfile(tex_path):
            return None
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        for link in list(nt.links):
            if link.to_socket.name == "Base Color":
                nt.links.remove(link)
        node = nt.nodes.new("ShaderNodeTexImage")   # Image 本身无 use_nodes 属性
        node.image = bpy.data.images.load(tex_path)
        node.location = (-400, 300)
        if abs(sat - 1.0) > 1e-3 or abs(val - 1.0) > 1e-3:
            # HueSaturation：--sat 补饱和、--val 压明度
            # ★ 实测：只加 sat 明度纹丝不动（0.733→0.739），必须靠 val 单独压
            hs = nt.nodes.new("ShaderNodeHueSaturation")
            hs.inputs["Saturation"].default_value = sat
            hs.inputs["Value"].default_value = val
            hs.location = (-700, 300)
            nt.links.new(node.outputs["Color"], hs.inputs["Color"])
            nt.links.new(hs.outputs["Color"], bsdf.inputs["Base Color"])
        else:
            nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = rough
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
        return mat

    body_mat = make_mat("LimaoBody", body_tex, 0.62, args_sat, args_val)
    eye_mat = make_mat("LimaoEye", eye_tex, 0.35, args_sat, args_val) or body_mat

    for o in meshes:
        o.data.materials.clear()
        if o.name.lower().startswith("eye") and eye_mat is not body_mat:
            o.data.materials.append(eye_mat)
            print(f"[render] {o.name} -> 眼睛贴图")
        elif body_mat is not None:
            o.data.materials.append(body_mat)
            print(f"[render] {o.name} -> 基础色贴图")
    if body_mat is None:
        print("[render] 警告：没有可用贴图，使用默认材质")


def set_engine(args):
    sc = bpy.context.scene
    if args.engine == "cycles":
        sc.render.engine = "CYCLES"
        sc.cycles.samples = args.samples
        sc.cycles.use_denoising = True
        # 压掉 firefly 噪点：实测它们会随机落成极少数「高饱和青/品红」像素
        # （例：rgb 80,221,222），正好命中桌宠的导引色清理 →
        # 装进桌宠身上就是几个 1 像素破洞。降噪在这里比事后修补干净。
        try:
            sc.cycles.sample_clamp_indirect = 4.0
        except AttributeError:
            pass
        sc.cycles.film_transparent_glass = True
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
                    print(f"[render] Cycles GPU = {backend}")
                    break
        except Exception as e:  # noqa: BLE001
            print(f"[render] 用 CPU: {e}")
    else:
        sc.render.engine = "BLENDER_EEVEE_NEXT"


def pose(row: int, i: int, n: int) -> dict:
    """第 row 行第 i 帧的姿态。

    幅度受一条硬约束：角色几何中心必须留在画面中心附近，否则那一帧会被
    桌宠渲染器当成空帧（只用中心 8×8 采样）。跳跃幅度因此刻意保守。
    """
    t = i / max(1, n - 1) if n > 1 else 0.0
    p = {"rx": 0.0, "rz": 0.0, "tx": 0.0, "tz": 0.0, "s": 1.0}
    if row == 0:                                   # idle 待机：呼吸
        p["s"] = 1.0 + 0.020 * math.sin(t * math.tau)
        p["tz"] = 0.012 * math.sin(t * math.tau)
    elif row in (1, 2):                            # 走：横向+起伏
        d = 1 if row == 1 else -1
        p["rz"] = d * (0.10 + 0.09 * math.sin(t * math.tau * 2))
        p["rx"] = d * (0.07 + 0.07 * math.sin(t * math.tau * 2))
        p["tx"] = d * 0.10 * math.sin(t * math.tau)
        p["tz"] = 0.055 * abs(math.sin(t * math.tau))
    elif row == 3:                                 # 招手：左右摆 + 上探
        p["rz"] = 0.15 * math.sin(t * math.tau * 1.5)
        p["rx"] = -0.10
        p["tz"] = 0.035 * abs(math.sin(t * math.tau * 1.5))
    elif row == 4:                                 # 跳跃：保守抛物线
        # 球棒狸是「宽胖」体型：高度占 1.0、宽度也占 0.9。
        # 纯纵向位移会让身体在腾空帧整体移出画面中心（中心 8×8 采样落空）。
        # 所以跳跃用「纵向小位移 + 纵向拉伸 + 轻微前倾」表达，
        # 保证每一帧的重心都留在画面中心。
        p["tz"] = 0.10 * math.sin(t * math.pi)
        p["s"] = 1.0 + 0.10 * math.sin(t * math.pi)
        p["rx"] = 0.06 * math.sin(t * math.tau)
    elif row == 5:                                 # 难过：渐次缩小+歪倒
        k = t * t * (3 - 2 * t)
        p["s"] = 1.0 - 0.20 * k
        p["rx"] = -0.45 * k
        p["rz"] = 0.26 * k
        p["tz"] = 0.085 * k
    elif row == 6:                                 # 等待：无聊地晃
        p["rz"] = 0.07 * math.sin(t * math.tau * 0.8)
        p["tz"] = 0.025 * math.sin(t * math.tau * 0.8)
    elif row == 7:                                 # 忙：专注前倾
        p["rx"] = 0.20
        p["rz"] = 0.05 * math.sin(t * math.tau * 2)
        p["tz"] = 0.02
    elif row == 8:                                 # 讲话：说话起伏
        p["s"] = 1.0 + 0.028 * abs(math.sin(t * math.tau * 3))
        p["tz"] = 0.028 * abs(math.sin(t * math.tau * 3))
        p["rz"] = 0.055 * math.sin(t * math.tau)
    return p


def main():
    args = parse_args()
    cam = setup_world_camera(args.res)
    set_engine(args)

    bpy.ops.import_scene.fbx(filepath=args.model)

    # 删掉 FBX 里混进来的调试立方体（bbox ±1，会毁掉归一化）
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name == "Cube":
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    print(f"[render] mesh={len(meshes)} armature={len(arms)}")
    if not meshes:
        raise SystemExit("没有 mesh")

    # 丢掉零体积的碎片网格（Photo 的 bbox z 跨度为 0，是提取残留）
    meshes = [o for o in meshes if o.dimensions.length > 1e-6]
    dropped = [o.name for o in bpy.data.objects
               if o.type == "MESH" and o not in meshes]
    if dropped:
        print(f"[render] 丢弃零体积网格: {dropped}")

    # 变换链：先建 pivot 并把 mesh 挂上去（脱离 armature），
    # **再**做归一化 —— 顺序反了的话，重新挂父级会把 matrix_parent_inverse
    # 重置，归一化结果丢失（实测角色中心跑到 y=84.5）。
    # 实测坑 2：mesh 原本 parent=armature，若把 pivot 也挂到 armature 下，
    # 两者成了兄弟节点，转 pivot 对 mesh 无效（4 个朝向渲染一模一样）。
    pivot = bpy.data.objects.new("Pivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    for o in meshes:
        o.parent = pivot
        o.matrix_parent_inverse = mathutils.Matrix.Identity(4)
    for a in arms:
        a.location = (0.0, 0.0, 0.0)
        a.rotation_euler = (0.0, 0.0, 0.0)
    pivot.location = (0.0, 0.0, 0.0)
    pivot.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    # ★ Eye 必须沿脸朝向(模型局部 +Z)推出，否则埋在 Body 里 → 脸上一片黑。
    # 实测：Eye 顶点 Z 上限 0.329 < Body 在同高度的前表面 Z=0.367，埋深 0.039。
    # 游戏引擎靠 material 的 Z-offset 解决，FBX/OBJ 不携带该设置 → 几何上手动推。
    # 位置很讲究：必须在**挂完父级之后、归一化之前**做
    #   - 挂父级会重置 matrix_parent_inverse，晚做会被冲掉；
    #   - 归一化会重算 matrix_world，早做会被缩放/对中稀释。
    if args.eye_offset:
        for o in meshes:
            if o.name.lower().startswith("eye"):
                o.location = o.location + mathutils.Vector(
                    (0.0, 0.0, args.eye_offset))
                print(f"[render] {o.name} 沿模型 +Z 推出 {args.eye_offset}"
                      f"（原本埋在身体里，不推则脸上一片黑）")
        bpy.context.view_layer.update()

    # ★ 顺序：**先归一化（量真实身高/对中），最后才施加 axis-fix**。
    # 坑（踩了三次才对）：归一化必须在 pivot **无旋转**时做。
    #   - 先摆正再归一化：pivot 带 rx=90°，transform.resize 绕选中集中枢缩放 +
    #     matrix_world 平移会被旋转重新作用，中心停在 0.43 不归零；
    #   - 身高轴：摆正前身高在 Y(Y跨1.313)，Z 只跨 1.105，
    #     所以要先按 Y 量/缩放，摆正后它自然就变成 Z（身高）轴。
    axis_fix = math.radians(args.axis_fix)

    # 归一化到「身高 1.0 且几何中心在原点」。
    # ★ 身高轴必须是**摆正后的 Z**（Blender 屏幕上方）。
    #   坑：早先版本写死用 hi[2]-lo[2]，但 w5_limao 摆正前身高在 Y（Y跨1.313），
    #   Z 只跨 1.105 → 按错轴缩放+对中，角色比例失真且整体飘到画面顶部。
    # 坑：`bpy.ops.transform.resize` 绕**选中集中枢**缩放，不是绕原点 →
    #     缩放后必须重新量包围盒。
    def normalize_to_unit_height(objs):
        """缩放到身高 1.0，并把几何中心对到原点。

        ★ 对中必须走 **matrix_world 直接平移**，不能用
        `o.location += (parent.matrix_world.inverted() @ c)` ——
        那个写法在 pivot **带旋转**时算错（此时 axis-fix 已施加 rx=90°），
        实测中心 z 停在 0.845 不归零，角色整体飘到画面顶部被裁掉，
        看起来就像「躺着」（bbox 高/宽 = 0.34）。
        世界空间平移与父级状态无关，最不容易错。
        """
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        lo, hi = bbox(objs)
        # 摆正前模型是 Y-up，身高在 Y；axis-fix 之后这个 Y 才变成 Z。
        # 在此（pivot 无旋转时）按 Y 量高度最准。
        s = 1.0 / max(1e-9, hi[1] - lo[1])
        bpy.ops.transform.resize(value=(s, s, s))
        bpy.context.view_layer.update()
        lo, hi = bbox(objs)                       # 缩放后重新量
        c = mathutils.Vector([(lo[i] + hi[i]) / 2.0 for i in range(3)])
        shift = mathutils.Matrix.Translation(-c)
        for o in objs:
            o.matrix_world = o.matrix_world @ shift
        bpy.context.view_layer.update()
        return s

    s = normalize_to_unit_height(meshes)
    lo, hi = bbox(meshes)
    size = (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    ctr = [(lo[i] + hi[i]) / 2.0 for i in range(3)]
    print(f"[render] 归一化 scale={s:.3f} size="
          f"{tuple(round(v,3) for v in size)} center="
          f"{tuple(round(v,4) for v in ctr)}")
    if max(abs(v) for v in ctr) > 0.02:
        print(f"[render] ⚠ 几何中心未对到原点 (|center|max|"
              f"{max(abs(v) for v in ctr):.4f})，构图会偏")
    if size[2] < max(size[0], size[1]) * 0.95:
        print(f"[render] ⚠ 身高(Z={size[2]:.3f}) 不比宽(X={size[0]:.3f})/"
              f"厚(Y={size[1]:.3f})大 → 角色多半是躺着的，检查 --axis-fix")

    apply_materials(meshes, args.texture, args.eye_texture, args.sat, args.val)

    # 把眼睛 UV 压到「正常睁眼」那一格，否则脸会被 40 个表情 sprite 糊成一片
    for o in meshes:
        if o.name.lower().startswith("eye") and args.eye_cell:
            parts = [int(v) for v in str(args.eye_cell).split(",")]
            if len(parts) == 3:
                r, cl, cr = parts
            else:                      # 兼容旧的 row,col 单格写法
                r, cl, cr = parts[0], parts[1], parts[1]
            remap_eye_uv(o, r, cl, cr)

    # 现在才施加 axis-fix（归一化已完成，pivot 此前一直无旋转）
    pivot.rotation_euler = (axis_fix, 0.0, 0.0)
    bpy.context.view_layer.update()

    # 朝向：摆正后头顶朝 +Z，水平转向必须绕 **Y** 轴（绕 Z 会躺着翻跟头）。
    # 相机在 -Y；矩阵已验证 rx=90 时 +Z(脸) 正好落到 -Y，故 yaw=0 即正脸。
    yaw = args.yaw
    pivot.rotation_euler = (axis_fix, 0.0, math.radians(yaw))
    bpy.context.view_layer.update()
    lo, hi = bbox(meshes)
    print(f"[render] yaw={yaw}°（绕Y）  旋转后几何中心="
      f"{tuple(round((lo[i]+hi[i])/2, 4) for i in range(3))}")

    # 相机正对原点（= 几何中心）。ortho_scale 用**实际像素高度反推**，
        # 保证角色既不被裁掉、又留足动作位移余量。
    # ★ 俯仰角由 --cam-pitch 控制（用户指定 30° 轻微俯视）：
    #   loc  = (0, -D·cos(pitch), D·sin(pitch))
    #   rotX = 90° - pitch   （Blender 相机默认看 -Z，rotX=90 时正好水平朝 +Y）
    pitch = math.radians(args.cam_pitch)
    dist = 6.0
    cam.location = (0.0, -dist * math.cos(pitch), dist * math.sin(pitch))
    cam.rotation_euler = (math.radians(90) - pitch, 0, 0)
    # 俯视时角色在画面里被压扁，留的余量要比平视多些，否则动作帧会碰到边缘
    pad = args.margin * (1.0 + math.sin(pitch) * 0.15)
    cam.data.ortho_scale = max(size) * pad
    print(f"[render] 相机 pitch={args.cam_pitch}° "
          f"loc=({cam.location.x:.2f},{cam.location.y:.2f},{cam.location.z:.2f}) "
          f"ortho={cam.data.ortho_scale:.3f} "
          f"(margin={args.margin}, 角色占画面 {100.0/max(size)/pad:.0f}%)")

    total = 0
    for row in range(9):
        d = os.path.join(args.out, f"row{row}")
        os.makedirs(d, exist_ok=True)
        for i in range(ROW_FRAMES[row]):
            p = pose(row, i, ROW_FRAMES[row])
            # 姿态旋转也要走同一套轴：rx 绕 Y(前倾)，rz 绕 Z(侧倾)，
            # yaw 固定水平转向绕 Y。注意 Blender rotation_euler 是 XYZ 序，
            # 实际应用顺序是 Rz·Ry·Rx，这里把 axis_fix 放最前并说明它已包含在内。
            pivot.location = (p["tx"], 0.0, p["tz"])
            pivot.rotation_euler = (axis_fix + math.radians(p["rx"]),
                                    math.radians(yaw + p["rz"]),
                                    0.0)
            pivot.scale = (p["s"], p["s"], p["s"])
            bpy.context.view_layer.update()
            bpy.context.scene.render.filepath = os.path.join(d, f"{i:02d}.png")
            bpy.ops.render.render(write_still=True)
            total += 1
        print(f"[render] row{row} {ROW_NAMES[row]:<14} {ROW_FRAMES[row]} 帧")

    print(f"[render] 完成 {total} 帧 -> {args.out}")


if __name__ == "__main__":
    main()