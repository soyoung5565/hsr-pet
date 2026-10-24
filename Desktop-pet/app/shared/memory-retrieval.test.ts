/**
 * 记忆检索单元测试。
 *
 * 跑法:npx tsx shared/memory-retrieval.test.ts
 *
 * 为什么这些边界要测:
 *   - 「长期指令必须无条件保留」:这是用户的显式要求,一旦漏掉就是功能失效
 *     (比如"以后回答我都用英文"被丢掉,AI 立刻违背用户意图)。
 *   - 「limit 上限」:记忆一多就全量注入会撑爆 system prompt,必须有硬上限。
 *   - 「空 query 回退」:用户只发了一个"嗯"时,不能什么都不给模型。
 *   - 「中文 2-gram 匹配」:中文不分词,靠 2-gram 命中,得验证真的能匹配上。
 */

import {
  tokenize,
  guessCategory,
  scoreMemory,
  retrieveMemories,
  type ScorableMemory,
} from './memory-retrieval';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${extra ? ' — ' + extra : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `期望 ${e},实际 ${a}`);
}

const NOW = 1_700_000_000_000;

function mem(
  id: string,
  content: string,
  opts: Partial<ScorableMemory> = {},
): ScorableMemory {
  return {
    id,
    content,
    category: opts.category ?? 'other',
    importance: opts.importance ?? 3,
    hits: opts.hits ?? 0,
    lastUsedAt: opts.lastUsedAt ?? 0,
    updatedAt: opts.updatedAt ?? NOW,
  };
}

/* ============ tokenize ============ */

eq('tokenize: 英文词切分', tokenize('hello world'), ['hello', 'world']);
check(
  'tokenize: 单字符英文被丢掉',
  !tokenize('a b c').includes('a'),
  JSON.stringify(tokenize('a b c')),
);
check(
  'tokenize: 中文切成 2-gram',
  tokenize('咖啡').includes('咖啡'),
  JSON.stringify(tokenize('咖啡')),
);
eq('tokenize: 两个字的中文产生 1 个 bigram', tokenize('猫').length, 1);
eq('tokenize: 三个字的中文产生 2 个 bigram', tokenize('咖啡厅').length, 2);
check(
  'tokenize: 混合中英文都能切',
  tokenize('用 python 写').includes('python'),
  JSON.stringify(tokenize('用 python 写')),
);

/* ============ guessCategory ============ */

eq('guessCategory: 偏好', guessCategory('我喜欢喝冰美式'), 'preference');
eq('guessCategory: 指令', guessCategory('以后回答我都用中文'), 'instruction');
eq('guessCategory: 习惯', guessCategory('我每天七点起床'), 'habit');
eq('guessCategory: 事件', guessCategory('上周我去了趟广州'), 'event');
eq('guessCategory: 关系', guessCategory('我姐叫小芳'), 'relation');
eq('guessCategory: 事实', guessCategory('我的生日是3月5号'), 'fact');
eq('guessCategory: 兜底', guessCategory('嗯嗯'), 'other');

/* ============ scoreMemory ============ */

{
  const t = new Set(tokenize('我最喜欢喝什么咖啡'));
  const hit = scoreMemory(mem('a', '用户喜欢喝冰美式咖啡'), t, NOW);
  const miss = scoreMemory(mem('b', '用户的猫叫咪咪'), t, NOW);
  check('scoreMemory: 相关的得分 > 0', hit > 0, `hit=${hit}`);
  check('scoreMemory: 无关的得分 = 0', miss === 0, `miss=${miss}`);
}
{
  // 重要度高 → 分数高
  const t = new Set(tokenize('咖啡'));
  const lo = scoreMemory(mem('a', '咖啡', { importance: 1 }), t, NOW);
  const hi = scoreMemory(mem('b', '咖啡', { importance: 5 }), t, NOW);
  check('scoreMemory: 重要度影响分数', hi > lo, `lo=${lo} hi=${hi}`);
}
{
  // 冷记忆(30天+没用过)降权
  const t = new Set(tokenize('咖啡'));
  const fresh = scoreMemory(mem('a', '咖啡', { lastUsedAt: NOW }), t, NOW);
  const cold = scoreMemory(
    mem('b', '咖啡', { lastUsedAt: NOW - 60 * 86_400_000 }),
    t,
    NOW,
  );
  check('scoreMemory: 冷记忆降权', cold < fresh, `fresh=${fresh} cold=${cold}`);
}
{
  const t = new Set<string>();
  eq('scoreMemory: 空 query → 0 分', scoreMemory(mem('a', '咖啡'), t, NOW), 0);
}

/* ============ retrieveMemories ============ */

{
  const all = [
    mem('instr', '以后回答我都用中文', { category: 'instruction', importance: 5 }),
    mem('coffee', '用户喜欢喝冰美式咖啡', { category: 'preference' }),
    mem('cat', '用户的猫叫咪咪', { category: 'relation' }),
  ];
  const r = retrieveMemories(all, '推荐点咖啡', 12);
  const ids = r.memories.map((m) => m.id);
  check('retrieve: 长期指令无条件保留', ids.includes('instr'), JSON.stringify(ids));
  check('retrieve: 相关记忆被选中', ids.includes('coffee'), JSON.stringify(ids));
  check(
    'retrieve: 完全无关的普通记忆被排除',
    !ids.includes('cat'),
    JSON.stringify(ids),
  );
}
{
  const all = [
    mem('instr', '以后回答我都用中文', { category: 'instruction' }),
    mem('a', '记忆 A', { importance: 5 }),
    mem('b', '记忆 B', { importance: 4 }),
    mem('c', '记忆 C', { importance: 3 }),
  ];
  const r = retrieveMemories(all, '完全无关的问题', 2);
  check(
    'retrieve: limit 被严格遵守',
    r.memories.length <= 2,
    `len=${r.memories.length}`,
  );
  check(
    'retrieve: 空相关时回退按重要度取',
    r.memories.some((m) => m.id === 'a'),
    JSON.stringify(r.memories.map((m) => m.id)),
  );
}
{
  // 记忆很多时,不能全量返回
  const many: ScorableMemory[] = [];
  for (let i = 0; i < 50; i++) {
    many.push(mem(`m${i}`, `第 ${i} 条记忆内容`, { importance: 3 }));
  }
  const r = retrieveMemories(many, '记忆', 12);
  check(
    'retrieve: 50 条记忆只返回 limit 条',
    r.memories.length === 12,
    `len=${r.memories.length}`,
  );
}
{
  // 指令 + 相关记忆,总数不超过 limit
  const all = [
    mem('instr1', '以后用中文', { category: 'instruction' }),
    mem('instr2', '别叫我老板', { category: 'instruction' }),
    mem('instr3', '回答简短点', { category: 'instruction' }),
    mem('coffee', '喜欢咖啡', { category: 'preference' }),
  ];
  const r = retrieveMemories(all, '咖啡', 3);
  check(
    'retrieve: 指令+相关 也不超 limit',
    r.memories.length <= 3,
    `len=${r.memories.length}`,
  );
}
{
  // 空记忆列表
  const r = retrieveMemories([], '任何问题', 12);
  eq('retrieve: 空列表返回空', r.memories.length, 0);
}
{
  // 中文 query 能命中(2-gram 生效)
  const all = [mem('a', '用户喜欢喝冰美式咖啡', { category: 'preference' })];
  const r = retrieveMemories(all, '冰美式', 12);
  check(
    'retrieve: 中文 2-gram 能命中',
    r.memories.length === 1,
    JSON.stringify(r.memories.map((m) => m.id)),
  );
}
{
  // 分数:指令 = 999(特殊标记),普通相关 > 0
  const all = [
    mem('instr', '以后用中文', { category: 'instruction' }),
    mem('coffee', '喜欢咖啡', { category: 'preference' }),
  ];
  const r = retrieveMemories(all, '咖啡', 12);
  const instrScore = r.scores[r.memories.findIndex((m) => m.id === 'instr')];
  const coffeeScore = r.scores[r.memories.findIndex((m) => m.id === 'coffee')];
  check('retrieve: 指令分数是特殊值 999', instrScore === 999, `got=${instrScore}`);
  check('retrieve: 普通相关分数 > 0', coffeeScore > 0, `got=${coffeeScore}`);
}

/* ============ 结果 ============ */

console.log('');
console.log(`  记忆检索测试: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  全部通过 ✓');
