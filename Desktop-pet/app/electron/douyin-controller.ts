/**
 * 抖音刷视频模块 —— 从 dsh-douyin-agent(LockyBee/dsh-douyin-agent,MIT)搬来的能力,
 * 模型后端换成 MiniMax。
 *
 * 与上游最大的不同:
 *   上游是 DeepSeek Harness 插件 —— 所有能力都挂在 DSH 的 ctx/工具注册表上,
 *   还带着一整套 QQ 私信、评论、分享、好友互动。
 *   我们是独立 Electron 桌宠 —— 只保留「自己刷抖音」这一条主线:
 *
 *     ① 专用 Edge(Playwright 驱动,持久 profile,登录一次就一直有效)
 *     ② 进推荐流 → 循环:抽帧看画面 + 转写对白 → MiniMax 判断「值不值得继续看」
 *     ③ 决定换片 / 继续 / 停止 → 桌宠用碎碎念说出感想
 *
 * 砍掉的部分(桌宠场景用不上,而且耦合 DSH):
 *   QQ 私信回复、公开评论、自主分享、好友许可名单、
 *   群聊触发、每日额度账本(简化成简单的时长/次数上限)。
 *
 * ★ 模型后端:
 *   画面 → MiniMax Anthropic 兼容端点(electron/minimax-provider.ts)
 *   音频 → MiniMax /v1/speech_to_text(ASR)
 *   判断 → MiniMax LLM
 *   全部在 electron/video-understanding.ts 里,这里只管调度。
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { minimaxChat, type MiniMaxMessage } from './minimax-provider.js';
import { minimaxImageBlock, minimaxTranscribe } from './minimax-provider.js';
import { DouyinBrowserWorker } from './douyin-browser-worker-host.js';

/** 抖音推荐流地址。 */
export const DOUYIN_RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';

/** 专用 Edge 的 CDP 端口(避开常用的 9222,那个是我们的调试口)。 */
const EDGE_CDP_PORT = 9333;

/** 观看决策。 */
export type WatchDecision =
  | { action: 'continue'; reason: string }
  | { action: 'next'; reason: string }
  | { action: 'stop'; reason: string };

/** 一段视频的观察结果。 */
export interface VideoObservation {
  /** 作品 id(抖音的数字 id)。 */
  videoId: string;
  /** 作品页地址。 */
  url: string;
  /** 标题/文案(页面上抓的,不是模型看出来的)。 */
  title: string;
  /** 画面描述。 */
  visual: string;
  /** 对白转写。 */
  transcript: string;
  /** 综合理解。 */
  understanding: string;
  /** 抽帧文件(临时,用完要清)。 */
  frames: string[];
  /** 观察时刻。 */
  at: number;
}

/** 观看设置。 */
export interface DouyinWatchConfig {
  /** 总开关。 */
  enabled: boolean;
  /** 每次看多久(秒)——单次观看的时长上限。 */
  sessionSeconds: number;
  /** 每小时最多看多少分钟。0 = 不限。 */
  dailyMinutes: number;
  /** 允许的时段(本地时间 HH:MM-HH:MM)。空 = 全天。 */
  windows: string[];
  /** 每天最多看几条。0 = 不限。 */
  maxVideosPerDay: number;
}

/** 默认设置。 */
export const DEFAULT_WATCH_CONFIG: DouyinWatchConfig = {
  enabled: false,
  sessionSeconds: 300,
  dailyMinutes: 60,
  windows: [],
  maxVideosPerDay: 0,
};

/**
 * Playwright 页面 —— 我们只用到这几个方法,不用引入整个 playwright 类型
 * (playwright-core 是可选依赖,类型引入会让没装的人编译失败)。
 */
interface DouyinPage {
  goto: (url: string, opts?: unknown) => Promise<unknown>;
  waitForSelector: (selector: string, opts?: unknown) => Promise<unknown>;
  evaluate: (fn: string) => Promise<unknown>;
  screenshot: (opts?: unknown) => Promise<Buffer>;
  url: () => string;
}

/** Playwright 浏览器上下文。 */
interface DouyinContext {
  pages: () => DouyinPage[];
  newPage: () => Promise<DouyinPage>;
  close: () => Promise<void>;
}

/** 一天的用量账本。 */
interface UsageLedger {
  date: string;
  minutes: number;
  videos: number;
}

/** 运行时状态(内存态,重启即空)。 */
export interface DouyinRuntimeState {
  /** 浏览器起没起。 */
  browserReady: boolean;
  /** 当前在看的作品。 */
  current: VideoObservation | null;
  /** 本次会话已看。 */
  watched: number;
  /** 本次会话已看时长(秒)。 */
  elapsed: number;
  /** 最后一次错误。 */
  lastError?: string;
}

/**
 * 抖音刷视频控制器。
 *
 * 设计取舍:不把上游 core.mjs 那 1200 行整个搬过来 —— 它一半的复杂度在
 * DSH 的会话锁、许可名单、私信回执上,桌宠场景不需要。
 * 这里只保留「浏览 → 采样 → 判断 → 换片」这条主干,判据写得直白点。
 */
export class DouyinController {
  /**
   * 浏览器 worker —— 独立 Node 子进程里跑 Playwright。
   * ★ 不能在 Electron 主进程里直接 import playwright-core:
   *   它会用 process.execPath(= electron.exe) 拉 driver,导致桌宠窗口被关、
   *   触发 window-all-closed → app.quit() → 整个 App 退出。实测踩过。
   */
  private worker = new DouyinBrowserWorker();
  private profileDir: string;
  private stateDir: string;
  private config: DouyinWatchConfig = { ...DEFAULT_WATCH_CONFIG };
  private usage: UsageLedger = { date: todayKey(), minutes: 0, videos: 0 };
  private abort: AbortController | null = null;
  private state: DouyinRuntimeState = {
    browserReady: false,
    current: null,
    watched: 0,
    elapsed: 0,
  };
  /** 每次看完一条,回调一次(桌宠用它碎碎念)。 */
  private onWatched: ((obs: VideoObservation, decision: WatchDecision) => void) | null = null;

  constructor(opts: { profileDir?: string; stateDir?: string } = {}) {
    const base = app.getPath('userData');
    this.profileDir = opts.profileDir ?? path.join(base, 'douyin-profile');
    this.stateDir = opts.stateDir ?? path.join(base, 'douyin-state');
  }

  /** 设置回调。 */
  setOnWatched(cb: ((obs: VideoObservation, decision: WatchDecision) => void) | null): void {
    this.onWatched = cb;
  }

  /** 更新配置。 */
  updateConfig(cfg: Partial<DouyinWatchConfig>): DouyinWatchConfig {
    this.config = { ...this.config, ...cfg };
    return this.config;
  }

  getConfig(): DouyinWatchConfig {
    return this.config;
  }

  getState(): DouyinRuntimeState {
    return { ...this.state, current: this.state.current };
  }

  /**
   * 起专用 Edge。
   *
   * 用系统装的 Edge(channel: 'msedge'),不下载 Chromium —— 省 300MB+。
   * profile 是持久目录:登录一次就长期有效,不用每次重新扫码。
   */
  async startBrowser(): Promise<{ ok: boolean; error?: string }> {
    if (this.state.browserReady) return { ok: true };
    if (!existsSync(this.profileDir)) mkdirSync(this.profileDir, { recursive: true });
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });

    const res = await this.worker.start(this.profileDir, EDGE_CDP_PORT);
    this.state.browserReady = res.ok;
    if (!res.ok) {
      this.state.lastError = `起浏览器失败:${res.error ?? '未知'}`;
      return { ok: false, error: res.error };
    }
    return { ok: true };
  }

  /** 关浏览器。 */
  async stopBrowser(): Promise<void> {
    await this.worker.stop();
    this.state.browserReady = false;
  }

  /**
   * 去推荐流。
   *
   * 先把页面打开,再等推荐视频的元素出现 —— 直接 goto 常常拿到的是登录页
   * 或者空壳(抖音是前端渲染的)。
   */
  async openFeed(): Promise<{ ok: boolean; error?: string }> {
    if (!this.state.browserReady) return { ok: false, error: '浏览器没起' };
    const res = await this.worker.openFeed(DOUYIN_RECOMMEND);
    if (!res.ok) {
      this.state.lastError = `打开推荐流失败:${res.error ?? '未知'}`;
    }
    return res;
  }

  /**
   * 读当前页面状态(作品 id / 标题 / 播放进度)。
   *
   * 这一段对应上游 core.mjs 的 readPageState,但只取我们要的字段。
   */
  private async readPageState(): Promise<{
    videoId: string;
    url: string;
    title: string;
    playing: boolean;
    muted: boolean;
  }> {
    const state = await this.worker.readState();
    if (state) return state;
    return { videoId: '', url: '', title: '', playing: false, muted: false };
  }

  /**
   * 采样当前视频:抽帧 + 抽音轨 → MiniMax 理解。
   *
   * ★ 视频文件是从页面上拿不到文件的 —— 抖音的视频流是 blob/分片。
   *   所以这里的做法是**在页面里截屏 + 用 MediaRecorder 录一小段音轨**?
   *   不 —— 那太重。实际做法:
   *   用 Playwright 的 page.screenshot 逐帧截图(拿画面),
   *   音轨则用 WebAudio 从 <video> 元素实时采集。
   *
   *   这个函数只做「拿到帧和音轨数据」,交给上层理解。
   */
  private async captureCurrent(): Promise<{ frames: string[]; workDir: string } | null> {
    const payload = await this.worker.observe();
    if (!payload || !payload.frames.length) return null;
    return payload;
  }

  /**
   * 观察当前视频一次。
   *
   * 画面来自页面截图(不是下载视频文件 —— 抖音的视频是加密分片流,下不下来),
   * 对白来自音轨:这里用 MiniMax ASR 需要音频文件,而页面里的音轨拿不到文件,
   * 所以走「实时采集 → wav」的路子(见 captureAudio)。
   */
  async observeCurrent(apiKey: string, question?: string): Promise<VideoObservation | null> {
    const st = await this.readPageState();
    if (!st.videoId) return null;

    const captured = await this.captureCurrent();
    if (!captured || !captured.frames.length) return null;

    // 画面理解:逐帧问 MiniMax
    const visualParts: string[] = [];
    for (let i = 0; i < captured.frames.length; i++) {
      const { minimaxImageBlock } = await import('./minimax-provider.js');
      const block = await minimaxImageBlock(captured.frames[i]);
      if (!block) continue;
      const res = await minimaxChat({
        apiKey,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `这是短视频的第 ${i + 1} 个画面。客观描述画面里实际可见的内容(人物、场景、字幕、动作)。`,
              },
              block,
            ],
          },
        ],
        maxTokens: 600,
      });
      if (res.ok && res.text) visualParts.push(`[画面${i + 1}] ${res.text}`);
    }
    const visual = visualParts.join('\n');

    // 音轨 → MiniMax ASR
    const transcript = await this.transcribeAudio(apiKey, captured.workDir);

    // 合成理解
    const parts: string[] = [];
    if (visual) parts.push(`画面内容:\n${visual}`);
    if (transcript) parts.push(`语音转写:\n${transcript}`);
    parts.push('用一段话总结这个短视频在讲什么。');
    const final = await minimaxChat({
      apiKey,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
      maxTokens: 800,
    });

    const obs: VideoObservation = {
      videoId: st.videoId,
      url: st.url,
      title: st.title,
      visual,
      transcript,
      understanding: final.ok ? final.text : visual,
      frames: captured.frames,
      at: Date.now(),
    };
    this.state.current = obs;
    return obs;
  }

  /**
   * 从页面里把音轨录成 wav,再交给 MiniMax ASR。
   *
   * 抖音的视频是加密分片流,拿不到原始文件。办法是在页面里用 MediaRecorder
   * 从 <video> 元素实时录几秒 —— 录的是**已经解码播放出来的声音**。
   *
   * 返回 wav 文件路径(调用方负责删)。
   */
  private async transcribeAudio(apiKey: string, workDir: string): Promise<string> {
    try {
      const raw = await this.worker.requestAudio(workDir);
      if (!raw) return '';
      const wavPath = path.join(workDir, 'audio.wav');
      const { resolveFfmpeg } = await import('./video-understanding.js');
      const ffmpeg = await resolveFfmpeg();
      if (!ffmpeg) return '';
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync(
        ffmpeg,
        ['-y', '-i', raw, '-ar', '16000', '-ac', '1', '-b:a', '64k', wavPath],
        { timeout: 60_000 },
      );
      const res = await minimaxTranscribe({ apiKey, filePath: wavPath });
      return res.ok ? res.text : '';
    } catch (e) {
      this.state.lastError = `音轨转写失败:${e instanceof Error ? e.message : String(e)}`;
      return '';
    }
  }


  /**
   * 让 MiniMax 决定「继续看 / 换下一条 / 停」。
   *
   * 判据要具体 —— 泛泛地问「好不好看」模型会给出外交辞令。
   */
  async decide(apiKey: string, obs: VideoObservation): Promise<WatchDecision> {
    const messages: MiniMaxMessage[] = [
      {
        role: 'user',
        content:
          '你在替主人刷短视频。看了这一条之后,判断下一步怎么做。\n\n' +
          `视频标题:${obs.title || '(无)'}\n` +
          `画面:${(obs.visual || '(无)').slice(0, 800)}\n` +
          `对白:${(obs.transcript || '(无)').slice(0, 400)}\n\n` +
          '规则:\n' +
          '- 内容无聊/重复/让人不适 → 换下一条(next)\n' +
          '- 内容有意思/信息量大 → 继续看一会儿(continue)\n' +
          '- 已经看腻了或这一条质量明显下降 → 停(stop)\n\n' +
          '只回一个 JSON,不要别的文字:{"action":"continue|next|stop","reason":"一句话理由"}',
      },
    ];
    const res = await minimaxChat({ apiKey, messages, maxTokens: 300 });
    if (!res.ok) return { action: 'continue', reason: '模型判断失败,先继续看' };
    const m = /\{[\s\S]*\}/.exec(res.text);
    if (!m) return { action: 'continue', reason: '模型没给 JSON,继续看' };
    try {
      const obj = JSON.parse(m[0]) as { action?: string; reason?: string };
      const action = obj.action === 'next' || obj.action === 'stop' ? obj.action : 'continue';
      return { action, reason: obj.reason ?? '' };
    } catch {
      return { action: 'continue', reason: 'JSON 解析失败,继续看' };
    }
  }

  /**
   * 主循环:看 → 判断 → 换片 / 继续 / 停。
   *
   * 每轮之间 sleep 一小会(让页面自然推进),不是死循环。
   */
  async runWatchLoop(apiKey: string, maxRounds = 30): Promise<{ rounds: number; stopped: boolean }> {
    this.abort = new AbortController();
    let rounds = 0;
    while (rounds < maxRounds) {
      if (this.abort.signal.aborted) break;
      rounds++;

      const obs = await this.observeCurrent(apiKey);
      if (!obs) {
        // 没读到作品 —— 可能被弹到登录页/验证码页了,停
        this.state.lastError = '读不到当前作品(可能需要登录或过验证码)';
        break;
      }

      const decision = await this.decide(apiKey, obs);
      this.state.watched += 1;
      this.usage.videos += 1;
      this.onWatched?.(obs, decision);

      if (decision.action === 'stop') break;
      if (decision.action === 'next') {
        await this.nextVideo();
        await sleep(1500);
      } else {
        // 继续看 —— 等一段再判断
        await sleep(5000);
      }
    }
    return { rounds, stopped: this.abort.signal.aborted };
  }

  /** 下一条。 */
  async nextVideo(): Promise<void> {
    await this.worker.next();
  }

  /** 停。 */
  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** 读用量。 */
  getUsage(): UsageLedger {
    if (this.usage.date !== todayKey()) {
      this.usage = { date: todayKey(), minutes: 0, videos: 0 };
    }
    return { ...this.usage };
  }

  /** 是否在允许的时段内。 */
  inAllowedWindow(now = new Date()): boolean {
    if (!this.config.windows.length) return true;
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const w of this.config.windows) {
      const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(w.trim());
      if (!m) continue;
      const start = Number(m[1]) * 60 + Number(m[2]);
      let end = Number(m[3]) * 60 + Number(m[4]);
      if (end < start) end += 1440;
      const cur = minutes < 1440 ? minutes : minutes + 1440;
      if (cur >= start && cur < end) return true;
    }
    return false;
  }

  /** 是否超出今日额度。 */
  overQuota(): boolean {
    if (this.config.dailyMinutes > 0 && this.usage.minutes >= this.config.dailyMinutes) return true;
    if (this.config.maxVideosPerDay > 0 && this.usage.videos >= this.config.maxVideosPerDay) return true;
    return false;
  }
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
