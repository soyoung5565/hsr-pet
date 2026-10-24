/**
 * memory-retrieval — 记忆检索的**纯逻辑**部分(不依赖 electron)。
 *
 * 为什么要单独拆一个文件:
 *   memory-store.ts 里 import 了 electron 的 `app`(拿 userData 路径),
 *   而 electron 在 node 环境(单元测试)里是加载不起来的 —— 有依赖的模块没法测。
 *   把"分词 / 打分 / 检索 / 分类"这些纯函数抽到这里,
 *   memory-store 负责 IO(读写文件),本文件负责算法。两边各自可测。
 */

/** 记忆分类 —— 分类让模型知道"这条是什么性质的信息"。 */
export type MemoryCategory =
  | 'preference' // 偏好:我喜欢/我不喜欢/我习惯用
  | 'fact' // 事实:我的工作是/我住在/我的生日是
  | 'habit' // 习惯:我每天几点起床 / 我通勤多久
  | 'event' // 事件:上周我去了趟广州
  | 'relation' // 人物/关系:我姐叫 XX / 我养了只猫叫 XX
  | 'instruction' // 指令:以后回答我都要用中文 / 别叫我老板
  | 'other';

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  'preference',
  'fact',
  'habit',
  'event',
  'relation',
  'instruction',
  'other',
];

export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: '偏好',
  fact: '事实',
  habit: '习惯',
  event: '事件',
  relation: '人物/关系',
  instruction: '长期指令',
  other: '其他',
};

export function categoryLabel(c: MemoryCategory): string {
  return CATEGORY_LABEL[c] ?? '其他';
}

/** 检索时用的记忆形状(只要算法需要的字段)。 */
export interface ScorableMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  importance: number;
  hits: number;
  lastUsedAt: number;
  updatedAt: number;
}

/* ==================== 分词 ==================== */

/**
 * 极简中文/英文分词 —— 够用即可,目的是算出"这条记忆和当前问题相不相关"。
 * 做法:连续 CJK 字符切成 2-gram;英文/数字按词切。
 * 不引分词库(这是桌宠,主进程体积敏感)。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = (text ?? '').toLowerCase();
  // 英文/数字词
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+#.-]*/g)) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  // CJK 2-gram
  const cjk = lower.replace(/[^一-鿿]/g, ' ');
  for (const chunk of cjk.split(/\s+/)) {
    if (chunk.length === 0) continue;
    if (chunk.length === 1) {
      out.push(chunk);
    } else {
      for (let i = 0; i + 1 < chunk.length; i++) out.push(chunk.slice(i, i + 2));
    }
  }
  return out;
}

/* ==================== 分类猜测 ==================== */

/** 从内容猜分类 —— 老数据迁移 / 用户不填分类时用。判据从强到弱。 */
export function guessCategory(content: string): MemoryCategory {
  const s = (content ?? '').toLowerCase();
  if (/(以后|以后都|从今|不要再|别再|请一直|务必|每次都)/.test(s)) return 'instruction';
  if (/(我喜欢|我爱|我讨厌|我不喜欢|不吃|不喝|爱吃|爱喝|偏好)/.test(s)) return 'preference';
  if (/(我姐|我哥|我弟|我妹|我猫|我狗|我朋友|我同事|我老婆|我老公|我孩子)/.test(s)) {
    return 'relation';
  }
  if (/(每天|每周|每月|习惯|总是|通常|一般会|从不)/.test(s)) return 'habit';
  if (/(昨天|上周|上个月|今天|那天|曾经|以前|去年)/.test(s)) return 'event';
  if (/(我的|我是|我在|我叫|生日|工作|专业|学校|公司)/.test(s)) return 'fact';
  return 'other';
}

/* ==================== 打分 ==================== */

/** 一条记忆与查询的相关度分(0 = 完全无关)。 */
export function scoreMemory(
  mem: ScorableMemory,
  queryTokens: Set<string>,
  now: number,
): number {
  if (queryTokens.size === 0) return 0;
  const memTokens = new Set(tokenize(mem.content));
  let hits = 0;
  for (const t of queryTokens) {
    if (memTokens.has(t)) hits++;
  }
  if (hits === 0) return 0;
  // 覆盖率:命中查询词的比例(比绝对数更能反映"这条整体都在讲这件事")
  const coverage = hits / queryTokens.size;
  // 重要度加成:1~5 → 0.92~1.52
  const impWeight = 0.8 + mem.importance * 0.12;
  // 热度:被用过多次的记忆略微加权
  const heat = 1 + Math.min(0.3, mem.hits * 0.05);
  // 冷记忆衰减:超过 30 天没用过的,降权(不删除,只是不主动冒头)
  const idleDays = mem.lastUsedAt > 0 ? (now - mem.lastUsedAt) / 86_400_000 : 0;
  const decay = idleDays > 30 ? 0.6 : 1;
  return coverage * impWeight * heat * decay;
}

/* ==================== 检索 ==================== */

/**
 * 按当前查询挑出最相关的记忆。
 *
 * @param all 全部记忆
 * @param query 用户这轮说的话(可为空 —— 空则回退到"按重要度取前 N")
 * @param limit 最多返回几条
 * @param alwaysIncludeCategories 这些分类无条件带上(比如「长期指令」——
 *        那是用户明确要求"每次都这样"的东西,不能因为这次没提到就丢掉)
 */
export function retrieveMemories(
  all: ScorableMemory[],
  query: string,
  limit = 12,
  alwaysIncludeCategories: MemoryCategory[] = ['instruction'],
): { memories: ScorableMemory[]; scores: number[] } {
  if (all.length === 0) return { memories: [], scores: [] };
  const now = Date.now();
  const qTokens = new Set(tokenize(query ?? ''));

  const forced: ScorableMemory[] = [];
  const rest: { m: ScorableMemory; s: number }[] = [];
  for (const m of all) {
    if (alwaysIncludeCategories.includes(m.category)) {
      forced.push(m);
      continue;
    }
    const s = scoreMemory(m, qTokens, now);
    if (s > 0) rest.push({ m, s });
  }

  // 相关命中按分数降序;分数相同时重要度高者优先
  rest.sort((a, b) => b.s - a.s || b.m.importance - a.m.importance);

  // 没查到任何相关内容(query 为空或完全不搭)→ 按重要度 + 热度取前 limit
  // 这样"记忆一多就全量注入"的问题不会重现,同时不至于什么都不给模型。
  let picked: ScorableMemory[];
  if (rest.length === 0) {
    picked = [...all]
      .sort(
        (a, b) =>
          b.importance - a.importance ||
          b.hits - a.hits ||
          b.updatedAt - a.updatedAt,
      )
      .slice(0, limit);
  } else {
    picked = rest.slice(0, Math.max(0, limit - forced.length)).map((r) => r.m);
  }
  // forced 里的指令优先级最高,始终保留(但也不能无限膨胀)
  picked = [...forced.slice(0, Math.max(1, limit - picked.length)), ...picked].slice(0, limit);

  const scores = picked.map((m) => {
    if (alwaysIncludeCategories.includes(m.category)) return 999;
    return scoreMemory(m, qTokens, now);
  });
  return { memories: picked, scores };
}
