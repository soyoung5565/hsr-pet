/**
 * 抖音专用浏览器的 **独立 Node 子进程** —— 跑 Playwright,管 Edge。
 *
 * ★ 为什么必须独立进程(这是本轮最大的坑):
 *   Playwright 在 Electron 主进程里 import 时,会用 `process.execPath` 去拉
 *   自己的 driver —— 而在 Electron 里 `process.execPath` 是 **electron.exe**。
 *   于是 Electron 被当成浏览器启动,行为全乱,表现是:
 *     - 桌宠窗口莫名关闭 → 触发 `window-all-closed` → `app.quit()` → 整个 App 退出
 *     - 或者 Edge 起不来 / 起成 Electron 的壳
 *   实测踩过:调一次 douyinStart,桌宠进程直接没了(exit 0,无堆栈)。
 *
 *   正确做法(与上游 dsh-douyin-agent 一致):spawn 一个**真正的 node.exe**,
 *   由它跑 Playwright。Electron 只通过 stdio 跟它说话。
 *
 * 协议(主进程 ←→ 子进程,一行一个 JSON):
 *   ← {"type":"start","profile":"...","port":9333}
 *   → {"type":"started","port":9333}
 *   → {"type":"state","videoId":"...","url":"...","title":"...","playing":true}
 *   → {"type":"observe","frames":["..."],"workDir":"..."}
 *   → {"type":"transcript","text":"..."}
 *   → {"type":"error","message":"..."}
 *
 *   ← {"type":"next"}
 *   ← {"type":"stop"}
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BrowserStatePayload {
  videoId: string;
  url: string;
  title: string;
  playing: boolean;
  muted: boolean;
}

export interface ObservePayload {
  frames: string[];
  workDir: string;
}

/** 子进程发回来的消息。 */
export type BrowserWorkerMessage =
  | { type: 'started'; port: number }
  | { type: 'state'; state: BrowserStatePayload }
  | { type: 'observe'; payload: ObservePayload }
  | { type: 'transcript'; text: string }
  | { type: 'next' }
  | { type: 'error'; message: string };

/**
 * worker 脚本的默认位置。
 *
 * dev 态:electron/douyin-browser-worker.mjs(源码目录)
 * 打包态:dist-electron/douyin-browser-worker.mjs(vite 的拷贝插件放进去的)
 *
 * 两个都试一遍 —— 先试打包目录(生产),再试源码目录(dev)。
 */
function defaultWorkerScript(): string {
  const candidates = [
    path.join(__dirname, 'douyin-browser-worker.mjs'),
    path.resolve(__dirname, '..', 'electron', 'douyin-browser-worker.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * 找一个**独立**的 node.exe。
 *
 * 不能用 process.execPath —— 在 Electron 里那是 electron.exe。
 * 找法(按优先级):
 *   ① 环境变量 HERMES_NODE / DOUYIN_NODE_EXECUTABLE 指定的
 *   ② PATH 里的 node.exe
 *   ③ Hermes 自带的 node 目录
 *   ④ 开发环境常见的几个位置
 */
export function resolveNodeExecutable(): string | null {
  const env = process.env;
  const explicit = env.DOUYIN_NODE_EXECUTABLE || env.HERMES_NODE;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';

  // PATH 里的
  const searchPath = (env.PATH || env.Path || '')
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && path.isAbsolute(d));
  for (const dir of searchPath) {
    const candidate = path.join(dir, nodeName);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Hermes 自带的 node
  const hermesTools = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools');
  try {
    for (const entry of fs.readdirSync(hermesTools)) {
      if (!entry.startsWith('node-')) continue;
      const candidate = path.join(hermesTools, entry, 'node.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* 目录不存在 */
  }

  // 本机常见的 Node 安装位置
  const common = [
    'C:/Program Files/nodejs/node.exe',
    'D:/nodejs/node.exe',
    'D:/hermes-data/node/node.exe',
  ];
  for (const candidate of common) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * 浏览器 worker 的宿主(在 Electron 主进程这一侧)。
 *
 * 职责:spawn 子进程、收发 JSON、超时控制、状态缓存。
 */
export class DouyinBrowserWorker {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private state: BrowserStatePayload | null = null;
  /** 观察请求的回调(子进程把帧传回来时用)。 */
  private onObserve: ((p: ObservePayload) => void) | null = null;
  private onTranscript: ((text: string) => void) | null = null;
  private onError: ((message: string) => void) | null = null;
  /** 最近一次错误。 */
  lastError: string | null = null;
  /** 浏览器就绪没。 */
  ready = false;

  constructor(private readonly workerScript: string = defaultWorkerScript()) {}

  setHandlers(h: {
    onObserve?: (p: ObservePayload) => void;
    onTranscript?: (text: string) => void;
    onError?: (message: string) => void;
  }): void {
    this.onObserve = h.onObserve ?? null;
    this.onTranscript = h.onTranscript ?? null;
    this.onError = h.onError ?? null;
  }

  getState(): BrowserStatePayload | null {
    return this.state;
  }

  /**
   * 起子进程 + 起浏览器。
   *
   * @param profile 持久 profile 目录(登录态存这里)
   * @param port    CDP 端口
   */
  async start(profile: string, port: number): Promise<{ ok: boolean; error?: string }> {
    if (this.child) return { ok: true };
    const node = resolveNodeExecutable();
    if (!node) {
      const msg = '找不到独立 Node.js —— Playwright 不能在 Electron 主进程里跑';
      this.lastError = msg;
      return { ok: false, error: msg };
    }
    if (!fs.existsSync(this.workerScript)) {
      const msg = `找不到 worker 脚本:${this.workerScript}`;
      this.lastError = msg;
      return { ok: false, error: msg };
    }

    try {
      this.child = spawn(node, [this.workerScript, profile, String(port)], {
        cwd: path.dirname(this.workerScript),
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const msg = `起浏览器子进程失败:${e instanceof Error ? e.message : String(e)}`;
      this.lastError = msg;
      return { ok: false, error: msg };
    }

    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      this.lastError = text.slice(0, 500);
      // eslint-disable-next-line no-console
      console.warn('[douyin-worker]', text.slice(0, 300));
    });
    this.child.on('exit', (code) => {
      this.ready = false;
      this.child = null;
      this.failAll(new Error(`浏览器子进程退出(code=${code})`));
    });

    const res = await this.request('start', { profile, port }, 90_000);
    if (res.ok) {
      this.ready = true;
      return { ok: true };
    }
    return { ok: false, error: this.lastError ?? '起浏览器失败' };
  }

  /** 读当前页面状态。 */
  async readState(timeoutMs = 15_000): Promise<BrowserStatePayload | null> {
    const res = await this.request('state', {}, timeoutMs);
    return res.ok ? ((res.value as BrowserStatePayload) ?? null) : null;
  }

  /** 抽帧(3 帧)+ 录一小段音轨。 */
  async observe(timeoutMs = 60_000): Promise<ObservePayload | null> {
    const res = await this.request('observe', {}, timeoutMs);
    return res.ok ? ((res.value as ObservePayload) ?? null) : null;
  }

  /** 去推荐流(打开抖音首页,等视频元素出现)。 */
  async openFeed(url: string, timeoutMs = 60_000): Promise<{ ok: boolean; error?: string }> {
    const res = await this.request('feed', { url }, timeoutMs);
    if (res.ok) return { ok: true };
    return { ok: false, error: this.lastError ?? '打开推荐流失败' };
  }

  /** 录一小段音轨,返回原始文件路径(webm/opus)。 */
  async requestAudio(workDir: string, timeoutMs = 30_000): Promise<string | null> {
    const res = await this.request('audio', { workDir }, timeoutMs);
    return res.ok ? ((res.value as string) ?? null) : null;
  }

  /** 换下一条。 */
  async next(timeoutMs = 20_000): Promise<void> {
    await this.request('next', {}, timeoutMs);
  }

  /** 停。 */
  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      this.request('stop', {}, 5_000).catch(() => undefined);
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (!this.child) return resolve();
      const timer = setTimeout(() => {
        try {
          this.child?.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 4000);
      this.child?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.ready = false;
  }

  /** 发一条请求并等它的结果。 */
  private request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; value?: unknown }> {
    if (!this.child || !this.child.stdin) {
      return Promise.resolve({ ok: false });
    }
    const id = `r${++this.seq}`;
    const line = JSON.stringify({ id, type, ...payload }) + '\n';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve({ ok: true, value: v }),
        reject: () => resolve({ ok: false }),
        timer,
      });
      try {
        this.child!.stdin!.write(line);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false });
      }
    });
  }

  /** 解析子进程输出。 */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: BrowserWorkerMessage & { id?: string };
      try {
        msg = JSON.parse(line) as BrowserWorkerMessage & { id?: string };
      } catch {
        // eslint-disable-next-line no-console
        console.warn('[douyin-worker] 非 JSON 行:', line.slice(0, 200));
        continue;
      }

      // 带 id 的 = 请求的回复
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if ((msg as { type: string }).type === 'error') {
            this.lastError = (msg as { message: string }).message;
            pending.reject(new Error(this.lastError));
          } else {
            pending.resolve((msg as { value?: unknown }).value);
          }
        }
        continue;
      }

      // 不带 id 的 = 主动事件
      switch (msg.type) {
        case 'state':
          this.state = (msg as { state: BrowserStatePayload }).state;
          break;
        case 'observe':
          this.onObserve?.((msg as { payload: ObservePayload }).payload);
          break;
        case 'transcript':
          this.onTranscript?.((msg as { text: string }).text);
          break;
        case 'error':
          this.lastError = (msg as { message: string }).message;
          this.onError?.(this.lastError);
          break;
        default:
          break;
      }
    }
  }

  /** 子进程死了,把所有等待中的请求判死。 */
  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
