# hsr-pet · 崩铁随宠桌面宠物

> Windows 桌面宠物应用：Hatch-Pet 精灵表 + Video-Pet 透明动画 + 多模态大模型对话 + 主动搭话。
> *Windows desktop pet: sprite-sheet pets, transparent-video pets, multimodal LLM chat, and proactive greetings.*

**底座：`git2968/Desktop-pet`（Electron + React + PIXI，MIT License，作者 Johnny Joestar）**
本仓库是在其基础上做的自研改造，改造清单见下方「我改了什么」。

---

## 🎯 它是什么

桌面上养一只（或多只）**崩坏：星穹铁道**随宠。它不是贴图动图，会：

- **跟着鼠标看**、能被拖拽、能在多块显示器之间漫游
- **跟你说话** —— 走多模态大模型，回复带情绪标签，自动映射成表情和动作
- **主动开口** —— 靠系统空闲检测判断你「忙完了」，挑时机搭话
- **记住你** —— 本地记忆检索，跨会话不丢
- **有脾气** —— 抛掷物理、表情包、点击音效、睡觉/醒来状态机

### 两种宠物形态

| 形态 | 素材 | 说明 |
|---|---|---|
| **Hatch-Pet**（精灵表） | `spritesheet.webp` + `pet.json` | 多帧序列，逐帧渲染。已接入 **3 只**：耄耋（橘猫）、球棒狸、万津莫 |
| **Video-Pet**（透明动画） | `webm/*.webm` | 透明背景循环视频，更细腻。已接入 **1 只**：蓝毛小女仆，带 **19 个表情包** 和 **17 个循环动画**（放烟花 / 吹笛子 / 装点圣诞树 / 大口吃零食…） |

---

## 🛠 我改了什么

底座是 MIT 开源项目，我在此基础上做了这些改造（`refs/` 目录保留了 upstream 原始快照作为 diff 基准）：

### 1. AI 对话与多模态管线
- `ai-client.ts` / `ai-client.think.ts` —— 大模型客户端，支持推理模型（thinking）
- `minimax-provider.ts` —— MiniMax 多模态 provider
- `video-understanding.ts` —— 视频理解管线（喂给桌宠看的短视频）
- `agent-bridge.ts` —— Agent 联动，让桌宠能调用工具而不只是聊天
- `memory-store.ts` —— 本地长期记忆

### 2. 主动搭话
- `system-idle.ts` —— **系统级空闲检测**（不是窗口级），判断用户是否真的离开
- `use-proactive-greetings.ts` —— 基于空闲状态的主动开口时机决策
- `proactive-aware.ts` —— 主动行为感知

### 3. 桌宠行为与渲染
- `hatch-pet-host.tsx` —— **863 → 1302 行**（upstream 原始快照见 `refs/`），精灵表渲染管线重写
- `character-host.tsx` / `video-pet-host.tsx` —— 统一角色宿主，兼容两种宠物形态
- `use-draggable-panel.ts` —— 拖拽
- `use-pet-chatter.ts` —— 碎碎念
- `use-voice-dictation.ts` —— 语音输入
- `vosk-shared.ts` —— 离线语音识别

### 4. 桌面集成
- `uia-reader.ts` —— Windows UI Automation 读屏
- `windows-ocr.ts` —— Windows 原生 OCR
- `douyin-controller.ts` + `douyin-browser-worker.mjs` + `douyin-browser-worker-host.ts` —— 抖音模块改**独立 Node 子进程**（不阻塞渲染进程）
- `mcp-client.ts` / `builtin-tools.ts` / `skill-registry.ts` —— MCP 工具接入

### 5. 素材管线（Python 工具链 `scripts/`）
| 脚本 | 作用 |
|---|---|
| `render_limao.py` | 真实模型 → 9 行 57 帧渲染 |
| `yaw_probe.py` | 四朝向诊断 |
| `check_frames.py` | 帧数 / 空帧 / 构图 / 导引色 体检 |
| `cross_check_guide.py` | 判据 vs 源码 对拍（Node vs Python） |
| `build_sheet.py` | 精灵表拼装 + 自检报告 |
| `pet_probe.py` | CDP 查桌宠真实状态 |
| `pet_shot.py` | 直读 canvas 像素（不受窗口遮挡） |
| `pet_anim_capture.py` | 连拍验动画 |

### 6. 打包
`electron-builder.hatch-samples.yml` 等模板，首次打通 **185MB 安装包**（含全部桌宠素材）。踩过的坑见 `docs/进展记录.md`。

---

## 📊 实测数据

| 指标 | 数值 |
|---|---|
| 源码总行数（ts/tsx/py） | **37,031 行** |
| `Desktop-pet/app/electron/` 模块 | **23 个** |
| `Desktop-pet/app/src/render/` 模块 | **10 个** |
| 桌宠数量 | 4 只（3 精灵表 + 1 视频） |
| 表情包 | 19 个 |
| 循环动画 | 17 个 |
| 安装包 | 185 MB |

---

## 🚀 运行

```bash
cd Desktop-pet/app
npm install
npm run dev
```

打包：

```bash
npm run build          # electron-builder.personal.yml
npm run build:public   # electron-builder.live2d-none.yml
```

AI 功能需要在 `config.json` 里填自己的 `baseURL` + `apiKey`（仓库里不带任何密钥）。

---

## 📂 目录结构

```
D:\hsr-pet\
├── Desktop-pet/          桌宠主工程（Electron + React + PIXI）
│   ├── app/
│   │   ├── electron/     主进程：AI 客户端 / 记忆 / 语音 / 读屏 / 抖音
│   │   ├── src/render/   渲染层：精灵表 & 视频宠物宿主
│   │   ├── hatch-pet/    精灵表宠物素材（3 只）
│   │   └── video-pet/    透明视频宠物素材（1 只 + 19 表情包 + 17 动画）
│   └── LICENSE           上游 MIT 许可
├── scripts/              Python 素材工具链
├── docs/                 调研 + 规格 + 决策 + 进展记录
├── refs/desktop-pet/     upstream 原始快照（diff 基准，不参与构建）
└── tools/AnimeStudio/    模型解密提取工具
```

---

## 📄 文档

| 文档 | 内容 |
|---|---|
| `docs/进展记录.md` | 开发时间线 + 踩过的坑（**最有价值的一份**） |
| `docs/调研报告-桌宠实现方法.md` | 桌宠技术路线调研 |
| `docs/调研-GitHub桌宠生态-20261021.md` | 生态调研 |
| `docs/素材规格-hatch-pet格式.md` | 精灵表素材规格 |
| `docs/素材路线-3D提取决策.md` | 3D 提取方案决策 |
| `docs/渲染管线v6修复记录.md` | 渲染管线修复 |

---

## ⚖️ 许可与致谢

本仓库自有代码采用 MIT License（见 `LICENSE`）。

**底座项目**：`git2968/Desktop-pet` —— MIT License，Copyright (c) 2026 Johnny Joestar。
其原始代码位于 `Desktop-pet/`，原始快照位于 `refs/desktop-pet/`。
本项目在其基础上进行改造，保留上游版权声明与 MIT 许可。

随宠相关形象素材版权归原作者所有。
