import { runAgent } from '../electron/agent-bridge';

const t0 = Date.now();
const lines: string[] = [];
console.log('开始跑 hermes...');
const res = await runAgent({
  prompt: '只输出三个字:收到了',
  timeoutSec: 90,
  onLine: (l) => {
    lines.push(l);
    console.log('  [行]', l.slice(0, 120));
  },
});
console.log('');
console.log('backend =', res.backend);
console.log('ok      =', res.ok);
console.log('error   =', res.error ?? '(无)');
console.log('output  =', JSON.stringify(res.output.slice(0, 400)));
console.log('elapsed =', Date.now() - t0, 'ms');
console.log('lines   =', lines.length);
process.exit(res.ok ? 0 : 1);
