/**
 * 探针:查桌宠抖音录音为什么是静音。
 *
 * 三个候选根因,一次查清:
 *   A) AudioContext 处于 suspended(没调 resume())→ MediaRecorder 录到静音
 *   B) document.querySelector('video') 选错了元素(选到没在播的预加载视频)
 *   C) 选中的 video 是 muted / volume=0 → MediaElementAudioSourceNode 输出静音
 *
 * 用法:node probe_audio_rootcause.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.HERMES_HOME || 'D:/hermes-data';
const profileDir = path.join(HOME, 'browser-profile', 'douyin');
const playwrightRoot = path.join(HOME, 'plugins', 'hermes-douyin-pet', 'node_modules', 'playwright-core');

const { chromium } = await import(pathToFileURL(path.join(playwrightRoot, 'index.mjs')).href);

const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ['--mute-audio'],
  args: [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  // ---- 候选 A/B/C 的状态采集 ----
  const info = await page.evaluate(`(() => {
    const vids = Array.from(document.querySelectorAll('video'));
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const describe = (v) => v ? ({
      paused: v.paused, muted: v.muted, volume: v.volume,
      currentTime: Number(v.currentTime.toFixed(2)),
      duration: Number((v.duration||0).toFixed(2)),
      readyState: v.readyState, src: (v.currentSrc||v.src||'').slice(0, 90),
      w: v.videoWidth, h: v.videoHeight,
      inActive: !!(active && active.contains(v)),
      isActiveEl: v === active,
    }) : null;
    return {
      url: location.href,
      videoCount: vids.length,
      activeEl: describe(active && active.tagName === 'VIDEO' ? active : null),
      first: describe(vids[0]),
      all: vids.map(describe),
    };
  })()`);
  console.log('=== 页面/视频元素状态 ===');
  console.log(JSON.stringify(info, null, 2));

  // ---- 候选 A:AudioContext 的 state ----
  const ctxState = await page.evaluate(`(() => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return { err: 'no AudioContext' };
    const c = new Ctx();
    const before = c.state;
    return { before, sampleRate: c.sampleRate };
  })()`);
  console.log('\n=== AudioContext 初始 state ===');
  console.log(JSON.stringify(ctxState));

  // ---- 复现插件的录音逻辑,分别测「不 resume」和「resume 后」 ----
  const rec = async (doResume) => await page.evaluate(`(async () => {
    const v = document.querySelector('video');
    if (!v) return { err: 'no video' };
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let resumed = null;
    if (${doResume}) {
      try { await ctx.resume(); resumed = ctx.state; } catch (e) { resumed = 'err:' + e.message; }
    }
    const src = ctx.createMediaElementSource(v);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest); src.connect(ctx.destination);
    const chunks = [];
    const recorder = new MediaRecorder(dest.stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    await new Promise(r => setTimeout(r, 5000));
    recorder.stop();
    const blob = await new Promise(r => recorder.onstop = () => r(new Blob(chunks, { type: 'audio/webm' })));
    const buf = new Uint8Array(await blob.arrayBuffer());
    ctx.close();
    return { ctxStateDuring: ctx.state, resumed: ${doResume} ? resumed : 'skipped',
             bytes: buf.length, videoMuted: v.muted, videoVolume: v.volume };
  })()`);
  console.log('\n=== 录音复现:不 resume ===');
  console.log(JSON.stringify(await rec(false)));
  console.log('\n=== 录音复现:resume 后 ===');
  console.log(JSON.stringify(await rec(true)));
} finally {
  await ctx.close().catch(() => {});
}
