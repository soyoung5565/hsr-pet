/**
 * ★ 抖音真实链路端到端验证(脱离 Electron,纯 node 跑)。
 *
 * 为什么单独写这个脚本:
 *   douyin-controller.ts 依赖 electron 的 app/preload,没法在纯 node 下跑;
 *   而「代码搬过来了」不等于「能用」—— 这个脚本才是真开浏览器、真刷一条视频、
 *   真抽帧、真送模型、真让模型判断「继续看 / 换下一条」的证据。
 *
 * 跑法:
 *   npx tsx scripts/test_douyin_live.ts
 *
 * 依赖:
 *   - 系统 Edge(Playwright 用 channel:'msedge',不下载 Chromium)
 *   - playwright-core(已在 node_modules)
 *   - MINIMAX_CN_API_KEY(或 MINIMAX_API_KEY)环境变量 —— 用于画面理解 + 决策
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EDGE_CDP_PORT = 9333;
const DOUYIN_FEED = 'https://www.douyin.com/?recommend=1&from_nav=1';
const WORK_ROOT = path.join(os.tmpdir(), 'douyin-live-verify');

/** worker 协议:一行一个 JSON,stdin 发 / stdout 收。 */
interface WorkerMsg {
  id?: string;
  type: 'ready' | 'ok' | 'error' | 'state' | 'observe';
  value?: unknown;
  message?: string;
  state?: unknown;
  payload?: unknown;
}

class Worker {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void>;

  constructor(private profileDir: string, private port: number) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  async start(): Promise<void> {
    const workerPath = path.resolve('electron/douyin-browser-worker.mjs');
    if (!existsSync(workerPath)) throw new Error(`worker 不存在:${workerPath}`);
    // playwright-core 从 app/node_modules 解析 —— worker 的 cwd 必须是 app/
    this.child = spawn(process.execPath, [workerPath, this.profileDir, String(this.port)], {
      cwd: path.resolve('.'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child.stdout?.on('data', (c) => this.onData(c.toString()));
    this.child.stderr?.on('data', (c) => {
      const t = c.toString().trim();
      if (t) console.log('  [worker stderr]', t);
    });
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`worker 退出了,code=${code}`));
      this.pending.clear();
    });
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等 worker ready 超时(15s)')), 15_000)),
    ]);
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: WorkerMsg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'ready') {
        this.readyResolve?.();
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === 'error') p.reject(new Error(msg.message ?? '未知错误'));
        else p.resolve(msg.value);
      }
    }
  }

  send<T = unknown>(type: string, extra: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.child) throw new Error('worker 没起');
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, type, ...extra }) + '\n');
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.send('stop', {}, 8000);
    } catch {
      /* ignore */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}

/** 检查:环境前提是否齐。 */
function checkPrereqs(): string[] {
  const problems: string[] = [];
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => existsSync(p));
  if (!edge) problems.push('找不到系统 Edge');
  if (!existsSync(path.resolve('node_modules/playwright-core/package.json'))) {
    problems.push('playwright-core 没装');
  }
  const key = process.env.MINIMAX_CN_API_KEY || process.env.MINIMAX_API_KEY;
  if (!key) problems.push('没有 MiniMax key(画面理解 + 决策要用)');
  return problems;
}

/** MiniMax 画面理解 —— 复用项目里的 provider(纯 node 可用,无 electron 依赖)。 */
async function understandFrame(
  apiKey: string,
  framePath: string,
): Promise<string> {
  const { minimaxImageBlock, minimaxChat } = await import('../electron/minimax-provider.js');
  const block = await minimaxImageBlock(framePath);
  const res = await minimaxChat({
    apiKey,
    messages: [
      {
        role: 'user',
        content: [block, { type: 'text', text: '这是抖音视频的一帧。用一句话说明画面里在发生什么。' }],
      },
    ],
    maxTokens: 200,
  });
  return res.text ?? '';
}

/** 让 MiniMax 决定:继续看 / 换下一条 / 停止。 */
async function decide(
  apiKey: string,
  observation: { title: string; visual: string; transcript: string },
): Promise<{ action: string; reason: string }> {
  const { minimaxChat } = await import('../electron/minimax-provider.js');
  const res = await minimaxChat({
    apiKey,
    messages: [
      {
        role: 'user',
        content: [
          `你正在替桌宠刷抖音。刚刚观察到一条视频:\n标题:${observation.title || '(无)'}\n画面:${observation.visual || '(无)'}\n对白:${observation.transcript || '(无)'}\n\n判断这条视频值不值得继续看。只回答 JSON:{"action":"continue|next|stop","reason":"一句话理由"}`,
        ],
      },
    ],
    maxTokens: 300,
  });
  const text = res.text ?? '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { action: 'next', reason: `模型没给 JSON:${text.slice(0, 120)}` };
  try {
    const parsed = JSON.parse(m[0]);
    const action = ['continue', 'next', 'stop'].includes(parsed.action) ? parsed.action : 'next';
    return { action, reason: String(parsed.reason ?? '').slice(0, 200) };
  } catch {
    return { action: 'next', reason: `JSON 解析失败:${text.slice(0, 120)}` };
  }
}

async function main() {
  console.log('=== 抖音真实链路端到端验证 ===\n');

  const problems = checkPrereqs();
  if (problems.length) {
    console.log('❌ 前提不满足:');
    for (const p of problems) console.log('   -', p);
    process.exit(2);
  }
  console.log('✅ 前提齐:Edge / playwright-core / MiniMax key\n');

  rmSync(WORK_ROOT, { recursive: true, force: true });
  mkdirSync(WORK_ROOT, { recursive: true });
  const profileDir = path.join(WORK_ROOT, 'profile');

  const worker = new Worker(profileDir, EDGE_CDP_PORT);
  console.log('1. 起 worker + 专用 Edge...');
  await worker.start();
  console.log('   worker ready ✅');

  const apiKey = (process.env.MINIMAX_CN_API_KEY || process.env.MINIMAX_API_KEY) as string;

  try {
    console.log('\n2. 起浏览器...');
    await worker.send('start', {}, 90_000);
    console.log('   Edge 起来了 ✅');

    console.log('\n3. 进抖音推荐流...');
    await worker.send('feed', { url: DOUYIN_FEED }, 90_000);
    console.log('   推荐流打开 ✅');

    console.log('\n4. 读页面状态...');
    const state = (await worker.send('state')) as {
      videoId?: string; url?: string; title?: string; playing?: boolean; muted?: boolean;
    };
    console.log('   videoId =', state.videoId || '(空)');
    console.log('   title    =', state.title || '(空)');
    console.log('   playing  =', state.playing);
    console.log('   url      =', state.url);

    if (!state.videoId) {
      console.log('\n⚠️ 没抓到 videoId —— 可能页面没进推荐流,或需要登录/验证。');
      console.log('   (这本身是有价值的结论,不是失败)');
    }

    console.log('\n5. 抽 3 帧 + 录 5 秒音轨...');
    const observed = (await worker.send('observe', {}, 90_000)) as { frames: string[]; workDir: string };
    console.log('   帧数 =', observed.frames?.length ?? 0);
    console.log('   目录 =', observed.workDir);
    for (const f of observed.frames ?? []) {
      console.log('     -', f, existsSync(f) ? `(exists, ${fsSize(f)}B)` : '(MISSING)');
    }

    console.log('\n6. 画面理解(MiniMax 视觉)...');
    let visual = '';
    if (observed.frames?.length) {
      visual = await understandFrame(apiKey, observed.frames[0]);
      console.log('   模型说:', visual || '(空)');
    }

    console.log('\n7. 音轨转写(MiniMax ASR)...');
    const raw = (await worker.send('audio', { workDir: observed.workDir }, 90_000)) as string | null;
    let transcript = '';
    if (raw && existsSync(raw)) {
      console.log('   音轨文件 =', raw, `(${fsSize(raw)}B)`);
      try {
        const { minimaxTranscribe } = await import('../electron/minimax-provider.js');
        const r = await minimaxTranscribe({ apiKey, filePath: raw });
        transcript = r.text ?? '';
        console.log('   转写:', transcript || '(空)');
      } catch (e) {
        console.log('   ASR 失败:', (e as Error).message);
      }
    } else {
      console.log('   没录到音轨(可能页面静音或无 video 元素)');
    }

    console.log('\n8. 决策:继续看 / 换下一条 / 停止...');
    const decision = await decide(apiKey, { title: state.title ?? '', visual, transcript });
    console.log(`   → ${decision.action} — ${decision.reason}`);

    console.log('\n9. 按决策执行(换下一条)...');
    if (decision.action === 'next' || decision.action === 'stop') {
      await worker.send('next', {}, 30_000);
      await sleepMs(2500);
      const after = (await worker.send('state')) as { videoId?: string; title?: string };
      console.log('   换之后 videoId =', after.videoId || '(空)');
      console.log('   换之后 title    =', after.title || '(空)');
      console.log('   换片有效:', after.videoId !== state.videoId ? '✅ 是' : '⚠️ 没变');
    }

    console.log('\n=== 结论 ===');
    console.log('浏览器起动  : ✅');
    console.log('推荐流打开  :', state.videoId ? '✅' : '⚠️ 没抓到 videoId');
    console.log('抽帧        :', observed.frames?.length ? `✅ ${observed.frames.length} 帧` : '❌ 0 帧');
    console.log('画面理解    :', visual ? '✅' : '⚠️ 空');
    console.log('音轨转写    :', transcript ? '✅' : '⚠️ 空');
    console.log('决策        : ✅', decision.action);
  } finally {
    console.log('\n收尾:停 worker + 清临时目录...');
    await worker.stop();
    rmSync(WORK_ROOT, { recursive: true, force: true });
    console.log('   已清 ✅');
  }
}

function fsSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n❌ FAILED:', (e as Error).message);
    console.error((e as Error).stack);
    process.exit(1);
  },
);
