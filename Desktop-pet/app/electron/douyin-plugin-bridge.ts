/**
 * 桌宠 → Hermes 插件的调用桥。
 *
 * ★ 架构(参考原项目 dsh-douyin-agent 的实现方式):
 *   原项目:DSH 插件(浏览器控制) ← 上层调度在 DSH 里
 *   这里  :Hermes 插件 hermes-douyin-pet(浏览器控制) ← 桌宠通过 Hermes CLI 调它
 *
 * 为什么走 Hermes 而不是桌宠自己驱动浏览器:
 *   1. 浏览器控制、抽帧、模型判断都已经在 Hermes 插件里(已实测跑通)
 *   2. 模型用宿主当前模型 —— 桌宠和 Hermes 看到的是同一个「大脑」
 *   3. 桌宠保持薄:只管渲染 + 交互,符合「底座不换栈」的原则
 *
 * 调用方式:hermes chat -q "<prompt>" —— 非交互一次性执行,
 * agent 会自己选到 douyin_watch 工具。输出是桌宠能直接念出来的感想。
 */

/** 插件工具的调用提示词 —— 说清要干什么,让 agent 选对工具。 */
export interface DouyinWatchRequest {
  /** 看几条视频 */
  maxVideos?: number;
  /** 每条看几秒 */
  secondsPerVideo?: number;
  /** 附加指令(桌宠人设 / 主人偏好) */
  extra?: string;
}

/** 插件调用的结果。 */
export interface DouyinPluginResult {
  ok: boolean;
  /** 桌宠可以直接念出来的感想 */
  output: string;
  /** 实际用的后端(应该是 hermes) */
  backend?: string;
  error?: string;
  elapsedMs: number;
}

/**
 * 构造给 Hermes 的提示词。
 *
 * ★ 为什么要显式点名工具:
 *   agent 有几十个工具可选,光说「刷抖音」它可能去搜网页而不是调插件。
 *   点名 douyin_watch 并描述参数,命中率稳定得多。
 */
export function buildWatchPrompt(req: DouyinWatchRequest): string {
  const maxVideos = Math.max(1, Math.min(20, Math.round(req.maxVideos ?? 3)));
  const seconds = Math.max(2, Math.min(30, Math.round(req.secondsPerVideo ?? 6)));
  const parts = [
    '请调用 hermes-douyin-pet 插件的 douyin_watch 工具,让桌宠自己刷抖音。',
    `参数:max_videos=${maxVideos}, seconds_per_video=${seconds}。`,
    '调用成功后,用一句口语化的话(40 字以内,像在跟主人聊天)总结刚才看到的内容并作为输出。',
    '不要解释你做了什么,不要用列表,只说那一句感想。',
  ];
  if (req.extra) parts.push(req.extra);
  return parts.join('\n');
}

/** 从 agent 输出里提取最终那段感想(去掉可能的 markdown 装饰)。 */
export function extractChatter(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  // 去掉 markdown 标题/引用/粗体标记
  const cleaned = text
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/^>\s*/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line.length > 0);
  // 取最后一段(通常是最终结论)
  const last = cleaned.length ? cleaned[cleaned.length - 1] : '';
  return last.slice(0, 300);
}
