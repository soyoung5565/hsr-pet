/**
 * system-idle — 系统级「用户空闲时长」检测。
 *
 * 为什么必须走系统 API 而不能在渲染端监听鼠标键盘:
 *   桌宠是一个**透明置顶的 Electron 窗口**,用户真正在操作的是下面的应用。
 *   渲染端的 `window.addEventListener('mousemove')` 只能收到**本窗口**上的事件,
 *   而这个窗口是 click-through 的(鼠标穿透),根本收不到用户的操作。
 *   → 表现为"碎碎念的'只在你没操作时'永远判定为用户一直很闲",
 *   用户在打字时桌宠也在旁边嘀咕。
 *
 * 方案:Windows 的 `GetLastInputInfo` —— 系统自己记录"最后一次键盘/鼠标输入"的时间。
 *   正好就是我们想要的语义,而且不需要 hook 任何东西(不装全局钩子、不抢焦点)。
 *
 * 实现方式:跟 uia-reader 一样,spawn 一个 PowerShell 调 P/Invoke。
 *   - 优点:零 native module(不用 Electron rebuild)、零常驻hook。
 *   - 缺点:PS 启动 ~300ms。所以**只在需要时问一次**,并且结果缓存一小段时间。
 *
 * 非 Windows:退回到渲染端的本地事件(至少在开发/测试环境能工作),
 *   并明确标记 unreliable,让调用方知道精度有限。
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

/** 系统空闲时长的探测结果 */
export interface IdleInfo {
  /** 距离最后一次键盘/鼠标输入过了多少毫秒 */
  idleMs: number;
  /** 这个结果可不可信(false = 只能给个大概) */
  reliable: boolean;
}

/**
 * PowerShell 脚本:调 GetLastInputInfo,输出 tick 差值。
 * 用 -EncodedCommand(UTF-16LE base64)传脚本,避免引号/中文转义问题(同 uia-reader)。
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class IdleTime {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")]
  static extern uint GetTickCount();
  public static long Get() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(lii);
    if (!GetLastInputInfo(ref lii)) return -1;
    return (long)((GetTickCount() - lii.dwTime) & 0xFFFFFFFF);
  }
}
'@
$ms = [IdleTime]::Get()
if ($ms -lt 0) { Write-Output '{"error":"GetLastInputInfo failed"}' }
else { Write-Output ('{"idleMs":' + $ms + '}') }
`;

function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 调一次 GetLastInputInfo。超时 3 秒。 */
function queryWindowsIdle(): Promise<IdleInfo | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (v: IdleInfo | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(PS_SCRIPT)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done(null);
    }, 3000);

    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const m = buf.match(/\{"idleMs":\s*(\d+)\}/);
        if (m) {
          done({ idleMs: Number(m[1]), reliable: true });
          return;
        }
        done(null);
      } catch {
        done(null);
      }
    });
  });
}

/**
 * 带缓存的系统空闲时长查询。
 *
 * 为什么要缓存:PS 启动要 ~300ms,如果每次判断都问一次,会让主进程被 PowerShell
 *   进程淹没。缓存 3 秒足够(碎碎念的判据精度是分钟级)。
 */
export class SystemIdleProbe {
  private cached: IdleInfo | null = null;
  private cachedAt = 0;
  private inflight: Promise<IdleInfo | null> | null = null;

  constructor(private readonly ttlMs = 3000) {}

  async get(): Promise<IdleInfo> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    // 同一个探测正在跑 → 等它,不重复起进程
    if (this.inflight) {
      const r = await this.inflight;
      if (r) return r;
    } else {
      this.inflight = queryWindowsIdle();
    }
    let res: IdleInfo | null = null;
    try {
      res = await this.inflight;
    } finally {
      this.inflight = null;
    }
    if (res) {
      this.cached = res;
      this.cachedAt = Date.now();
      return res;
    }
    // 探测失败 → 标记不可靠,让调用方退回本地判据
    const fallback: IdleInfo = { idleMs: 0, reliable: false };
    this.cached = fallback;
    this.cachedAt = Date.now();
    return fallback;
  }
}

/** 全局单例(主进程里用) */
export const systemIdle = new SystemIdleProbe();

/** 非 Windows 的兜底:基于 os 的 uptime 做一个粗略估计(不可靠但不是 0) */
export function roughIdleFallback(): number {
  return Math.max(0, Date.now() - os.uptime() * 1000);
}
