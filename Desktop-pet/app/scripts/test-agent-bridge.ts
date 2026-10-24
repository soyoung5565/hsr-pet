/**
 * agent-bridge 端到端实测。
 *
 * 跑法:npx tsx scripts/test-agent-bridge.ts
 *
 * 为什么必须真跑:
 *   probe 只做静态检查(命令能不能解析),它说"可用"不代表真能跑。
 *   agent-bridge.ts 不依赖 electron(纯 node 模块),所以可以在这里直接调 runAgent,
 *   拿到真实输出 —— 而不是"看起来接好了"。
 */

import {
  probeBackends,
  runAgent,
  cleanAgentOutput,
  detectUnavailableReason,
  recordRuntimeVerdict,
  _resetRuntimeVerdicts,
} from '../electron/agent-bridge';

let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

console.log('');
console.log('=== 1. 探测后端 ===');
const infos = probeBackends();
for (const i of infos) {
  console.log(
    `  ${i.available ? '✓' : '✗'} ${i.id.padEnd(13)} ${i.label.padEnd(18)} ${i.reason}`,
  );
}
check('探测返回了至少一个后端', infos.length > 0);
check(
  'hermes 被识别为可用(本机唯一实测能跑的后端)',
  infos.find((i) => i.id === 'hermes')?.available === true,
  infos.find((i) => i.id === 'hermes')?.reason ?? 'missing',
);
check(
  'codex 被识别为不可用(装了但没登录)',
  infos.find((i) => i.id === 'codex')?.available === false,
  infos.find((i) => i.id === 'codex')?.reason ?? 'missing',
);

console.log('');
console.log('=== 2. 输出清洗 ===');
check(
  'ANSI 控制符被去掉',
  cleanAgentOutput('\x1b[31m红色\x1b[0m') === '红色',
  JSON.stringify(cleanAgentOutput('\x1b[31m红色\x1b[0m')),
);
check(
  '连续空行被压掉',
  !/\n{3,}/.test(cleanAgentOutput('a\n\n\n\n\nb')),
  JSON.stringify(cleanAgentOutput('a\n\n\n\n\nb')),
);

console.log('');
console.log('=== 3. 真跑一次 hermes(端到端)===');
const t0 = Date.now();
const lines: string[] = [];
const res = await runAgent({
  prompt: '只输出三个字:收到了',
  timeoutSec: 120,
  onLine: (l) => lines.push(l),
});
const dt = Date.now() - t0;
console.log(`  后端: ${res.backend || '(无)'}`);
console.log(`  成功: ${res.ok}`);
console.log(`  耗时: ${dt}ms`);
console.log(`  错误: ${res.error ?? '(无)'}`);
console.log(`  输出: ${res.output.slice(0, 300)}`);
console.log(`  流式行数: ${lines.length}`);

check('runAgent 返回了 ok=true', res.ok === true, res.error ?? '');
check('实际用的是 hermes 后端', res.backend === 'hermes', res.backend);
check('输出里有内容', res.output.trim().length > 0);
check('输出包含预期内容「收到了」', res.output.includes('收到了'), res.output.slice(0, 120));
check('流式回调被触发过', lines.length > 0, `lines=${lines.length}`);
check('耗时在合理范围(<90s)', dt < 90_000, `${dt}ms`);

console.log('');
console.log('=== 4. 失败路径:指定一个不可用的后端 ===');
const bad = await runAgent({
  prompt: '随便',
  preferId: 'codex', // 没登录 → 应该失败并给诚实原因
  timeoutSec: 60,
});
console.log(`  ok=${bad.ok} backend=${bad.backend} error=${bad.error ?? '(无)'}`);
// 注意:pickAvailableBackend 在指定后端不可用时会**回退**到下一个可用的,
// 所以这里期望的是"要么回退成功,要么诚实报错" —— 不能是静默失败。
check(
  '不可用后端不会静默吞掉',
  bad.ok === true || (bad.ok === false && !!bad.error),
  JSON.stringify(bad),
);

console.log('');
console.log('=== 5. 空 prompt 必须被拒 ===');
const empty = await runAgent({ prompt: '   ' });
check('空 prompt 被拒绝', empty.ok === false && !!empty.error, JSON.stringify(empty));

console.log('');
console.log('=== 6. ★ 探针不撒谎:额度耗尽的后端不能报"已就绪" ===');
// 实测踩坑:command-code 装了 + 登录了,但额度耗尽(退出码 10,stderr 报
// "Insufficient credits")。静态探针只查文件在不在 → 报"已就绪" → 用户
// 点下去才炸。这里验证"运行判定能覆盖静态结论"。
check(
  '能认出"额度不足"',
  detectUnavailableReason('Error: Insufficient credits for Command Code.') !== null,
);
check(
  '能认出"未登录"',
  detectUnavailableReason('You are not logged in') !== null,
);
check(
  '能认出"需要 TTY"',
  detectUnavailableReason('Interactive mode requires a TTY terminal.') !== null,
);
check(
  '正常输出不会被误判',
  detectUnavailableReason('任务已完成,共修改 3 个文件') === null,
);

_resetRuntimeVerdicts();
recordRuntimeVerdict('command-code', false, '账号额度不足(insufficient credits)。充值后才能用。');
const afterVerdict = probeBackends();
const ccInfo = afterVerdict.find((i) => i.id === 'command-code');
console.log(`  command-code 判定后: available=${ccInfo?.available} reason=${ccInfo?.reason}`);
check(
  '运行判定把 command-code 标为不可用',
  ccInfo?.available === false,
  ccInfo?.reason ?? 'missing',
);
check(
  '不可用原因带上了额度信息',
  (ccInfo?.reason ?? '').includes('额度'),
  ccInfo?.reason ?? '',
);
_resetRuntimeVerdicts();

console.log('');
if (failed > 0) {
  console.log(`  ${failed} 项失败`);
  process.exit(1);
}
console.log('  agent-bridge 端到端全部通过 ✓');
