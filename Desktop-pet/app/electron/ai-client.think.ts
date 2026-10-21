/**
 * <think> 思考块的流式拆分 —— 纯函数模块(无 Electron / 无 DOM 依赖)。
 *
 * 单独抽出来是为了能直接跑单测:ai-client.ts 依赖 electron 的 net,
 * 直接 import 它跑测试会炸。
 *
 * 背景:不同推理模型把思考过程放在不同位置 ——
 *   - DeepSeek / kimi-k3 走 `delta.reasoning_content` 字段;
 *   - **MiniMax-M3 直接写在 `delta.content` 里**,形如
 *     `<think>我在思考…</think>真正答案`。
 * 不拆的话,思考过程会原样显示在桌宠的气泡里
 * (实测:77 字回复里 52 字是思考)。
 *
 * 流式安全:标签可能被拆在两个 chunk 之间(chunk1 结尾 "<thi",chunk2 开头 "nk>"),
 * 所以用 pending 缓冲 + 「尾部是否可能是标签前缀」判断。
 */

export const THINK_OPEN = '<think>';
export const THINK_CLOSE = '</think>';

/** <think> 块的流式拆分状态 */
export interface ThinkState {
  /** 当前是否在 <think> 块内 */
  inThink: boolean;
  /** 可能是标签前缀的尾部缓冲(等下一个 chunk 拼上) */
  pending: string;
}

export function newThinkState(): ThinkState {
  return { inThink: false, pending: '' };
}

/** buf 的尾部有多长是 tag 的真前缀(0 = 不是前缀,不需要缓冲) */
function pendingTagLen(buf: string, tag: string): number {
  const max = Math.min(tag.length - 1, buf.length);
  for (let k = max; k > 0; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/**
 * 把 content 增量里的 <think> 块拆成「答案」和「思考」两部分。
 * 返回的 answer 可直接推给渲染端显示;thinking 用于「思考中」状态。
 */
export function splitThinkTags(
  delta: string,
  st: ThinkState,
): { answer: string; thinking: string } {
  let answer = '';
  let thinking = '';
  let buf = st.pending + delta;
  st.pending = '';

  for (;;) {
    if (st.inThink) {
      const idx = buf.indexOf(THINK_CLOSE);
      if (idx >= 0) {
        thinking += buf.slice(0, idx);
        buf = buf.slice(idx + THINK_CLOSE.length);
        st.inThink = false;
        continue;
      }
      const keep = pendingTagLen(buf, THINK_CLOSE);
      const safe = buf.slice(0, buf.length - keep);
      thinking += safe;
      st.pending = buf.slice(buf.length - keep);
      break;
    }
    const idx = buf.indexOf(THINK_OPEN);
    if (idx >= 0) {
      answer += buf.slice(0, idx);
      buf = buf.slice(idx + THINK_OPEN.length);
      st.inThink = true;
      continue;
    }
    const keep = pendingTagLen(buf, THINK_OPEN);
    const safe = buf.slice(0, buf.length - keep);
    answer += safe;
    st.pending = buf.slice(buf.length - keep);
    break;
  }

  return { answer, thinking };
}
