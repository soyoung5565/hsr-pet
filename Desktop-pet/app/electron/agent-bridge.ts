/**
 * agent-bridge —— 桌宠与外部 coding agent CLI 的联动层。
 *
 * 为什么单独做一层而不是直接 spawn:
 *   1. **可用性必须实测**,不能只看 `which`。本机 `codex` 装了但没登录,
 *      `command-code` 装了但没额度 —— 只看安装就报"可用"等于骗用户。
 *   2. 各个 CLI 的一次性执行参数完全不同(见 BACKENDS),不能共用一套命令。
 *   3. 输出里混着 ANSI 控制符 / 横幅 / 进度条,必须清洗后才能给气泡显示。
 *   4. 长任务要能流式把日志推给渲染端,否则用户看着桌宠发呆不知道在干什么。
 *
 * 设计原则:**探测归探测,运行归运行**。probe 只做便宜的静态检查(命令是否解析),
 * 真正的"能不能跑"由第一次 run 暴露,并在 run 返回里诚实给出错误原因。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 一个后端 CLI 的定义 */
interface BackendDef {
  id: string;
  label: string;
  /** 候选可执行文件名(按顺序找,第一个能解析的赢) */
  bins: string[];
  /**
   * 组装一次性执行参数。
   * 注意:各家参数不通用 —— 这是逐个人肉确认过的,不要"统一"成一套。
   */
  buildArgs: (prompt: string) => string[];
  /** 这个后端是否支持显式指定工作目录(不支持就靠 spawn 的 cwd) */
  supportedCwd: boolean;
  /** 额外的前置检查(可选),返回 null 表示通过,返回字符串表示不可用原因 */
  precheck?: () => string | null;
}

/* ===================== 后端定义 ===================== */

const BACKENDS: BackendDef[] = [
  {
    id: 'hermes',
    label: 'Hermes Agent',
    bins: ['hermes'],
    // `hermes -z <prompt>` = 非交互一次性执行,实测可用
    buildArgs: (p) => ['-z', p],
    supportedCwd: true,
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    bins: ['codex'],
    // `codex exec <prompt>` = 非交互执行
    buildArgs: (p) => ['exec', p],
    supportedCwd: true,
    precheck: () => {
      // codex 装了但没登录时,exec 会直接失败。这里只做静态提示,不实际调 API。
      const home = os.homedir();
      const candidates = [
        path.join(home, '.codex', 'auth.json'),
        path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'auth.json'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return null;
      }
      return '已安装但未登录(缺 ~/.codex/auth.json)。在终端跑 `codex login` 后再试。';
    },
  },
  {
    id: 'command-code',
    label: 'Command Code',
    bins: ['command-code', 'commandcode'],
    // `command-code -p <prompt>` = 非交互
    buildArgs: (p) => ['-p', p],
    supportedCwd: true,
    precheck: () => {
      // 静态能查的只有"登录没登录"——额度是账号状态,文件里查不到,
      // 只能靠真跑一次才知道(见 runtimeVerdict 机制)。
      const home = os.homedir();
      const authPath = path.join(home, '.commandcode', 'auth.json');
      if (!fs.existsSync(authPath)) {
        return '已安装但未登录(缺 ~/.commandcode/auth.json)。登录后再试。';
      }
      return null;
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bins: ['claude'],
    // `claude -p <prompt>` = print 模式(非交互)
    buildArgs: (p) => ['-p', p],
    supportedCwd: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bins: ['opencode'],
    // `opencode run <prompt>` = 非交互执行
    buildArgs: (p) => ['run', p],
    supportedCwd: true,
  },
];

/* ===================== 工具 ===================== */

/** 在 PATH + 常见安装目录里找可执行文件。找到返回绝对路径,否则 null。 */
function resolveBin(bins: string[]): { bin: string; full: string } | null {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  const pathDirs = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean);
  // 额外补几个 Windows 上常见的全局安装目录(用户可能装在非标准位置)
  if (isWin) {
    pathDirs.push(
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
      'D:\\hermes-data\\node',
    );
  }

  for (const name of bins) {
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return { bin: name, full: candidate };
          }
        } catch {
          // 权限 / 坏链接 → 跳过
        }
      }
    }
  }
  return null;
}

/** 清洗 CLI 输出:去 ANSI、去常见横幅、压掉连续空行 */
export function cleanAgentOutput(raw: string): string {
  let s = raw;
  // ANSI 转义序列(颜色 / 光标移动)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  // 光标控制 / 退格残留
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  // Windows 控制台在管道下有时会吐 CP936 乱码替换符
  s = s.replace(/�/g, '');
  // 压掉 3 行以上连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/* ===================== 探测 ===================== */

export interface AgentBackendInfo {
  id: string;
  label: string;
  available: boolean;
  reason: string;
  binPath?: string;
}

/**
 * ★ 运行时判定缓存 —— 解决"探针说谎"的问题。
 *
 * 静态探针(命令能不能解析、文件在不在)**永远查不出账号状态**:
 *   - command-code: 装了、登录了,但额度耗尽 → 静态全绿,实跑退出码 10;
 *   - codex:       装了,但 auth.json 是旧的 → 同样。
 * 实测踩坑:第一次探针把 command-code 报成"已就绪",真跑却回
 * "Insufficient credits" —— 用户看到的是"可用",点下去才炸。
 *
 * 做法:每次 runAgent 结束后,把结果按后端 id 记下来
 * (成功 = 明确可用;额度/登录类失败 = 明确不可用 + 原因),
 * 探针读这份缓存并**覆盖**静态结论。缓存有 TTL,过期后回到静态判断,
 * 避免"充了值却一直显示不可用"。
 */
interface RuntimeVerdict {
  /** 判定时间戳(ms) */
  at: number;
  available: boolean;
  reason: string;
}

/** 运行时判定缓存。TTL 30 分钟 —— 额度状态不会秒级变化,但用户可能刚充值。 */
const RUNTIME_VERDICT_TTL_MS = 30 * 60_000;

/** 后端 id → 最近一次运行判定 */
const runtimeVerdicts = new Map<string, RuntimeVerdict>();

/** 记一次运行判定(由 runAgent 在结束时调用) */
export function recordRuntimeVerdict(
  backendId: string,
  available: boolean,
  reason: string,
): void {
  runtimeVerdicts.set(backendId, { at: Date.now(), available, reason });
}

/** 取运行判定;没有或已过期 → null */
export function getRuntimeVerdict(backendId: string): RuntimeVerdict | null {
  const v = runtimeVerdicts.get(backendId);
  if (!v) return null;
  if (Date.now() - v.at > RUNTIME_VERDICT_TTL_MS) {
    runtimeVerdicts.delete(backendId);
    return null;
  }
  return v;
}

/** 只用于测试:清空运行判定缓存 */
export function _resetRuntimeVerdicts(): void {
  runtimeVerdicts.clear();
}

/**
 * 从输出/错误文本里认出"这个后端用不了"的信号。
 * 覆盖:额度不足 / 未登录 / 认证失败 / 需要交互式 TTY。
 */
export function detectUnavailableReason(text: string): string | null {
  const lower = text.toLowerCase();
  if (/insufficient credits|insufficient (credit|balance|funds)|quota exceeded|额度不足/.test(lower)) {
    return '账号额度不足(insufficient credits)。充值后才能用。';
  }
  if (/not logged in|未登录|please log ?in|authentication failed|bad credentials|unauthorized/.test(lower)) {
    return '未登录或认证失败。';
  }
  if (/requires a tty|interactive mode requires|not through a pipe/.test(lower)) {
    return '该 CLI 只能在交互式终端里跑,无法非交互调用。';
  }
  return null;
}

export function probeBackends(): AgentBackendInfo[] {
  return BACKENDS.map((b) => {
    const found = resolveBin(b.bins);
    if (!found) {
      return {
        id: b.id,
        label: b.label,
        available: false,
        reason: `未安装(找不到 ${b.bins.join(' 或 ')})`,
      };
    }
    const pre = b.precheck?.() ?? null;
    if (pre) {
      return {
        id: b.id,
        label: b.label,
        available: false,
        reason: pre,
        binPath: found.full,
      };
    }
    // ★ 运行判定优先于静态结论(额度/登录态只有跑过才知道)
    const verdict = getRuntimeVerdict(b.id);
    if (verdict && !verdict.available) {
      return {
        id: b.id,
        label: b.label,
        available: false,
        reason: verdict.reason,
        binPath: found.full,
      };
    }
    if (verdict && verdict.available) {
      return {
        id: b.id,
        label: b.label,
        available: true,
        reason: `已就绪:${found.full}(上次实跑通过)`,
        binPath: found.full,
      };
    }
    return {
      id: b.id,
      label: b.label,
      available: true,
      reason: `已就绪:${found.full}`,
      binPath: found.full,
    };
  });
}

/** 取第一个可用的后端;都没有则 null。
 *
 *  ⚠ 语义区分(重要):
 *   - preferId = 'auto' 或空 → 按 BACKENDS 顺序取第一个可用的(自动降级)。
 *   - preferId = 具体 id   → **该 id 不可用就报不可用**,不静默换一个后端。
 *     否则用户在设置里明明选了 codex,实际跑的是 hermes,而结果里只写着
 *     "backend=hermes" —— 用户会以为是 codex 跑出来的,这是欺骗。
 */
export function pickAvailableBackend(preferId?: string): {
  def: BackendDef;
  full: string;
} | null {
  const infos = probeBackends();
  const byId = new Map(infos.map((i) => [i.id, i]));

  // 优先用户指定的
  if (preferId && preferId !== 'auto') {
    const info = byId.get(preferId);
    const def = BACKENDS.find((b) => b.id === preferId);
    if (info?.available && def && info.binPath) return { def, full: info.binPath };
    return null; // 明确指定了但不可用 → 不降级
  }
  // 否则按 BACKENDS 顺序取第一个可用的(hermes 在最前 —— 本机唯一实测可跑的)
  for (const b of BACKENDS) {
    const info = byId.get(b.id);
    if (info?.available && info.binPath) return { def: b, full: info.binPath };
  }
  return null;
}

/* ===================== 运行 ===================== */

export interface AgentRunOptions {
  prompt: string;
  /** 工作目录;空 = 用户 home */
  cwd?: string;
  /** 超时秒数,默认 300(5 分钟) */
  timeoutSec?: number;
  /** 偏好的后端 id;不可用则自动回退到下一个可用 */
  preferId?: string;
  /** 每读到一行就回调(用于流式展示) */
  onLine?: (line: string) => void;
}

export interface AgentRunResult {
  ok: boolean;
  backend: string;
  output: string;
  error?: string;
  elapsedMs: number;
}

/**
 * 跑一次外部 agent。
 *
 * ⚠ 在 Windows 上 spawn 一个 `.cmd` 必须走 shell,否则 ENOENT。
 *   而走 shell 又要注意:参数里有中文 / 引号 / 换行时不能拼成一行字符串,
 *   否则会被 cmd.exe 拆开 —— 用数组形式 + shell:true 让 Node 自己处理转义。
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const t0 = Date.now();
  const prompt = (opts.prompt ?? '').trim();
  if (!prompt) {
    return { ok: false, backend: '', output: '', error: 'prompt 不能为空', elapsedMs: 0 };
  }

  const picked = pickAvailableBackend(opts.preferId);
  if (!picked) {
    const infos = probeBackends();
    // 区分两种"没有可用后端":
    //   a) 用户明确指定了某个后端,而它不可用 → 明确说"你选的这个不可用",
    //      并给出**可执行的下一步**(比如"跑 codex login")。
    //   b) 一个都没装 → 说"没装任何 agent CLI"。
    // 把这两种混成"没有可用的 agent CLI"是误导 —— 用户明明有 hermes 可用。
    const explicit = opts.preferId && opts.preferId !== 'auto';
    if (explicit) {
      const info = infos.find((i) => i.id === opts.preferId);
      return {
        ok: false,
        backend: '',
        output: '',
        error:
          `指定的后端「${info?.label ?? opts.preferId}」不可用:${info?.reason ?? '未知原因'}` +
          '\n可以改用 auto(自动挑一个可用的),或先把这个后端配置好。',
        elapsedMs: Date.now() - t0,
      };
    }
    return {
      ok: false,
      backend: '',
      output: '',
      error:
        '没有安装任何 agent CLI。检查结果:\n' +
        infos.map((i) => `  · ${i.label}: ${i.reason}`).join('\n'),
      elapsedMs: Date.now() - t0,
    };
  }

  const { def, full } = picked;
  const args = def.buildArgs(prompt);
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const timeoutMs = Math.max(10_000, Math.min(3600_000, (opts.timeoutSec ?? 300) * 1000));
  const isWin = process.platform === 'win32';
  // .cmd / .bat 必须经 shell;.exe 可直接 spawn
  const needsShell = isWin && /\.(cmd|bat)$/i.test(full);

  return await new Promise<AgentRunResult>((resolve) => {
    let settled = false;
    /** stdout —— 这才是 agent 的"答案" */
    const outChunks: string[] = [];
    /** stderr —— 诊断信息(警告 / 配置提示 / 进度条)。单独收,不混进 output。
     *  实测踩坑:hermes 会往 stderr 打 "MINIMAX_CN_API_KEY is not set" 这类
     *  配置提醒,混进 output 会让气泡里显示一堆和任务无关的噪声。 */
    const errChunks: string[] = [];

    const finish = (r: AgentRunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child;
    try {
      child = spawn(full, args, {
        cwd,
        shell: needsShell,
        windowsHide: true,
        env: {
          ...process.env,
          // 让 CLI 认为自己是管道输入,避免它开 TUI 等交互
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      });
    } catch (e) {
      finish({
        ok: false,
        backend: def.id,
        output: '',
        error: `启动 ${def.label} 失败:${(e as Error).message}`,
        elapsedMs: Date.now() - t0,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        ok: false,
        backend: def.id,
        output: cleanAgentOutput(outChunks.join('')),
        error: `超时(${Math.round(timeoutMs / 1000)}s)。任务可能还在跑,已强制结束。`,
        elapsedMs: Date.now() - t0,
      });
    }, timeoutMs);

    const handleChunk = (chunk: string, isErr: boolean) => {
      (isErr ? errChunks : outChunks).push(chunk);
      if (!opts.onLine) return;
      for (const line of chunk.split(/\r?\n/)) {
        const t = cleanAgentOutput(line);
        if (t) opts.onLine(isErr ? `[stderr] ${t}` : t);
      }
    };

    child.stdout?.on('data', (d: Buffer) => handleChunk(d.toString('utf8'), false));
    child.stderr?.on('data', (d: Buffer) => handleChunk(d.toString('utf8'), true));

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({
        ok: false,
        backend: def.id,
        output: cleanAgentOutput(outChunks.join('')),
        error: `${def.label} 执行错误:${e.message}`,
        elapsedMs: Date.now() - t0,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const out = cleanAgentOutput(outChunks.join(''));
      const err = cleanAgentOutput(errChunks.join(''));
      // 退出码非 0 → 失败。但有的 CLI 出错也返回 0,所以再补一层内容判据:
      // 输出为空 或 输出只有"检查登录/额度"这类提示 → 也算失败(否则会把报错当答案显示)。
      if (code !== 0) {
        // ★ 先看是不是"这个后端用不了"(额度/登录/需 TTY)——
        //   这类要记进运行判定,免得下次探针还报"已就绪"。
        const unusable = detectUnavailableReason(`${err}\n${out}`);
        if (unusable) {
          recordRuntimeVerdict(def.id, false, unusable);
          finish({
            ok: false,
            backend: def.id,
            output: out,
            error: `${def.label} 不可用:${unusable}`,
            elapsedMs: Date.now() - t0,
          });
          return;
        }
        finish({
          ok: false,
          backend: def.id,
          output: out,
          error:
            `${def.label} 退出码 ${code ?? 'null'}` + (err ? `\n${err.slice(0, 500)}` : ''),
          elapsedMs: Date.now() - t0,
        });
        return;
      }
      if (!out) {
        finish({
          ok: false,
          backend: def.id,
          output: '',
          error:
            `${def.label} 没有返回任何内容` + (err ? `\n${err.slice(0, 500)}` : ''),
          elapsedMs: Date.now() - t0,
        });
        return;
      }
      const unusable = detectUnavailableReason(`${out}\n${err}`);
      if (unusable) {
        recordRuntimeVerdict(def.id, false, unusable);
        finish({
          ok: false,
          backend: def.id,
          output: out,
          error: `${def.label} 不可用:${unusable}`,
          elapsedMs: Date.now() - t0,
        });
        return;
      }
      // 实跑通过 → 记为可用(探针会显示"上次实跑通过")
      recordRuntimeVerdict(def.id, true, '上次实跑通过');
      finish({ ok: true, backend: def.id, output: out, elapsedMs: Date.now() - t0 });
    });
  });
}
