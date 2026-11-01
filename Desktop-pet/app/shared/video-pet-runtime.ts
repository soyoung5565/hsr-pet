/**
 * Video-Pet 的运行时状态 —— 睡觉 / 说梦话 / 表情包 / 事件动画。
 *
 * 这套对应 dsh-pet(PC2005-cloud/dsh-pet, MIT)的功能,搬进我们的独立桌宠。
 *
 * 上游是「宿主半侧 + 浏览器半侧」两个进程用 /state 轮询同步;我们是单进程
 * Electron,直接用一个模块 + 事件广播就够 —— 不需要那套轮询协议。
 *
 * 覆盖的上游功能:
 *   - 睡觉:start → loop → end 三段,睡着时拒绝一切打扰(碎碎念/余额/待办)
 *   - 说梦话:睡着期间按周期冒一句,只弹气泡不换动画
 *   - 表情包:碎碎念随机配图 + 对话按语境选图
 *   - 事件动画:碎碎念/工作状态/余额 各有独立的动画池
 */

/** 睡觉阶段。 */
export type SleepPhase = 'start' | 'loop' | 'end' | null;

/** 表情包池里的一条。 */
export interface MemeEntry {
  /** 图名(= 文件名去扩展名)。 */
  name: string;
  /** 给模型看的描述(用来挑图)。 */
  desc: string;
}

/**
 * 从素材包的 memes 映射构造候选池。
 *
 * 只保留磁盘上真实存在的图 —— 池说「能选」就必须「取得到」,
 * 否则气泡里会出现裂图。
 */
export function readMemePool(
  memes: Record<string, string> | undefined,
  files: Record<string, string> | undefined,
): MemeEntry[] {
  if (!memes || !files) return [];
  const out: MemeEntry[] = [];
  for (const [name, desc] of Object.entries(memes)) {
    const text = typeof desc === 'string' ? desc.trim() : '';
    if (!name || !text) continue;
    if (!files[name]) continue;
    out.push({ name, desc: text });
  }
  // 不排序 —— 顺序 = 配置里的顺序,是给用户用的
  return out;
}

/** 均匀随机抽一张。 */
export function pickMeme(pool: MemeEntry[], random: () => number = Math.random): MemeEntry | undefined {
  if (!pool.length) return undefined;
  const idx = Math.floor(random() * pool.length) % pool.length;
  return pool[idx];
}

/**
 * 模型选图的校验:只在池内命中时才认。
 *
 * ★ 必须校验 —— 模型会编造图名(幻觉)。池外名字一律丢弃,
 *   否则气泡里就是裂图。
 */
export function validateMemeChoice(choice: string, pool: MemeEntry[]): MemeEntry | null {
  const key = choice.trim();
  if (!key) return null;
  return pool.find((m) => m.name === key) ?? null;
}

/**
 * 给模型的选图清单。
 *
 * 限制张数:清单是每条消息都要附的,token 随图片数线性增长。
 * 上游默认 10 张(池子 27 张的约 1/3 开销)。
 */
export function memeCatalog(pool: MemeEntry[], limit = 10): string {
  if (!pool.length) return '';
  const shown = pool.slice(0, Math.max(1, limit));
  return shown.map((m) => `- ${m.name}: ${m.desc}`).join('\n');
}

/**
 * 睡觉状态机。
 *
 * 规则(与上游一致):
 *   - 进入必须先播 start(once),再切 loop(无限播)
 *   - 入睡过渡里被叫醒 → 不播 end(它没真睡着过)
 *   - 睡着期间一切打扰只回拒绝台词,不换动画
 */
export class SleepMachine {
  private current: { set: { start: string; loop: string; end: string }; phase: SleepPhase } | null = null;
  /** 醒着时用来接「回来」的回调。 */
  constructor(
    private readonly play: (name: string, once: boolean) => void,
    private readonly onWake: () => void,
  ) {}

  /** 进睡。 */
  sleep(set: { start: string; loop: string; end: string }): void {
    if (this.current !== null) return;
    this.current = { set, phase: 'start' };
    this.play(set.start, true);
  }

  /**
   * 醒来。
   *
   * @param onWakeNow 入睡过渡中被叫醒时立刻回到待机的回调。
   *   ★ 为什么需要:入睡过渡动画有 10 秒长,如果只是作废状态机,
   *     画面会一直停在「睡觉-开始」直到那段播完 —— 用户看着像没醒过来。
   *     立刻切回待机才符合「点一下就醒」的预期。
   */
  wake(onWakeNow?: () => void): boolean {
    if (this.current === null) return false;
    // 入睡过渡中被打断:不播 end,直接回到待机
    if (this.current.phase === 'start') {
      this.current = null;
      onWakeNow?.();
      return false;
    }
    if (this.current.phase === 'end') return false;
    this.current.phase = 'end';
    this.play(this.current.set.end, true);
    return true;
  }

  /** 睡吗。 */
  sleeping(): boolean {
    return this.current !== null;
  }

  /** 当前阶段。 */
  phase(): SleepPhase {
    return this.current?.phase ?? null;
  }

  /**
   * 动画播完时的回调。
   *
   * @returns true = 这次 ended 归睡觉管(调用方不要再推进随机链)
   */
  consumeEnded(): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (cur.phase === 'start') {
      // 入睡过渡播完 → 进入循环
      cur.phase = 'loop';
      this.play(cur.set.loop, false);
      return true;
    }
    if (cur.phase === 'end') {
      // 醒来过渡播完 → 彻底醒
      this.current = null;
      this.onWake();
      return true;
    }
    return false;
  }
}

/** 睡着时的默认拒绝台词。 */
export const DEFAULT_SLEEP_REFUSE = [
  '我在睡觉，别烦我……',
  '唔……让我再睡一会儿。',
  '呼……呼……（装作没听见）',
];

/** 默认的入睡/醒来台词。 */
export const DEFAULT_SLEEP_START = ['好困……我先睡一会儿。', '那我去睡啦，晚安。'];
export const DEFAULT_SLEEP_END = ['唔……我醒了。', '睡饱啦，主人！'];

/**
 * 说梦话的提示词。
 *
 * 上游的做法:梦话用**人设 + 睡觉情景提示词**,只弹气泡不换动画。
 */
export function buildSleepTalkPrompt(persona: string, name: string): string {
  return (
    `${persona}\n\n` +
    `你的名字是「${name}」。\n` +
    '你现在正在睡觉,睡着了之后会说梦话。' +
    '请说一句梦话:像是迷迷糊糊、半梦半醒间嘟囔出来的内容。\n' +
    '要求:短短一句(20字以内),自然随意,不要解释自己,不要说自己在睡觉,不要提AI。'
  );
}

/**
 * 碎碎念的配图策略:随机抽一张(不做语境挑选)。
 *
 * 为什么要分开:
 *   - 碎碎念**没有上下文**可选 —— 它就是随口一句,没有对话语境
 *   - 对话有真实上下文(用户输入 + 历史),按语境挑才贴合
 */
export function pickWhisperMeme(pool: MemeEntry[]): MemeEntry | undefined {
  return pickMeme(pool);
}
