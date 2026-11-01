/**
 * Video-Pet 角色 —— dsh-pet 的大肥鱼(蓝发小女仆)素材包。
 *
 * 这是一套**视频动画**形态的桌宠角色,和我们已有的两类并列:
 *   - live2d   : Live2D 模型(PIXI 渲染)
 *   - hatch-pet: 精灵表 PNG(Canvas 2D 逐帧切)
 *   - video-pet: 透明 webm 动画(<video> 元素播 VP9-alpha)
 *
 * 素材契约(来自 PC2005-cloud/dsh-pet,MIT):
 *   - webm/<动画名>.webm,640×360,VP9 + alpha(ALPHA_MODE=1),24fps,约 10 秒
 *   - config(本包内 dsh-config.json)给出动画分类: idle/turn/drag/clicks/
 *     moves/categories/events/sleep,共 109 段
 *   - memes/<名>.png 27 张表情图,配图用
 *   - sound/click-duck.wav 点击音效
 *
 * 为什么不直接把 webm 拆成精灵表:109 段 × 24fps × 10s ≈ 2.6 万帧,
 * 拆成 PNG 会膨胀到几百 MB,而 webm 全部只有 53MB —— 直接播视频更划算。
 */

export interface VideoPetManifest {
  /** 角色 id(= 文件夹名) */
  id: string;
  /** 显示名 */
  displayName: string;
  /** 素材根目录绝对路径(里面是 webm/ memes/ sound/ 子目录) */
  root: string;
  /** 动画名 → webm 相对路径。键是 config 里的动画名,不带扩展名。 */
  animations: Record<string, string>;
  /** 动画分类 —— 决定「随机播一段」「点播某类」等行为。 */
  categories: VideoPetAnimationConfig;
  /** 表情图:名称 → 相对路径 */
  memes: Record<string, string>;
  /** 表情图名称 → 画面描述(喂给模型让它挑图)。 */
  memeDescriptions: Record<string, string>;
  /** 点击音效相对路径(可空) */
  clickSound?: string;
  /** 人设 system prompt(碎碎念/对话共用)。 */
  persona?: string;
  /** 睡觉时说的梦话人设(可空=沿用 persona)。 */
  sleepPersona?: string;
  /** 说话时拒绝台词(睡着时)。 */
  sleepRefuseTexts?: string[];
  /** 入睡/醒来台词。 */
  sleepStartTexts?: string[];
  sleepEndTexts?: string[];
  /** 余额动画档位 —— 余额查询时按剩余额度选一段。 */
  balanceAnimations?: string[];
  /** 碎碎念动画。 */
  whisperAnimations?: string[];
  /** 工作状态动画(对应本机 agent 状态)。 */
  workStatusAnimations?: string[];
  /** 事件轮询周期(秒)。 */
  eventsRefreshSec?: { balance?: number; whisper?: number; sleepTalk?: number };
  /** 物理参数(重力/弹性系数等)。 */
  physics?: Record<string, number | boolean>;
}

/** 与 dsh-pet 的 animations 配置同构。 */
export interface VideoPetAnimationConfig {
  /** 待机 */
  idle: string[];
  /** 转身/张望 */
  turn: string[];
  /** 被拖拽时的反馈 */
  drag: string[];
  /** 点击回应 */
  clicks: string[];
  /** 走位 */
  moves: {
    default: { minDist: number; maxDist: number; margin: number; leadSec: number; tailSec: number };
    actions: { name: string; params?: Record<string, number> }[];
  };
  /** 随机动作分类(带权重)。 */
  categories: { id: string; weight: number; actions: string[]; noMirror?: boolean }[];
  /** 事件动画(余额/碎碎念/工作状态)。 */
  events: {
    balance?: string[];
    whisper?: string[];
    workStatus?: string[];
  };
  /** 睡觉动作套。 */
  sleep?: { start: string[]; loop: string[]; end: string[] }[];
}

/** 一个角色的资源索引 —— 与 CharacterIndex 里其它类型并列。 */
export interface VideoPetCharacter {
  id: string;
  name: string;
  category: string;
  type: 'video-pet';
  /** builtin = 跟随程序打包;user = 用户导入 */
  source: 'builtin' | 'user';
  root: string;
  manifestPath: string;
  /** 素材根绝对路径 */
  assetRoot: string;
  manifest: VideoPetManifest;
  // 占位字段(让 PetMenu / DebugPanel 等老组件不报错)
  expressions: string[];
  motions: { group: string; count: number }[];
  hitAreas: { name: string; id: string }[];
}

/** 从 dsh-config.json 的 memes 段构造「名称 → 描述」映射。 */
export function memeDescriptionsFromConfig(
  memes: Record<string, string> | undefined,
): Record<string, string> {
  if (!memes) return {};
  const out: Record<string, string> = {};
  for (const [key, desc] of Object.entries(memes)) {
    if (typeof desc === 'string' && desc.trim()) out[key] = desc.trim();
  }
  return out;
}

/**
 * 从动画分类里挑一个随机动作名(带权重)。
 *
 * 权重语义:同一分类内每段动作等概率;不同分类按 weight 加权。
 * 「文字」分类带 noMirror —— 那是带文字的动画,左右镜像会把字反过来。
 */
export function pickRandomAction(
  categories: VideoPetAnimationConfig['categories'],
  random: () => number = Math.random,
): string | null {
  const usable = categories.filter((c) => c.actions.length > 0);
  if (!usable.length) return null;
  const total = usable.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
  let roll = random() * total;
  for (const category of usable) {
    roll -= Math.max(1, category.weight);
    if (roll <= 0) {
      const action = category.actions[Math.floor(random() * category.actions.length)];
      return action ?? null;
    }
  }
  const last = usable[usable.length - 1];
  return last.actions[0] ?? null;
}

/**
 * 某个动画是否应该随朝向镜像。
 *
 * 「文字」分类的动画带字,镜像后字是反的 —— 必须不镜像。
 * 其余动作(如「照镜子」「挥挥手」)镜像了也没问题。
 */
export function shouldMirrorAnimation(
  name: string,
  categories: VideoPetAnimationConfig['categories'],
): boolean {
  for (const category of categories) {
    if (category.actions.includes(name)) return !category.noMirror;
  }
  return true;
}

/**
 * 表情包的 URL。
 *
 * pet://video-pet/<角色文件夹名>/memes/<图名>.png
 *
 * 两段都要 encodeURIComponent —— 角色名和图名都是中文,
 * 不编码的话路由匹配不上(实测会 404)。
 *
 * @param name  图名(= 文件名去扩展名)
 * @param manifestId 角色 id(= 文件夹名)
 * @param source builtin 还是 user —— 决定 pet:// 的 host
 */
export function videoPetMemeUrl(
  name: string,
  manifestId: string,
  source: 'builtin' | 'user' = 'builtin',
): string {
  const host = source === 'user' ? 'video-pet-user' : 'video-pet';
  return `pet://${host}/${encodeURIComponent(manifestId)}/memes/${encodeURIComponent(name)}.png`;
}

/** 睡觉动画套 —— 取第一套(本项目只做一套,不做多睡姿)。 */
export function firstSleepSet(
  sleep: VideoPetAnimationConfig['sleep'] | undefined,
): { start: string[]; loop: string[]; end: string[] } | null {
  if (!sleep || !sleep.length) return null;
  return sleep[0];
}
