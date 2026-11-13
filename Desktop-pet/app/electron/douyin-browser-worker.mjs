/**
 * 抖音专用浏览器 worker —— **跑在独立 Node 进程里**,管 Playwright 和 Edge。
 *
 * ★ 为什么单独一个文件:
 *   Playwright 必须在真正的 node.exe 下跑(不是 electron.exe),
 *   所以这段代码不在 Electron 主进程里,而是 spawn 出来的子进程。
 *   见 douyin-browser-worker-host.ts 的注释。
 *
 * 通信:stdin/stdout,一行一个 JSON。
 *   读 {"id","type",...} → 做 → 回 {"id","type":"ok","value":...} 或 {"id","type":"error","message":...}
 *   主动事件(state/observe/transcript)不带 id。
 *
 * 用法:node douyin-browser-worker.mjs <profileDir> <port>
 */

import fs from 'node:fs';
import path from 'node:path';

const profileDir = process.argv[2];
const port = Number(process.argv[3] || 9333);

if (!profileDir) {
  process.stderr.write('用法:node douyin-browser-worker.mjs <profileDir> <port>\n');
  process.exit(2);
}

/** 回一条消息。 */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** 回请求的结果。 */
function reply(id, value) {
  send({ id, type: 'ok', value });
}

/** 回请求的失败。 */
function fail(id, message) {
  send({ id, type: 'error', message: String(message) });
}

/** 主动报错(不带 id)。 */
function reportError(message) {
  send({ type: 'error', message: String(message) });
}

let context = null;
let page = null;

/** 起浏览器。 */
async function startBrowser() {
  if (context) return;
  // playwright-core 从 app/node_modules 找(worker 的 cwd 是 electron/)
  const { chromium } = await import('playwright-core');
  fs.mkdirSync(profileDir, { recursive: true });
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    // 不静音 —— 用户要听见视频声音
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      // 自动播放策略放宽,否则 <video> 播不了
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const pages = context.pages();
  page = pages.length ? pages[0] : await context.newPage();
  context.on('close', () => {
    context = null;
    page = null;
  });
}

/** 读当前页面状态。 */
async function readState() {
  if (!page) throw new Error('浏览器没起');
  return await page.evaluate(`(() => {
    const v = document.querySelector('video');
    const url = location.href;
    const m = /\\/video\\/(\\d{1,64})/.exec(url);
    const og = document.querySelector('meta[property="og:title"]')?.content || '';
    let desc = og;
    if (!desc) {
      const el = document.querySelector('[data-e2e="video-desc"], .video-info-detail, h1');
      desc = el ? (el.textContent || '').trim() : '';
    }
    return {
      videoId: m ? m[1] : '',
      url,
      title: (desc || '').slice(0, 200),
      playing: !!v && !v.paused && v.currentTime > 0,
      muted: v ? v.muted : false,
    };
  })()`);
}

/** 抽 3 帧 + 录一小段音轨。 */
async function observe() {
  if (!page) throw new Error('浏览器没起');
  const workDir = path.join(profileDir, '..', 'douyin-state', `cap-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const frames = [];
  for (let i = 0; i < 3; i++) {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
      const fp = path.join(workDir, `f${i}.jpg`);
      fs.writeFileSync(fp, buf);
      frames.push(fp);
    } catch {
      break;
    }
    await sleep(1200);
  }
  return { frames, workDir };
}

/**
 * 录 5 秒音轨(webm/opus),存成文件路径返回。
 *
 * ★★ 三个真 bug(2026-11-14 在插件版实测定位,这里是同一份代码的内置兜底副本):
 *   ① `document.querySelector('video')` 会选中**预加载的幽灵视频**
 *      (实测 readyState=0 / muted / volume=0 / videoWidth=0)→ 录出来必然静音。
 *      修法:优先取 `[data-e2e="feed-active-video"]` 里的 video,
 *      并要求 readyState>=2 && videoWidth>0。
 *   ② 视频被静音时 MediaElementSource 拿到的还是静音流 → 录音前临时解除。
 *   ③ `createMediaElementSource` 对同一 video 只能调一次,第二次抛
 *      InvalidStateError → 第二条视频开始整轮崩。每元素缓存 AudioNode。
 */
async function captureAudio(workDir) {
  if (!page) return null;
  const b64 = await page.evaluate(`(async () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return '';

    const pickVideo = () => {
      const active = document.querySelector('[data-e2e="feed-active-video"]');
      const candidates = [];
      if (active && active.tagName === 'VIDEO') candidates.push(active);
      if (active) {
        const inner = active.querySelector('video');
        if (inner) candidates.push(inner);
      }
      candidates.push(...Array.from(document.querySelectorAll('video')));
      for (const v of candidates) {
        if (!v) continue;
        if (v.readyState >= 2 && v.videoWidth > 0 && !v.paused) return v;
      }
      for (const v of candidates) {
        if (v && v.videoWidth > 0 && v.readyState >= 2) return v;
      }
      return candidates[0] || null;
    };

    const v = pickVideo();
    if (!v || v.readyState < 2) return '';

    const prevMuted = v.muted;
    const prevVolume = v.volume;
    try { v.muted = false; v.volume = 1; } catch { /* ignore */ }

    const key = '__hermesAudioNode__';
    if (!v[key]) {
      const ctx0 = new Ctx();
      try { await ctx0.resume(); } catch { /* ignore */ }
      const node = ctx0.createMediaElementSource(v);
      node.connect(ctx0.destination);
      v[key] = { ctx: ctx0, node };
    }
    const holder = v[key];
    const ctx = holder.ctx;
    try { await ctx.resume(); } catch { /* ignore */ }
    const dest = ctx.createMediaStreamDestination();
    holder.node.connect(dest);

    const recorder = new MediaRecorder(dest.stream);
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    await new Promise(r => setTimeout(r, 5000));
    recorder.stop();
    const blob = await new Promise(r => recorder.onstop = () => r(new Blob(chunks, { type: 'audio/webm' })));
    try { holder.node.disconnect(dest); } catch { /* ignore */ }
    try { v.muted = prevMuted; v.volume = prevVolume; } catch { /* ignore */ }

    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  })()`);
  if (!b64) return null;
  const raw = path.join(workDir, 'audio.raw');
  fs.writeFileSync(raw, Buffer.from(b64, 'base64'));
  return raw;
}

/** 换下一条。 */
async function nextVideo() {
  if (!page) return;
  await page.evaluate(`(() => {
    const next = document.querySelector('[data-e2e="video-next"], .xg-icon-arrow-right');
    if (next) { next.click(); return; }
    window.scrollBy(0, window.innerHeight);
  })()`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 处理一条请求。 */
async function handle(msg) {
  const { id, type } = msg;
  switch (type) {
    case 'start': {
      await startBrowser();
      reply(id, { port });
      break;
    }
    case 'feed': {
      if (!page) throw new Error('浏览器没起');
      await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // 抖音是前端渲染的 —— 直接 goto 常拿到空壳,要等 video 元素
      await page.waitForSelector('video', { timeout: 20_000 });
      reply(id, true);
      break;
    }
    case 'state': {
      const state = await readState();
      reply(id, state);
      send({ type: 'state', state });
      break;
    }
    case 'observe': {
      const payload = await observe();
      reply(id, payload);
      send({ type: 'observe', payload });
      break;
    }
    case 'audio': {
      const raw = await captureAudio(msg.workDir || path.join(profileDir, '..', 'douyin-state'));
      reply(id, raw);
      break;
    }
    case 'next': {
      await nextVideo();
      reply(id, true);
      break;
    }
    case 'stop': {
      try {
        await context?.close();
      } catch {
        /* ignore */
      }
      context = null;
      page = null;
      reply(id, true);
      process.exit(0);
      break;
    }
    default:
      fail(id, `不支持的请求:${type}`);
  }
}

/** 读 stdin 的行。 */
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      reportError('收到非 JSON 行');
      continue;
    }
    handle(msg).catch((e) => {
      if (msg?.id) fail(msg.id, e?.message ?? String(e));
      else reportError(e?.message ?? String(e));
    });
  }
});

// 子进程被杀掉时,把 Edge 也带走(不留孤儿浏览器)
process.on('SIGTERM', async () => {
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
process.on('SIGINT', async () => {
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

// 启动时先不自动起浏览器 —— 等主进程下 start 指令
send({ type: 'ready' });
