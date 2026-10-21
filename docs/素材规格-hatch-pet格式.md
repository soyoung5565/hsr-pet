# 随宠桌宠素材规格（hatch-pet / Codex 精灵表格式）

> 依据：Desktop-pet 项目源码资源契约（`app/src/render/hatch-pet-host.tsx` 第 18-34 行）+ 代码级实测行为
> 用途：任何素材来源（录屏抠像 / 3D 渲染 / 手绘 / AI 生成）最终都汇成这一种格式

## 1. 成品清单（每只宠物 = 一个文件夹）

```text
<宠物名>/
├── pet.json            # 元数据
└── spritesheet.webp    # 精灵表（也支持 .png）
```

pet.json 示例（最简）：

```json
{
  "id": "suichong",
  "displayName": "随宠",
  "description": "一句话描述",
  "spritesheetPath": "spritesheet.webp"
}
```

> ⚠️ **id 不是文件夹名本身，扫描后会加前缀**（`asset-scanner.ts` 实测）：
> builtin（内置于 `app/hatch-pet/`）→ `hatch-b-<文件夹名>`，user（导入到 userData）→ `hatch-u-<文件夹名>`。
> 例：文件夹 `球棒狸` → id `hatch-b-球棒狸`。
>
> 写 `config.defaultCharacterId` 时**必须用带前缀的完整 id**。填错不会报错，
> `pickStartupCharacterId` 会静默回退到第一只 hatch-pet（实测：填 `球棒狸`
> 结果一直显示橘猫「耄耋」，很误导）。
> 确认真实 id：`python D:\hsr-pet\scripts\pet_probe.py`（需 `PET_CDP=1` 启动）。

## 2. 精灵表规格（硬性）

- 尺寸：**1536 × 1872 像素**，8 列 × 9 行，共 72 格；
- 单帧：**192 × 208 像素**；
- 9 行从上到下的固定语义：

| 行 | 语义 | 程序里的用途 |
|---|---|---|
| 0 | idle | 待机（休息时主要播放） |
| 1 | running-right | 向右走路 |
| 2 | running-left | 向左走路 |
| 3 | waving | 开心情绪（适合做招手/欢呼） |
| 4 | jumping | 被拖拽 / 长按"抱起" |
| 5 | failed | 难过 / 生气情绪 |
| 6 | waiting | 等待 / 无聊 |
| 7 | running | 思考 / 工作 / 打游戏（"在忙"状态） |
| 8 | review | 说话 / 回答（"在讲话"状态） |

- 每行帧数：**最多 8 帧**，程序会自动检测实际帧数（从行左起，连续非透明格计为有效帧）；
  参考值（Codex 规范）：6 / 8 / 8 / 4 / 5 / 8 / 6 / 6 / 6；
- 未使用的格子必须**全透明**（alpha = 0）；
- 播放帧率默认 **8 fps**。

## 3. 制作注意（源码级坑点）

1. **避免高饱和度的青、绿、品红、蓝像素**（尤其轮廓/描边）：渲染器有一个"导引色清理"步骤，偏暗、高饱和（通道差 > 70）的这四种色调会被打成透明。藏青 + 金的随宠配色本身安全，但亮蓝、亮绿配饰的边缘要检查。
2. 每格内容尽量靠近格子**中心**：程序用格子中心 8×8 像素采样判断"该帧是否非空"。
3. 每行必须从**最左格开始连续**排列；中间不允许出现空帧。
4. 想改动作→行的映射或调行走参数，在 pet.json 加 `behavior` 字段覆盖即可。

## 4. 行为参数（可选覆盖，写进 pet.json）

```json
"behavior": {
  "walkSpeed": 24,          // 桌面走动速度，像素/秒
  "walkMs": [2000, 5000],   // 每次连续走动的时长范围（毫秒）
  "restMs": [8000, 20000],  // 每次休息的时长范围（毫秒）
  "fps": 8
}
```

> 默认行为：走 2-5 秒 → 停 8-20 秒 → 循环；边走边切 running-right / running-left 两行。
> 情绪行映射（happy→waving、sad/angry→failed 等）也可在 `behavior.emotionRows` 覆盖。

## 5. 导入方式（二选一）

- **应用内导入（推荐）**：设置面板的「导入」入口 → 落到用户数据目录 `hatch-pet/`，立即出现在角色菜单；
- **手动放置**：文件夹丢进 `app/hatch-pet/<名字>/`（内置，dev 态）或 userData 同名目录（打包后仍可用）。

## 6. 素材来源 → 本格式的三条管线

| 来源 | 链路 | 备注 |
|---|---|---|
| 游戏录屏 / 视频 | 抠像（SAM2 / BiRefNet 等）→ 抽帧 → 重采样到每行帧数 → 拼表 | 需要"干净背景 + 固定机位"的录制素材 |
| 3D 模型（提取或自建） | Blender 固定机位渲染透明 PNG 序列（每行一套）→ 拼表 | 可任意角度、动作可控 |
| 手绘 / AI 出帧 | 直接拼表 | — |

拼表/自检工具：`D:\hsr-pet\tools\inspect_sheet.py`（检查每行帧数、格内容分布）。

## 7. 验收标准

- `inspect_sheet.py` 显示 8 列 9 行、每行 leading-frames 符合预期；
- 丢进项目后在桌面观察：待机时播 idle、走动时左右切换、拖拽时播 jumping、聊天时切 review。
