import { SystemIdleProbe } from '../electron/system-idle';

const probe = new SystemIdleProbe(0); // 不缓存,测真实值

console.log('=== 系统空闲时间探测 ===');
const t0 = Date.now();
const a = await probe.get();
console.log(`  第1次: idleMs=${a.idleMs} (${(a.idleMs / 1000).toFixed(1)}s) reliable=${a.reliable} 耗时=${Date.now() - t0}ms`);

const t1 = Date.now();
const b = await probe.get();
console.log(`  第2次: idleMs=${b.idleMs} (${(b.idleMs / 1000).toFixed(1)}s) reliable=${b.reliable} 耗时=${Date.now() - t1}ms`);

const ok =
  a.reliable &&
  a.idleMs >= 0 &&
  // 上限放宽到 24 小时:探测本身只要求"返回一个合理的毫秒数"。
  // 实测值会随"用户最后一次真实输入"变化 —— 在终端里敲命令时它是几秒,
  // 放着不动时它是几十分钟,两者都是正确的。
  a.idleMs < 24 * 60 * 60 * 1000 &&
  // 两次探测应当接近(间隔几百毫秒,值不应该跳变)
  Math.abs(a.idleMs - b.idleMs) < 60_000;
console.log('');
console.log(ok ? '  ✓ 系统空闲探测可用' : '  ✗ 系统空闲探测异常');
process.exit(ok ? 0 : 1);
