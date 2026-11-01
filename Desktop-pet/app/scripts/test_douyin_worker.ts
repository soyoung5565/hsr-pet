/**
 * 浏览器 worker 子进程验证 —— 确认「独立 Node 进程跑 Playwright」这条路通。
 *
 * ★ 这是本轮最关键的一个坑:
 *   Playwright 不能在 Electron 主进程里跑(它会用 process.execPath=electron.exe
 *   拉 driver,导致桌宠窗口被关 → window-all-closed → app.quit() → 整个 App 退出)。
 *   解法是 spawn 真正的 node.exe,由它跑 Playwright。
 *   本脚本模拟主进程那一侧:起 worker → start → state → observe → stop。
 *
 * 用法:npx tsx scripts/test_douyin_worker.ts
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const WORKER = path.join(process.cwd(), 'electron', 'douyin-browser-worker.mjs');

function findNode(): string | null {
  const explicit = process.env.DOUYIN_NODE_EXECUTABLE;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const c = path.join(dir, nodeName);
    if (fs.existsSync(c)) return c;
  }
  const tools = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools');
  try {
    for (const e of fs.readdirSync(tools)) {
      if (!e.startsWith('node-')) continue;
      const c = path.join(tools, e, 'node.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function main() {
  const node = findNode();
  if (!node) throw new Error('找不到 node.exe');
  console.log('用这个 node:', node);
  console.log('worker:', WORKER);
  if (!fs.existsSync(WORKER)) throw new Error('worker 脚本不存在');

  const profileDir = path.join(os.tmpdir(), 'dy-worker-test-profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const child = spawn(node, [WORKER, profileDir, '9334'], {
    cwd: path.join(process.cwd(), 'electron'),
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const waiters = new Map<string, (v: any) => void>();

  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      console.log('  <-', line.slice(0, 160));
      try {
        const msg = JSON.parse(line);
        if (msg.id && waiters.has(msg.id)) {
          waiters.get(msg.id)!(msg);
          waiters.delete(msg.id);
        }
      } catch {
        /* 非 JSON */
      }
    }
  });
  child.stderr!.on('data', (c: Buffer) => {
    const t = c.toString('utf-8').trim();
    if (t) console.log('  [stderr]', t.slice(0, 200));
  });

  let seq = 0;
  const request = (type: string, payload: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = `t${++seq}`;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`${type} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      waiters.set(id, (v) => {
        clearTimeout(timer);
        if (v.type === 'error') reject(new Error(v.message));
        else resolve(v.value);
      });
      child.stdin!.write(JSON.stringify({ id, type, ...payload }) + '\n');
    });

  console.log('\n[1] 起浏览器...');
  await request('start', {}, 120_000);
  console.log('OK 浏览器起来了');

  console.log('\n[2] 读页面状态(about:blank)...');
  const st = await request('state', {}, 20_000);
  console.log('   state =', JSON.stringify(st));

  console.log('\n[3] 抽 3 帧...');
  const obs = await request('observe', {}, 60_000);
  console.log('   frames =', obs.frames?.length, 'workDir =', obs.workDir);
  for (const f of obs.frames ?? []) {
    console.log(`     ${path.basename(f)}: ${fs.existsSync(f) ? fs.statSync(f).size + 'B' : '不存在!'}`);
  }

  console.log('\n[4] 录音轨...');
  const raw = await request('audio', { workDir: obs.workDir }, 40_000);
  console.log('   raw =', raw ? `${raw} (${fs.existsSync(raw) ? fs.statSync(raw).size + 'B' : '不存在'})` : '(无音轨)');

  console.log('\n[5] 停...');
  await request('stop', {}, 15_000);
  await new Promise((r) => setTimeout(r, 1500));

  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log('\nOK worker 子进程全链路通过');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('FAILED:', e);
    process.exit(1);
  },
);
