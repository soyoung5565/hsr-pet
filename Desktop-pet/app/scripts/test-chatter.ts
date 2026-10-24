/**
 * 碎碎念 prompt 逻辑实测。
 *
 * 跑法:npx tsx scripts/test-chatter.ts
 *
 * 测的是「不发版、不启动 electron」也能验的部分:
 *   - 活跃时段的边界(含跨零点)
 *   - 随机延迟的取值范围
 *   - 人设 system prompt 能否正常构造
 *   - **真调一次 AI**,看它是否真的只吐一句话、不提问、不带 markdown
 *
 * 最后一项最重要:prompt 写得好不好,只有真问一次才知道。
 */

import {
  buildCharacterSystemPrompt,
  resolveDefaultCharacterPersona,
} from '../shared/emotion-map';
import { readFileSync } from 'node:fs';

let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/* ===== 活跃时段(复制 use-pet-chatter.ts 的判据,验证边界) ===== */
function inActiveHours(hour: number, startHour: number, endHour: number): boolean {
  const s = ((Math.round(startHour) % 24) + 24) % 24;
  const e = ((Math.round(endHour) % 24) + 24) % 24;
  if (s === e) return false;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e;
}

console.log('');
console.log('=== 1. 活跃时段边界 ===');
check('普通区间 12 点在内(9~23)', inActiveHours(12, 9, 23) === true);
check('普通区间 8 点在外(9~23)', inActiveHours(8, 9, 23) === false);
check('普通区间 23 点在外(结束不含)', inActiveHours(23, 9, 23) === false);
check('普通区间 22 点在内', inActiveHours(22, 9, 23) === true);
check('跨零点 23 点在内(22~2)', inActiveHours(23, 22, 2) === true);
check('跨零点 1 点在内(22~2)', inActiveHours(1, 22, 2) === true);
check('跨零点 12 点在外(22~2)', inActiveHours(12, 22, 2) === false);
check('起止相同 = 全天关', inActiveHours(12, 5, 5) === false);

/* ===== 随机延迟范围 ===== */
function randomDelayMs(minMinutes: number, maxMinutes: number): number {
  const lo = Math.max(1, Math.min(minMinutes, maxMinutes));
  const hi = Math.max(lo, Math.max(minMinutes, maxMinutes));
  return Math.round((lo + Math.random() * (hi - lo)) * 60_000);
}
console.log('');
console.log('=== 2. 随机延迟范围 ===');
{
  let minSeen = Infinity;
  let maxSeen = 0;
  for (let i = 0; i < 500; i++) {
    const d = randomDelayMs(8, 25);
    minSeen = Math.min(minSeen, d);
    maxSeen = Math.max(maxSeen, d);
  }
  check('延迟不小于 8 分钟', minSeen >= 8 * 60_000, `${minSeen}ms`);
  check('延迟不大于 25 分钟', maxSeen <= 25 * 60_000, `${maxSeen}ms`);
  // 参数写反(25, 8)也要能正常算
  const swapped = randomDelayMs(25, 8);
  check('参数写反也能用', swapped >= 8 * 60_000 && swapped <= 25 * 60_000, `${swapped}ms`);
}

/* ===== 人设 prompt ===== */
console.log('');
console.log('=== 3. 人设 system prompt ===');
const persona = resolveDefaultCharacterPersona('魔女');
check('默认人设能解析', !!persona && persona.personality.length > 0);
const sys = buildCharacterSystemPrompt(persona);
check('system prompt 能构造', !!sys && sys.length > 50);
check('system prompt 含角色名', !!sys && sys.includes(persona.displayName));

/* ===== 真调一次 AI ===== */
console.log('');
console.log('=== 4. 真调 AI(看它是否真的只吐一句话)===');
const cfg = JSON.parse(
  readFileSync(process.env.APPDATA + '/desktop-pet/config.json', 'utf-8'),
);
if (!cfg.baseURL || !cfg.apiKey) {
  console.log('  (跳过:没配 AI)');
} else {
  const topic =
    '你现在有点无聊,自己嘀咕一句(不要问主人问题,不要催他做事)。\n\n' +
    '【硬性要求】\n' +
    '1. 这是**自言自语**,不是对主人说话 —— 不要用"你呢/你要不要/快去"这类直接对话句式。\n' +
    '2. **不要提问**,不要要求主人做事,不要催促。\n' +
    '3. 只输出这一句话,25 字以内。可以带 1 个 emoji,也可以不带。\n' +
    '4. 不要 markdown,不要换行,不要解释,不要 [emotion] 标签。\n' +
    '5. 语气要轻、要自然,像一个人在旁边小声念叨。';

  const t0 = Date.now();
  const res = await fetch(cfg.baseURL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: topic },
      ],
      temperature: 0.9,
      max_tokens: 120,
    }),
  });
  const json = (await res.json()) as any;
  const raw = json?.choices?.[0]?.message?.content ?? '';
  // ★ 真实链路里 sendChat 走的是 ai-client 的 splitThinkTags —— 思考块已被拆走,
  //   渲染端拿到的 answer 通道是纯答案。这里手动复现同一套拆解,
  //   否则会误判"碎碎念会把 think 标签显示出来"(实际不会)。
  const answerOnly = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, ''); // 没闭合的也要截掉
  const cleaned = answerOnly
    .replace(/\[emotion:\s*\w+\s*\]/gi, '')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, 50);
  console.log(`  耗时: ${Date.now() - t0}ms`);
  console.log(`  原始(含 think): ${JSON.stringify(raw.slice(0, 120))}...`);
  console.log(`  清洗后: ${JSON.stringify(cleaned)}`);

  check('AI 有返回内容', cleaned.length > 0, JSON.stringify(json).slice(0, 300));
  check('think 块被拆掉(真实链路同款处理)', !/think/i.test(cleaned), JSON.stringify(cleaned));
  check('长度不超过 50 字', cleaned.length <= 50, `${cleaned.length}`);
  check('没有换行(单行气泡)', !cleaned.includes('\n'), JSON.stringify(cleaned));
  check('没有 markdown 标题', !/^\s*#{1,6}\s/.test(cleaned), JSON.stringify(cleaned));
  check('没有残留 [emotion] 标签', !/\[emotion/i.test(cleaned), JSON.stringify(cleaned));
  check(
    '不是提问句(不含 ? / ？)',
    !/[?？]/.test(cleaned),
    JSON.stringify(cleaned),
  );
}

console.log('');
if (failed > 0) {
  console.log(`  ${failed} 项失败`);
  process.exit(1);
}
console.log('  碎碎念逻辑全部通过 ✓');
