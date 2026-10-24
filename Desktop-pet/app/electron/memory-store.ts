/**
 * memory-store — 用户级长期记忆(v2 · 带分类/重要度/检索)。
 *
 * 存储位置:`app.getPath('userData')/memory.json`
 *  - Windows: `C:\Users\<USERNAME>\AppData\Roaming\<appName>\memory.json`
 *  - macOS:   `~/Library/Application Support/<appName>/memory.json`
 *  - Linux:   `~/.config/<appName>/memory.json`
 *
 * 跨模型、跨会话:每次 streamChat 都会把这里的内容注入到 system prompt 里,
 * 这样 AI 在任何会话、用任何模型,都能"记得"用户告诉过它的事。
 *
 * AI 通过两个 builtin tool 操作记忆:
 *  - `app__remember`(content)            → 写入新条目
 *  - `app__forget`(id 或 content_match)  → 删除指定条目
 *
 * ── v2 相比 v1 的变化(为什么改) ─────────────────────────────
 * v1 是一条平铺的字符串数组,所有记忆**无条件全量**注入 system prompt。
 * 这有两个实际问题:
 *   1. 记忆条数一多(几十条以上),system prompt 会被撑爆,挤占真正有用的上下文,
 *      而且大量无关记忆会干扰模型注意力(把"我养了只猫"当成本次问题的线索)。
 *   2. 没有轻重之分 —— "我咖啡只喝冰美式"和"我上周去了趟广州"被同等对待。
 *
 * v2 的解法:
 *   - **分类**(category):让模型知道这是偏好/事实/习惯/事件/指令/人物。
 *   - **重要度**(importance 1~5):决定它被多频繁地注入。
 *   - **相关性检索**(retrieveMemories):按当前用户问题打分,只注入最相关的若干条。
 *   - **访问计数**(hits/lastUsedAt):被用到的记忆会保持热度,没被用的慢慢冷却。
 *     这样"常用的偏好"永远在,冷知识自动退场。
 *   - **兼容性**:老版本写出的 memory.json(纯字符串数组)照样能读,读时补默认值。
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  MEMORY_CATEGORIES,
  categoryLabel,
  guessCategory,
  retrieveMemories as retrieveFrom,
  scoreMemory,
  tokenize,
  type MemoryCategory,
  type ScorableMemory,
} from '../shared/memory-retrieval.js';

export { categoryLabel };
export { MEMORY_CATEGORIES } from '../shared/memory-retrieval.js';
export type { MemoryCategory };

export interface Memory extends ScorableMemory {
  /** Unix ms */
  createdAt: number;
}

function memoryPath(): string {
  return path.join(app.getPath('userData'), 'memory.json');
}

function genId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

/** 老版本(以及被手工改坏)的数据一律当空,不抛 —— 记忆功能不能把整个应用搞挂。 */
function load(): Memory[] {
  try {
    const raw = fs.readFileSync(memoryPath(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: Memory[] = [];
    for (const x of arr) {
      // v2 形态:对象
      if (x && typeof x === 'object' && typeof (x as Memory).content === 'string') {
        const m = x as Partial<Memory> & { content: string };
        out.push(normalize({
          id: typeof m.id === 'string' ? m.id : genId(),
          content: m.content,
          createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
          category: isCategory(m.category) ? m.category : guessCategory(m.content),
          importance: clampImportance(m.importance),
          hits: typeof m.hits === 'number' ? m.hits : 0,
          lastUsedAt: typeof m.lastUsedAt === 'number' ? m.lastUsedAt : 0,
          updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : (m.createdAt ?? Date.now()),
        }));
        continue;
      }
      // v1 形态:纯字符串
      if (typeof x === 'string' && x.trim()) {
        const content = x.trim();
        out.push(normalize({
          id: genId(),
          content,
          createdAt: Date.now(),
          category: guessCategory(content),
          importance: 3,
          hits: 0,
          lastUsedAt: 0,
          updatedAt: Date.now(),
        }));
      }
    }
    return out;
  } catch {
    // 文件不存在 / 损坏 → 当成空列表
    return [];
  }
}

function isCategory(c: unknown): c is MemoryCategory {
  return typeof c === 'string' && (MEMORY_CATEGORIES as string[]).includes(c);
}

function clampImportance(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 3;
  return Math.max(1, Math.min(5, n));
}

/** 补齐缺失字段,并保证数值合法 */
function normalize(m: Memory): Memory {
  return {
    id: m.id,
    content: m.content,
    createdAt: m.createdAt,
    category: isCategory(m.category) ? m.category : guessCategory(m.content),
    importance: clampImportance(m.importance),
    hits: Math.max(0, Math.floor(m.hits ?? 0)),
    lastUsedAt: Math.max(0, m.lastUsedAt ?? 0),
    updatedAt: m.updatedAt ?? m.createdAt,
  };
}

/** 从内容猜分类 —— 见 shared/memory-retrieval.ts(单一实现,这里只做转发) */
export { guessCategory };

function save(list: Memory[]): void {
  const p = memoryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
}

/** 列出所有记忆,按创建时间正序(老的在前) */
export function listMemories(): Memory[] {
  return load().sort((a, b) => a.createdAt - b.createdAt);
}

/** 添加一条记忆。返回新条目。
 *  内部会去重 — 已经有完全相同 content 的条目则不重复添加,只把时间刷新一下。 */
export function addMemory(content: string, opts?: { category?: MemoryCategory; importance?: number }): Memory {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content is empty');
  const list = load();
  const dup = list.find((m) => m.content === trimmed);
  if (dup) {
    dup.createdAt = Date.now();
    dup.updatedAt = Date.now();
    if (opts?.category) dup.category = opts.category;
    if (opts && opts.importance !== undefined) dup.importance = clampImportance(opts.importance);
    save(list);
    return dup;
  }
  const m: Memory = normalize({
    id: genId(),
    content: trimmed,
    createdAt: Date.now(),
    category: opts?.category ?? guessCategory(trimmed),
    importance: clampImportance(opts?.importance),
    hits: 0,
    lastUsedAt: 0,
    updatedAt: Date.now(),
  });
  list.push(m);
  save(list);
  return m;
}

/** 按 id 编辑记忆内容。新内容空白会抛错。存在 id 则更新返回 true,否则 false。
 *  不更新 createdAt(保留历史顺序)。 */
export function updateMemory(
  id: string,
  content: string,
  opts?: { category?: MemoryCategory; importance?: number },
): boolean {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content is empty');
  const list = load();
  const target = list.find((m) => m.id === id);
  if (!target) return false;
  target.content = trimmed;
  target.updatedAt = Date.now();
  if (opts?.category) target.category = opts.category;
  if (opts?.importance !== undefined) target.importance = clampImportance(opts.importance);
  save(list);
  return true;
}

/** 按 id 或内容片段删除。返回删除的数量。
 *  match 可以是完整 id,或者 content 包含的子串(大小写敏感)。 */
export function removeMemory(match: string): number {
  if (!match) return 0;
  const list = load();
  const before = list.length;
  const next = list.filter(
    (m) => m.id !== match && !m.content.includes(match),
  );
  if (next.length === before) return 0;
  save(next);
  return before - next.length;
}

/** 清空所有记忆 — 保留接口给「设置」面板调用。 */
export function clearMemories(): void {
  save([]);
}

/* ==================== 检索(核心新增) ==================== */

/** 极简中文/英文分词 —— 实现见 shared/memory-retrieval.ts(单一实现,这里只转发) */
export { tokenize, scoreMemory };

/**
 * 按当前查询挑出最相关的记忆。
 *
 * @param query 用户这轮说的话(可为空 —— 空则回退到"按重要度取前 N")
 * @param limit 最多返回几条
 * @param alwaysIncludeCategories 这些分类无条件带上(比如「长期指令」——
 *        那是用户明确要求"每次都这样"的东西,不能因为这次没提到就丢掉)
 */
export function retrieveMemories(
  query: string,
  limit = 12,
  alwaysIncludeCategories: MemoryCategory[] = ['instruction'],
): { memories: Memory[]; scores: number[] } {
  const list = listMemories();
  if (list.length === 0) return { memories: [], scores: [] };
  return retrieveFrom(list, query, limit, alwaysIncludeCategories) as {
    memories: Memory[];
    scores: number[];
  };
}

/** 把被检索到的记忆的 hits/lastUsedAt 更新掉(热度机制)。 */
export function markMemoriesUsed(ids: string[]): void {
  if (ids.length === 0) return;
  const list = load();
  const set = new Set(ids);
  const now = Date.now();
  let changed = false;
  for (const m of list) {
    if (set.has(m.id)) {
      m.hits += 1;
      m.lastUsedAt = now;
      changed = true;
    }
  }
  if (changed) save(list);
}

/* ==================== prompt 拼装 ==================== */

/** 拼成给 LLM 看的纯文本块。给 system prompt 用。
 *  空记忆时返回空字符串,调用方可据此判断要不要插入到 prompt。
 *
 *  @param query 本轮用户输入 —— 用来做相关性筛选。不传则全量(旧行为)。 */
export function formatMemoriesForPrompt(query?: string): string {
  const list = listMemories();
  if (list.length === 0) return '';
  const lines = list.map((m) => {
    const d = new Date(m.createdAt);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `  - [${dateStr}] ${m.content}`;
  });
  return [
    '【你关于该用户的长期记忆 — 任何会话、任何模型都会看到】',
    '记忆是用户在过去对话里明确告诉你「记住」的事(偏好 / 习惯 / 个人信息 / 重要事件等)。',
    '回答时如有相关条目,自然地带入参考(不必每次主动提及"我记得你...")。',
    '条目:',
    ...lines,
  ].join('\n');
}

/**
 * v2 的 prompt 拼装:按相关性筛选 + 标注分类。
 * 分类标注让模型更精准地使用记忆("偏好"类 = 别硬塞给用户;"指令"类 = 必须遵守)。
 */
export function formatMemoriesForPromptV2(query?: string, limit = 12): string {
  const list = listMemories();
  if (list.length === 0) return '';
  const { memories, scores } = retrieveMemories(query ?? '', limit);
  if (memories.length === 0) return '';
  const now = Date.now();
  const lines = memories.map((m, i) => {
    const d = new Date(m.createdAt);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = scores[i];
    // 分数高的(检索命中)标 ⭐,让模型知道这条和当前问题强相关
    const mark = s >= 999 ? '★' : s > 0 ? '⭐' : '·';
    return `  ${mark} [${dateStr}][${categoryLabel(m.category)}] ${m.content}`;
  });
  const total = list.length;
  const shown = memories.length;
  const out = [
    '【你关于该用户的长期记忆 — 跨会话、跨模型保留】',
    '记忆是用户在过去对话里明确告诉你「记住」的事(偏好 / 习惯 / 个人信息 / 重要事件等)。',
    '⭐ = 与当前问题相关,回答时优先参考;★ = 长期指令,必须遵守;· = 一般背景信息。',
    '回答时自然地带入参考,不必每次主动提及"我记得你..."。',
  ];
  if (shown < total) {
    out.push(`(共 ${total} 条,与当前话题最相关的 ${shown} 条已列出)`);
  }
  out.push('条目:', ...lines);
  // 记录热度(下一次检索时,常用的记忆会排得更前)
  markMemoriesUsed(memories.filter((_, i) => scores[i] > 0).map((m) => m.id));
  return out.join('\n');
}
