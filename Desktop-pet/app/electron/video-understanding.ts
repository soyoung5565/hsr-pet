/**
 * 视频理解管线 —— 把一个视频文件变成「桌宠能听懂的一句话」。
 *
 * 这套是从 dsh-douyin-agent 搬来的能力,模型后端换成了 MiniMax。
 *
 * 上游的链路:抽帧 → 画面交给多模态模型;音频可选本地 Whisper / MiMo / MiniMax。
 * 我们的链路(按用户要求「改成我们电脑上的这一套视频理解,就是把音频给他理解」):
 *
 *   ① 画面 → MiniMax Anthropic 兼容端点(image 块)
 *   ② 音频 → MiniMax /v1/speech_to_text(ASR,asr-1.0)
 *   ③ 合并 → MiniMax LLM 总结成一句话
 *
 * ★ 为什么必须用 ASR 端点而不是把音频塞给 LLM:
 *   实测(2026-10-31):
 *     - Anthropic 端点 type=audio → 400 unsupported content type 'audio'
 *     - OpenAI 兼容端点 audio_url → 200 但模型回「请上传音频文件」(静默忽略)
 *   所以 MiniMax 的音频理解**只有** /v1/speech_to_text 一条路。
 *   ASR 返回的是逐字稿,再交给 LLM 总结 —— 效果比「让 LLM 直接听」更可控。
 *
 * 抽帧用 ffmpeg。ffmpeg 路径从 PATH 找,找不到就退到 Hermes 自带的那份
 * (AppData/Local/hermes/tools 目录下的 ffmpeg-x.y.z-win32-x64/bin/ffmpeg.exe)。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimaxChat, minimaxImageBlock, minimaxTranscribe, type MiniMaxMessage } from './minimax-provider.js';

const execFileAsync = promisify(execFile);

/** ffmpeg 的候选路径(第一个存在的用)。 */
const FFMPEG_CANDIDATES = ['ffmpeg'];

let ffmpegPath: string | null = null;

/** 找 ffmpeg。先找 PATH,再找 Hermes 自带的那份。 */
export async function resolveFfmpeg(): Promise<string | null> {
  if (ffmpegPath) return ffmpegPath;
  for (const candidate of FFMPEG_CANDIDATES.slice(0, 1)) {
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 10_000 });
      ffmpegPath = candidate;
      return ffmpegPath;
    } catch {
      /* 继续找 */
    }
  }
  // Hermes 自带工具目录
  const toolsRoot = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'tools');
  try {
    const entries = await fs.readdir(toolsRoot);
    for (const entry of entries) {
      if (!entry.startsWith('ffmpeg')) continue;
      const candidate = path.join(toolsRoot, entry, 'bin', 'ffmpeg.exe');
      try {
        await fs.access(candidate);
        ffmpegPath = candidate;
        return ffmpegPath;
      } catch {
        /* 下一个 */
      }
    }
  } catch {
    /* 工具目录不存在 */
  }
  return null;
}

/** 一段视频的理解结果。 */
export interface VideoUnderstanding {
  ok: boolean;
  /** 综合描述(画面 + 对白)。 */
  summary: string;
  /** 画面描述。 */
  visual: string;
  /** 对白转写。 */
  transcript: string;
  /** 抽出的关键帧路径(临时文件,调用方用完要清)。 */
  frames: string[];
  error?: string;
}

/** 抽帧参数。 */
export interface ExtractFramesOptions {
  /** 抽几帧。默认 3。 */
  count?: number;
  /** 视频时长(秒)。不给就 ffprobe 探测。 */
  durationSeconds?: number;
  /** 临时目录。默认系统 temp 下的一个专属子目录。 */
  workDir?: string;
}

export interface ExtractedFrames {
  frames: string[];
  durationSeconds: number;
  audioPath: string | null;
  workDir: string;
}

/** 探测视频时长(秒)。 */
export async function probeDuration(videoPath: string): Promise<number> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) return 0;
  // ffmpeg 路径换成同目录的 ffprobe
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, (_m, ext) => `ffprobe${ext ?? ''}`);
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      { timeout: 30_000 },
    );
    const n = parseFloat(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 抽帧 + 抽音轨。
 *
 * 抽帧按等间隔分布(而不是只取开头)——抖音视频的关键信息常在中段。
 * 音轨转成 wav(16kHz 单声道)——MiniMax ASR 端点只吃 wav/mp3/m4a 等,
 * wav 最稳且体积可控。
 */
export async function extractFrames(videoPath: string, options: ExtractFramesOptions = {}): Promise<ExtractedFrames> {
  const count = Math.max(1, Math.min(8, options.count ?? 3));
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error('找不到 ffmpeg —— 视频理解需要它抽帧和抽音轨');
  }
  const workDir =
    options.workDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pet-video-')));
  await fs.mkdir(workDir, { recursive: true });

  let duration = options.durationSeconds ?? 0;
  if (!duration) duration = await probeDuration(videoPath);

  const frames: string[] = [];
  // 等间隔抽帧:第一帧放在 10% 处,避免开头黑屏/片头
  for (let i = 0; i < count; i++) {
    const ratio = duration > 0 ? 0.1 + (0.8 * i) / Math.max(1, count - 1 || 1) : i * 2;
    const at = duration > 0 ? Math.min(duration - 0.05, duration * ratio) : i * 2;
    const framePath = path.join(workDir, `frame-${i}.jpg`);
    try {
      await execFileAsync(
        ffmpeg,
        ['-y', '-ss', String(Math.max(0, at)), '-i', videoPath, '-frames:v', '1', '-q:v', '4', framePath],
        { timeout: 60_000 },
      );
      await fs.access(framePath);
      frames.push(framePath);
    } catch {
      /* 这一帧抽不出来就跳过,不影响其它帧 */
    }
  }

  // 抽音轨 → wav
  let audioPath: string | null = null;
  const wavPath = path.join(workDir, 'audio.wav');
  try {
    await execFileAsync(
      ffmpeg,
      ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', wavPath],
      { timeout: 180_000 },
    );
    const st = await fs.stat(wavPath);
    if (st.size > 1000) audioPath = wavPath;
    else await fs.unlink(wavPath).catch(() => undefined);
  } catch {
    // 没有音轨的视频(纯音乐/无声)会走到这里 —— 不是错误
    audioPath = null;
  }

  return { frames, durationSeconds: duration, audioPath, workDir };
}

/**
 * 理解一个视频:画面 + 音频 → 一段描述。
 *
 * 三步:
 *   ① 抽帧 → 每帧单独问 MiniMax「这张图里有什么」
 *   ② 音轨 → MiniMax ASR 逐字转写
 *   ③ 画面描述 + 转写 → MiniMax LLM 合成最终描述
 *
 * 为什么 ① 要逐帧问而不是一次问多图:MiniMax 的 Anthropic 端点支持多图,
 * 但一次塞 3 张会让模型平均分配注意力,逐帧问更准 —— 代价是 3 次调用。
 */
export async function understandVideo(params: {
  apiKey: string;
  videoPath: string;
  /** 关注什么(可选)。不给就是泛泛描述。 */
  question?: string;
  /** 抽几帧。默认 3。 */
  frameCount?: number;
  /** 要不要抽音轨转写。默认 true。 */
  includeAudio?: boolean;
  model?: string;
  region?: 'cn' | 'global';
  signal?: AbortSignal;
  /** 临时目录(测试时可控)。 */
  workDir?: string;
}): Promise<VideoUnderstanding> {
  const {
    apiKey,
    videoPath,
    question,
    frameCount = 3,
    includeAudio = true,
    model,
    region = 'cn',
    signal,
  } = params;

  let workDir = params.workDir ?? '';
  try {
    const extracted = await extractFrames(videoPath, {
      count: frameCount,
      workDir: params.workDir,
    });
    workDir = extracted.workDir;

    // ---- ① 画面 ----
    const visualParts: string[] = [];
    for (let i = 0; i < extracted.frames.length; i++) {
      if (signal?.aborted) throw new Error('已取消');
      const block = await minimaxImageBlock(extracted.frames[i]);
      if (!block) continue;
      const messages: MiniMaxMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                question
                  ? `这是视频的第 ${i + 1} 个采样画面。请描述画面里实际可见的内容,并回答:${question}`
                  : `这是视频的第 ${i + 1} 个采样画面。请客观描述画面里实际可见的内容(人物、动作、场景、文字),不要猜测看不见的东西。`,
            },
            block,
          ],
        },
      ];
      const res = await minimaxChat({
        apiKey,
        model,
        messages,
        maxTokens: 800,
        region,
        signal,
      });
      if (res.ok && res.text) visualParts.push(`[画面${i + 1}] ${res.text}`);
    }
    const visual = visualParts.join('\n');

    // ---- ② 音频 ----
    let transcript = '';
    if (includeAudio && extracted.audioPath) {
      const res = await minimaxTranscribe({
        apiKey,
        filePath: extracted.audioPath,
        region,
        signal,
      });
      if (res.ok) transcript = res.text;
    }

    // ---- ③ 合成 ----
    if (!visual && !transcript) {
      return {
        ok: false,
        summary: '',
        visual: '',
        transcript: '',
        frames: extracted.frames,
        error: '既没抽到画面也没抽到音轨 —— 这个文件可能不是有效的视频',
      };
    }

    const parts: string[] = [];
    if (visual) parts.push(`画面内容:\n${visual}`);
    if (transcript) parts.push(`语音转写:\n${transcript}`);
    parts.push(
      question
        ? `请结合以上信息回答这个问题:${question}`
        : '请用一段话综合说明这个视频讲了什么(客观描述,不要编造未出现的内容)。',
    );

    const final = await minimaxChat({
      apiKey,
      model,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
      maxTokens: 1000,
      region,
      signal,
    });

    if (!final.ok) {
      return {
        ok: false,
        summary: '',
        visual,
        transcript,
        frames: extracted.frames,
        error: final.error ?? 'MiniMax 生成失败',
      };
    }

    return {
      ok: true,
      summary: final.text,
      visual,
      transcript,
      frames: extracted.frames,
    };
  } catch (e) {
    return {
      ok: false,
      summary: '',
      visual: '',
      transcript: '',
      frames: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // 临时目录由调用方负责清理;这里只清自己建的
    if (workDir && !params.workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
