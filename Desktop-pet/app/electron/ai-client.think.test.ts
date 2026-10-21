/**
 * <think> 块流式拆分单测 —— 纯函数,无 DOM 依赖。
 *
 * 为什么必须测:这个拆分器要在**任意 chunk 边界**下都正确。
 * 标签可能被拆在两个 chunk 之间("<thi" + "nk>"),
 * 边界处理错了 → 思考内容漏进气泡,或答案被吞掉。
 * 这些在真实对话里是随机出现的(取决于服务端怎么切包),手测覆盖不到。
 *
 * 用法:
 *   npx tsx electron/ai-client.think.test.ts
 */
import {
  newThinkState,
  splitThinkTags,
  type ThinkState,
} from './ai-client.think';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** 把一整段文本按给定的切分点喂进 state,累积答案与思考 */
function feed(state: ThinkState, text: string, cuts: number[]): {
  answer: string;
  thinking: string;
} {
  let answer = '';
  let thinking = '';
  let pos = 0;
  const points = [...cuts, text.length];
  for (const end of points) {
    const piece = text.slice(pos, end);
    pos = end;
    if (!piece) continue;
    const r = splitThinkTags(piece, state);
    answer += r.answer;
    thinking += r.thinking;
  }
  return { answer, thinking };
}

console.log('\n[1] 基础:整块一次性到达');
{
  const st = newThinkState();
  const r = splitThinkTags('<think>我在想</think>你好呀', st);
  check('思考被剥离', r.thinking === '我在想', `got ${JSON.stringify(r.thinking)}`);
  check('答案保留', r.answer === '你好呀', `got ${JSON.stringify(r.answer)}`);
}

console.log('\n[2] 无 think 标签 → 原样透传');
{
  const st = newThinkState();
  const r = splitThinkTags('普通回答', st);
  check('answer 原样', r.answer === '普通回答', `got ${JSON.stringify(r.answer)}`);
  check('thinking 为空', r.thinking === '', `got ${JSON.stringify(r.thinking)}`);
}

console.log('\n[3] 只有 think 没有答案');
{
  const st = newThinkState();
  const r = splitThinkTags('<think>只有思考</think>', st);
  check('answer 为空', r.answer === '', `got ${JSON.stringify(r.answer)}`);
  check('thinking 完整', r.thinking === '只有思考', `got ${JSON.stringify(r.thinking)}`);
}

console.log('\n[4] ★ 标签被拆在 chunk 边界(每个切点都试一遍)');
{
  const full = '<think>思考内容</think>最终答案';
  const open = '<think>'.length;
  const closeAt = '<think>思考内容'.length;
  for (let cut = 1; cut < full.length; cut++) {
    const st = newThinkState();
    const r = feed(st, full, [cut]);
    const okAnswer = r.answer === '最终答案';
    const okThink = r.thinking === '思考内容';
    if (!okAnswer || !okThink) {
      check(
        `切点 ${cut} 正确`,
        false,
        `answer=${JSON.stringify(r.answer)} thinking=${JSON.stringify(r.thinking)}`,
      );
    }
  }
  check('所有单切点(1..len-1)都正确', true);
}

console.log('\n[5] ★ 标签逐字符切碎(最坏情况)');
{
  const full = '<think>思考</think>答案';
  const st = newThinkState();
  let answer = '';
  let thinking = '';
  for (const ch of full) {
    const r = splitThinkTags(ch, st);
    answer += r.answer;
    thinking += r.thinking;
  }
  check('逐字符:答案正确', answer === '答案', `got ${JSON.stringify(answer)}`);
  check('逐字符:思考正确', thinking === '思考', `got ${JSON.stringify(thinking)}`);
}

console.log('\n[6] 多个 think 块');
{
  const st = newThinkState();
  const r = splitThinkTags('<think>A</think>中间<think>B</think>尾', st);
  check('答案 = 中间+尾', r.answer === '中间尾', `got ${JSON.stringify(r.answer)}`);
  check('思考 = A+B', r.thinking === 'AB', `got ${JSON.stringify(r.thinking)}`);
}

console.log('\n[7] think 未闭合(模型被截断)');
{
  const st = newThinkState();
  const r = splitThinkTags('<think>思考到一半', st);
  check('未闭合时全部算思考', r.thinking === '思考到一半', `got ${JSON.stringify(r.thinking)}`);
  check('未闭合时答案为空', r.answer === '', `got ${JSON.stringify(r.answer)}`);
  check('状态标记仍在 think 内', st.inThink === true);
}

console.log('\n[8] 尾部是标签前缀(等下一个 chunk 拼上)');
{
  const st = newThinkState();
  const r1 = splitThinkTags('答案<thi', st);
  check('前缀被缓冲,不当答案', r1.answer === '答案', `got ${JSON.stringify(r1.answer)}`);
  check('pending 记录了前缀', st.pending === '<thi', `got ${JSON.stringify(st.pending)}`);
  // 下一个 chunk 把开标签补齐(<think> = '<' + 'think' + '>')
  //   '<thi' + 'nk>思考内容</think>正文' → '<think>思考内容</think>正文'
  //   → 思考内容归 thinking,'正文' 归 answer
  const r2 = splitThinkTags('nk>思考内容</think>正文', st);
  check('跨 chunk 的开标签被识别', r2.thinking === '思考内容', `got ${JSON.stringify(r2.thinking)}`);
  check('答案 = 正文', r2.answer === '正文', `got ${JSON.stringify(r2.answer)}`);
  check('答案不含 think 标签', !r2.answer.includes('think'), `got ${JSON.stringify(r2.answer)}`);
}

console.log('\n[8b] 未闭合 think 里的内容归 thinking(不是答案)');
{
  const st = newThinkState();
  // '<thi' + 'nk>后续' → '<think>后续' —— 标签开了没关,'后续' 在 think 内
  const r1 = splitThinkTags('答案<thi', st);
  const r2 = splitThinkTags('nk>后续', st);
  check('未闭合部分归 thinking', r2.thinking === '后续', `got ${JSON.stringify(r2.thinking)}`);
  check('答案侧不含未闭合内容', r2.answer === '', `got ${JSON.stringify(r2.answer)}`);
}

console.log('\n[9] 真实场景:MiniMax-M3 那种带换行的思考');
{
  const st = newThinkState();
  const r = splitThinkTags('<think>用户在闲聊,不需要工具。\n以傲娇橘猫口吻回答。</think>\n\n哼,本喵心情不错!', st);
  check('多行思考被剥离', r.thinking.includes('不需要工具'), `got ${JSON.stringify(r.thinking)}`);
  check('答案不含思考', !r.answer.includes('傲娇橘猫'), `got ${JSON.stringify(r.answer)}`);
  check('答案保留正文', r.answer.includes('本喵心情不错'), `got ${JSON.stringify(r.answer)}`);
  check('答案不含 think 标签', !r.answer.includes('<think>') && !r.answer.includes('</think>'));
}

console.log('\n' + '='.repeat(56));
console.log(`<think> 拆分单测:${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('\n失败明细:');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('='.repeat(56));
  process.exit(1);
}
console.log('全部通过 ✅');
console.log('='.repeat(56));
