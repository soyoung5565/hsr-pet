/**
 * ★ 桌宠 → Hermes → douyin_watch 插件 真实链路验收(Node 版)。
 *
 * 为什么用 Node 而不是 Python:
 *   这个脚本要**完全复刻桌宠 electron/agent-bridge.ts 的调用方式**
 *   —— spawn('.cmd', args, { shell: true })。
 *   Python 的 shell=True 用的是 list2cmdline,和 Node 对 cmd.exe 的转义规则不同:
 *   实测 Python 版会把 `-m` / `--provider` 吞掉 → 仍走默认 provider → 撞火山 429。
 *   桌宠本体走的是 Node,所以验证必须用 Node,否则测的不是真链路。
 *
 * 跑法:
 *   cd D:/hsr-pet/Desktop-pet/app && npx tsx scripts/test_douyin_plugin_chain.ts
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const HERMES_CMD = 'D:/hermes-data/bin/hermes.cmd';
const HERMES_CWD = 'D:/hermes-data/hermes-agent';

/** 桌宠 electron/douyin-plugin-bridge.ts 的提示词构造(保持一致)。 */
function buildWatchPrompt(maxVideos: number, secondsPerVideo: number): string {
  return [
    '请调用 hermes-douyin-pet 插件的 douyin_watch 工具,让桌宠自己刷抖音。',
    `参数:max_videos=${maxVideos}, seconds_per_video=${secondsPerVideo}。`,
    '调用成功后,用一句口语化的话(40 字以内,像在跟主人聊天)总结刚才看到的内容并作为输出。',
    '不要解释你做了什么,不要用列表,只说那一句感想。',
  ].join('\n');
}

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    // ★ 必须和桌宠 agent-bridge 完全一致:走 cmd.exe /c,参数用数组传。
    //   用 shell:true 的话,prompt 里的换行会被 cmd.exe 当成命令分隔符,
    //   后半截变成独立命令 → "hermes: 'xxx' is not a 'hermes' command."
    const child = spawn('cmd.exe', ['/c', HERMES_CMD, ...args], {
      windowsHide: true,
      cwd: HERMES_CWD,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    // ★ 超时必须杀整棵树:只 kill cmd.exe 会留下真 hermes python 孤儿,
    //   它还占着模型配额,而且它的 stdout 管道还开着 → 本进程等不到 exit(实测卡死)。
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill();
        }
      } catch { /* ignore */ }
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function main() {
  console.log('='.repeat(68));
  console.log('★ 桌宠 → Hermes → douyin_watch 插件 真实链路验收');
  console.log('='.repeat(68));

  if (!fs.existsSync(HERMES_CMD)) {
    console.log(`❌ 找不到 ${HERMES_CMD}`);
    process.exit(2);
  }

  const maxVideos = Number(process.env.DY_MAX_VIDEOS ?? 2);
  const prompt = buildWatchPrompt(maxVideos, 6);

  console.log('\n=== 桌宠会发的 prompt ===');
  console.log(prompt);

  console.log('\n=== 参数(模拟桌宠 agent-bridge)===');
  // ★ 参数顺序:模型/提供方必须在 -z 之前(见 agent-bridge.ts 的注释)
  // ★ 默认**不带** -m/--provider:和桌宠默认配置一致(走 Hermes 宿主默认模型)。
  //   2026-11-13 实测:minimax-cn 429、kimi(newapi) 挂死、volcengine+ds 404,
  //   只有「不覆盖」这条是好的。要测覆盖时用 DY_MODEL / DY_PROVIDER 环境变量。
  const args = [
    ...(process.env.DY_MODEL ? ['-m', process.env.DY_MODEL] : []),
    ...(process.env.DY_PROVIDER ? ['--provider', process.env.DY_PROVIDER] : []),
    '-z', prompt,
  ];
  console.log(args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' | '));

  console.log('\n=== 执行 ===');
  const t0 = Date.now();
  const { code, out, err } = await run(args, 780_000);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n耗时 ${elapsed}s   exit=${code}`);
  console.log('\n--- stdout ---');
  console.log(out.trim() || '(空)');
  if (err.trim()) {
    console.log('\n--- stderr(尾部) ---');
    console.log(err.trim().slice(-1200));
  }

  // ---- 判定 ----
  const combined = out + '\n' + err;
  const toolHit = ['douyin_watch', 'douyin_observe', 'douyin_open', 'hermes-douyin-pet']
    .filter((m) => combined.includes(m));

  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const chatter = lines.length ? lines[lines.length - 1] : '';

  console.log('\n' + '='.repeat(68));
  console.log('判定:');
  console.log(`  插件工具出现: ${toolHit.length ? toolHit.join(', ') : '❌ 没有 —— Hermes 没调插件'}`);
  console.log(`  最终输出    : ${JSON.stringify(chatter.slice(0, 160))}`);
  console.log(`  输出长度    : ${chatter.length} 字符(桌宠气泡够不够)`);
  console.log(`  耗时        : ${elapsed}s`);

  const ok = toolHit.length > 0 && chatter.length > 0 && !/rate-limited|not processed/i.test(out);
  console.log('\n结果:', ok ? '✅ 桌宠 → Hermes → 插件 链路通' : '❌ 链路没通');
  console.log('='.repeat(68));
  process.exit(ok ? 0 : 1);
}

main();
