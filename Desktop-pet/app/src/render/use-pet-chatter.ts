import { useEffect, useRef } from 'react';
import {
  type CharacterPersona,
  buildCharacterSystemPrompt,
  resolveDefaultCharacterPersona,
} from '../../shared/emotion-map';

/**
 * 碎碎念(自言自语)—— 桌宠在没人理它的时候自己嘀咕。
 *
 * 与「主动搭话」的区别(两套东西不要混):
 *   - 主动搭话(use-proactive-greetings):**有事由**才说话(时段/整点/节日/切应用/长停留),
 *     每件事每天/每应用只触发一次,是"对用户说的"。
 *   - 碎碎念(本文件):**没事由**,纯粹因为闲。间隔随机,不说教、不提问、不催,
 *     更像"自己嘀咕",用户听到了也可以不理。语气要轻,不能像催命。
 *
 * 为什么不复用 use-proactive-greetings 的 speak():
 *   那边的 speak 是为「一句话对用户说」设计的(30 字内、带 emoji、面向用户);
 *   碎碎念需要不同的 prompt 约束(不许提问、不许催、允许抱怨自己无聊),
 *   而且要独立的时间调度与冷却,混在一起会让两边判据互相污染。
 */

interface Args {
  characterId: string;
  characterName: string;
  /** 在桌宠头顶气泡显示一段文字,duration 毫秒后自动消失。 */
  showHint: (msg: string, duration: number) => void;
  /**
   * 取「用户空闲了多久」(ms)。
   *
   * ⚠ 必须来自**系统级**探测(GetLastInputInfo),不能用渲染端的 mousemove/keydown:
   *   桌宠窗口是 click-through 的置顶窗,用户在下面操作别的应用时,
   *   本窗口一个事件都收不到 → 永远判定"用户一直很闲" → 打字时也碎碎念。
   *   主进程已把探测结果通过 petAPI.systemIdle() 暴露出来。
   */
  getIdleMs: () => Promise<number>;
}

/** 一次碎碎念显示多久。比主动搭话长一点 —— 用户没在等,慢点读没关系。 */
const BUBBLE_MS = 7000;

/** 解析当前角色的 active persona(与 use-proactive-greetings 同源逻辑)。 */
async function resolvePersona(name: string): Promise<CharacterPersona | null> {
  if (!name) return null;
  try {
    const cfg = await window.petAPI?.getConfig?.();
    const slot = cfg?.characterPersonas?.[name];
    const list = Array.isArray(slot?.personas) ? slot.personas : [];
    if (list.length > 0) {
      const cur = list.find((p) => p.id === slot!.activeId) ?? list[0];
      if ((cur.personality ?? '').trim().length > 0) {
        return {
          displayName: cur.displayName,
          personality: cur.personality,
          speakingStyle: cur.speakingStyle,
        };
      }
      const def = resolveDefaultCharacterPersona(name);
      return {
        displayName: cur.displayName?.trim() || def.displayName,
        personality: def.personality,
        speakingStyle: def.speakingStyle,
      };
    }
  } catch {
    // ignore
  }
  return resolveDefaultCharacterPersona(name);
}

/**
 * 去掉模型可能吐出来的 <think> 思考块。
 *
 * 正常情况下 sendChat 走 ai-client 的 splitThinkTags,思考块已经被拆到
 * thinking 通道,answer 通道是干净的。但碎碎念要求"只输出一句话"很严,
 * 宁可多一道兜底 —— 实测 MiniMax-M3 的 content 里确实会带 <think>。
 * (没闭合的也要截掉:模型被截断时可能只吐了开标签)
 */
function stripThinkBlocks(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '');
}

/** 调 AI 拿一句话。失败/空 → null,由调用方决定静默。 */
function askOnce(opts: {
  systemPrompt: string;
  userPrompt: string;
  maxChars: number;
  signal: { disposed: boolean };
}): Promise<string | null> {
  const { systemPrompt, userPrompt, maxChars, signal } = opts;
  if (!window.petAPI?.sendChat) return Promise.resolve(null);
  return new Promise((resolve) => {
    let acc = '';
    try {
      window.petAPI.sendChat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        (delta, kind) => {
          if (kind === 'answer') acc += delta;
        },
        () => {
          if (signal.disposed) return resolve(null);
          const cleaned = stripThinkBlocks(acc)
            .replace(/\[emotion:\s*\w+\s*\]/gi, '')
            .replace(/^\s+|\s+$/g, '')
            // 气泡是单行的 —— 换行会让排版炸开
            .replace(/\s*\n+\s*/g, ' ')
            .slice(0, maxChars);
          resolve(cleaned.length > 0 ? cleaned : null);
        },
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** 在 [min,max] 分钟内随机一个下次触发延迟(ms) */
function randomDelayMs(minMinutes: number, maxMinutes: number): number {
  const lo = Math.max(1, Math.min(minMinutes, maxMinutes));
  const hi = Math.max(lo, Math.max(minMinutes, maxMinutes));
  const minutes = lo + Math.random() * (hi - lo);
  return Math.round(minutes * 60_000);
}

/** 当前小时是否在碎碎念活跃时段内。支持跨零点(如 22 → 2)。 */
function inActiveHours(hour: number, startHour: number, endHour: number): boolean {
  const s = ((Math.round(startHour) % 24) + 24) % 24;
  const e = ((Math.round(endHour) % 24) + 24) % 24;
  if (s === e) return false; // 起止相同 = 空区间(明确关掉)
  if (s < e) return hour >= s && hour < e;
  // 跨零点:22:00~02:00
  return hour >= s || hour < e;
}

/**
 * 碎碎念的触发理由池。
 *
 * 为什么准备多个理由而不是每次同一句 prompt:
 *   同一个 prompt 反复问,模型会逐渐收敛到同一句话(尤其 temperature 低时),
 *   用户会听到复读。随机换角度能明显拉开内容差异。
 */
function buildTopic(now: Date, minutesSinceActivity: number): string {
  const h = now.getHours();
  const topics: string[] = [
    '你现在有点无聊,自己嘀咕一句(不要问主人问题,不要催他做事)。',
    '你看看窗外/屏幕边角,随口说一句此刻的感受(纯自言自语,不需要回应)。',
    '你想起一件很小很小的事(比如昨天的一只虫子、一片叶子、某个声音),随口说说。',
    '你伸展一下身体,顺便抱怨一句(比如腰酸、天气、屏幕太亮),语气要轻。',
    '你偷偷观察主人一会儿,说一句心里的想法(不要直接对主人喊话,像在旁边小声嘀咕)。',
  ];
  if (h >= 22 || h < 5) {
    topics.push('夜里有困意了,你小声打个哈欠说一句(不要催主人睡,只说自己的感受)。');
  }
  if (h >= 11 && h < 14) {
    topics.push('到饭点了,你自己念叨一句吃的(不要要求主人给你买,只是想吃)。');
  }
  if (minutesSinceActivity >= 60) {
    topics.push(
      `主人已经 ${Math.floor(minutesSinceActivity / 60)} 小时没动了,你自己嘀咕一句(不要喊他,像自言自语)。`,
    );
  }
  return topics[Math.floor(Math.random() * topics.length)];
}

export function usePetChatter(args: Args): void {
  const { characterId, characterName, showHint, getIdleMs } = args;

  const showHintRef = useRef(showHint);
  useEffect(() => {
    showHintRef.current = showHint;
  });
  const getIdleMsRef = useRef(getIdleMs);
  useEffect(() => {
    getIdleMsRef.current = getIdleMs;
  });

  useEffect(() => {
    const signal = { disposed: false };
    /** 下一次允许说话的时间戳。用时间戳而不是 setTimeout:
     *  配置变更/系统休眠会打乱 setTimeout,而时间戳判定自带"错过就补一次"的语义。 */
    let nextAt = Number.POSITIVE_INFINITY;
    /** 上一次说话的时间,用于避免"改配置后立刻连说" */
    let lastSpokeAt = 0;
    /** 当前配置快照(定时器每秒读一次最新值) */
    let cfg = {
      enabled: false,
      minMinutes: 8,
      maxMinutes: 25,
      startHour: 9,
      endHour: 23,
      onlyWhenIdle: true,
    };

    const refresh = async () => {
      try {
        const c = await window.petAPI?.getConfig?.();
        const pro = c?.proactive;
        cfg = {
          // 碎碎念必须显式打开才生效(默认 false)
          enabled: pro?.chatterEnabled === true,
          minMinutes: Number(pro?.chatterMinMinutes) || 8,
          maxMinutes: Number(pro?.chatterMaxMinutes) || 25,
          startHour: Number.isFinite(pro?.chatterStartHour) ? pro!.chatterStartHour! : 9,
          endHour: Number.isFinite(pro?.chatterEndHour) ? pro!.chatterEndHour! : 23,
          onlyWhenIdle: pro?.chatterOnlyWhenIdle !== false,
        };
        if (!cfg.enabled) {
          nextAt = Number.POSITIVE_INFINITY;
        } else if (!Number.isFinite(nextAt)) {
          // 刚开启 → 排第一次(给用户一点静默缓冲,不要一开就立刻说话)
          nextAt = Date.now() + randomDelayMs(cfg.minMinutes, cfg.maxMinutes);
        }
      } catch {
        cfg.enabled = false;
        nextAt = Number.POSITIVE_INFINITY;
      }
    };
    void refresh();
    window.addEventListener('petAI:configChanged', refresh);

    /** 说一次。成功 → 排下一次;失败 → 也排下一次(别卡死在原地) */
    const speak = async () => {
      if (signal.disposed) return;
      if (document.hidden) return;

      // 模型隐藏时不说话(用户把宠物藏了,还冒气泡就是骚扰)
      const root = document.querySelector('.app-root');
      if (root?.classList.contains('app--model-hidden')) return;

      const now = new Date();
      if (!inActiveHours(now.getHours(), cfg.startHour, cfg.endHour)) return;

      // 只在主人安静时碎碎念(有操作时闭嘴,避免打断)
      // ⚠ idleMs = -1 表示"探测不可靠"(非 Windows / PS 起不来)。
      //   这时**不能**当成"用户刚动过"(-1 < 3分钟 → 永远不碎碎念,功能等于废掉),
      //   应当放行 —— 宁可多嘴一句,也不能让功能静默失效。
      const idleMs = await getIdleMsRef.current();
      const idleReliable = idleMs >= 0;
      if (cfg.onlyWhenIdle && idleReliable && idleMs < 3 * 60_000) return;

      const persona = await resolvePersona(characterName);
      const sys = buildCharacterSystemPrompt(persona);
      if (!sys) return;

      const minutes = idleReliable ? Math.floor(idleMs / 60_000) : 0;
      const topic = buildTopic(now, minutes);
      const userPrompt =
        `${topic}\n\n` +
        '【硬性要求】\n' +
        '1. 这是**自言自语**,不是对主人说话 —— 不要用"你呢/你要不要/快去"这类直接对话句式。\n' +
        '2. **不要提问**,不要要求主人做事,不要催促。\n' +
        '3. 只输出这一句话,25 字以内。可以带 1 个 emoji,也可以不带。\n' +
        '4. 不要 markdown,不要换行,不要解释,不要 [emotion] 标签。\n' +
        '5. 语气要轻、要自然,像一个人在旁边小声念叨。';

      const line = await askOnce({ systemPrompt: sys, userPrompt, maxChars: 50, signal });
      if (signal.disposed) return;
      lastSpokeAt = Date.now();
      if (line) {
        showHintRef.current(line, BUBBLE_MS);
      }
    };

    /**
     * 调度心跳。1 秒一次 —— 比 1 分钟细,因为要精确判断「到点了」,
     * 同时开销极小(只读几个数字,没有 DOM 操作)。
     */
    const tick = () => {
      if (signal.disposed) return;
      if (!cfg.enabled) return;
      const now = Date.now();
      if (now < nextAt) return;
      // 上一句说完至少留 min 分钟冷却(防止配置乱改导致连发)
      if (lastSpokeAt > 0 && now - lastSpokeAt < cfg.minMinutes * 60_000) {
        nextAt = lastSpokeAt + cfg.minMinutes * 60_000;
        return;
      }
      // 先排下一次,再说话 —— 即使 speak 抛错也不会卡住调度
      nextAt = now + randomDelayMs(cfg.minMinutes, cfg.maxMinutes);
      void speak();
    };
    const timer = window.setInterval(tick, 1000);

    return () => {
      signal.disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('petAI:configChanged', refresh);
    };
  }, [characterId, characterName]);
}
