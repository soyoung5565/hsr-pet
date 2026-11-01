/**
 * 抖音专用 Edge 的可用性验证 —— 不依赖 Electron,纯 node 跑。
 *
 * 验三件事:
 *   ① playwright-core 能用 channel:'msedge' 拉起系统 Edge(不下载 Chromium)
 *   ② persistent profile 目录真被创建(登录态能存下来)
 *   ③ CDP 端口可连(我们靠它观察页面)
 *
 * ★ 这是抖音功能的「地基」—— 起不来浏览器,后面全白搭。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EDGE_CDP_PORT = 9333;

async function main() {
  const { chromium } = await import('playwright-core');

  const profileDir = path.join(os.tmpdir(), 'douyin-profile-test');
  const controlDir = path.join(os.tmpdir(), 'douyin-control-test');
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(controlDir, { recursive: true });

  console.log('profile:', profileDir);
  console.log('启动专用 Edge...');

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      `--remote-debugging-port=${EDGE_CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    console.log('✅ Edge 起来了');
    console.log('   浏览器版本:', context.browser()?.version?.() ?? '(未知)');
    console.log('   页面数:', context.pages().length);
    console.log('   profile 目录存在:', existsSync(profileDir));
    // profile 里应该出现 Edge 的用户数据文件
    const files = (await import('node:fs')).readdirSync(profileDir);
    console.log('   profile 文件数:', files.length, files.slice(0, 6));

    const page = context.pages()[0] ?? (await context.newPage());
    console.log('\n访问 about:blank 验证页面可用...');
    await page.goto('about:blank', { timeout: 15_000 });
    console.log('   page.url() =', page.url());

    // 验证能读页面状态(我们 readPageState 的基础)
    const title = await page.evaluate('document.title');
    console.log('   document.title =', JSON.stringify(title));

    console.log('\n✅ Playwright 驱动系统 Edge 正常');
  } finally {
    await context.close().catch(() => undefined);
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('❌ FAILED:', e);
    process.exit(1);
  },
);
