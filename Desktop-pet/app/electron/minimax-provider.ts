/**
 * MiniMax provider — 桌宠的多模态后端。
 *
 * 为什么要单独一个模块:桌宠现在有三条链路都要用模型,以前各写各的 HTTP 调用,
 * 结果是「同一个 key 在三个地方填三遍」。这里把 MiniMax 的三个能力收成一处:
 *
 *   1. LLM 文本/工具调用 → Anthropic 兼容端点 `/anthropic/v1/messages`
 *      （原生 OpenAI 兼容端点不吃 `type=image`,Anthropic 端点吃,见下方注释）
 *   2. 画面理解        → 同一个 Anthropic 端点,content 里放 `type=image` 块
 *   3. 音频理解        → 专用 ASR 端点 `/v1/speech_to_text`(multipart,model=asr-1.0)
 *
 * 实测结论(2026-10-31,本机实测):
 *   - Anthropic 端点**不收** `type=audio`(400 unsupported content type 'audio')
 *   - OpenAI 兼容端点收下 audio_url 但**不解析**,模型回「请上传音频文件」
 *   - 所以音频只能走 `/v1/speech_to_text`,实测中文逐字准确(带 segments 时间戳)
 *   - 图片必须走 Anthropic 端点,原生端点仍不支持
 *
 * 端点域名:国内 `api.minimax.cn` 与国际 `api.minimaxi.com` 都可用(实测同一 key 两边都通)。
 */

import { net } from 'electron';

/** 音频理解用的模型 —— MiniMax ASR 目前只接受这一个。 */
export const MINIMAX_ASR_MODEL = 'asr-1.0';

/** 默认 LLM —— 与本机 Hermes 主模型保持一致。 */
export const MINIMAX_DEFAULT_LLM = 'MiniMax-M3.1-Flash';

/** Anthropic 兼容端点根。国内站优先,失败可切国际站。 */
export const MINIMAX_BASE_URL = 'https://api.minimax.cn/anthropic';

/** ASR 端点根(不含 /v1/speech_to_text)。 */
export const MINIMAX_ASR_BASE_URL = 'https://api.minimax.cn';

/** 默认的国内站。国际站给不方便访问的用户留一个开关。 */
export type MiniMaxRegion = 'cn' | 'global';

export function minimaxBaseUrl(region: MiniMaxRegion = 'cn'): string {
  return region === 'global' ? 'https://api.minimaxi.com/anthropic' : 'https://api.minimax.cn/anthropic';
}

export function minimaxAsrBaseUrl(region: MiniMaxRegion = 'cn'): string {
  return region === 'global' ? 'https://api.minimaxi.com' : 'https://api.minimax.cn';
}

/** Anthropic 兼容端点需要的头。 */
export function minimaxHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

/**
 * 一条消息里的内容块。Anthropic 兼容形状:
 *   - text  → { type:'text', text }
 *   - image → { type:'image', source:{ type:'base64', media_type, data } }
 *   - audio → 不支持(走 ASR 端点),这里用类型层面拦住,别等 400
 */
export type MiniMaxContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };
    };

export interface MiniMaxMessage {
  role: 'user' | 'assistant';
  content: string | MiniMaxContentBlock[];
}

export interface MiniMaxChatResult {
  ok: boolean;
  /** 模型最终文本(已剥掉 thinking 块)。 */
  text: string;
  /** 模型的思考内容(如果有)。 */
  reasoning?: string;
  /** 错误信息 —— ok=false 时有值。 */
  error?: string;
  /** HTTP 状态码,便于上层区分「没配 key」和「模型报错」。 */
  status?: number;
}

/**
 * 调 MiniMax 的 Anthropic 兼容端点做一次非流式对话。
 *
 * 为什么要走 Electron 的 net 而不是 fetch:主进程用 net.request 有两个好处 ——
 * 不受 CORS 限制,且能复用系统的代理设置(用户开了 Clash 时不用单独配代理)。
 */
export async function minimaxChat(params: {
  apiKey: string;
  model?: string;
  system?: string;
  messages: MiniMaxMessage[];
  maxTokens?: number;
  region?: MiniMaxRegion;
  timeoutMs?: number;
  /** 取消信号 —— 桌宠关窗/换角色时要能中断在途请求。 */
  signal?: AbortSignal;
}): Promise<MiniMaxChatResult> {
  const {
    apiKey,
    model = MINIMAX_DEFAULT_LLM,
    system,
    messages,
    maxTokens = 2048,
    region = 'cn',
    timeoutMs = 120_000,
    signal,
  } = params;

  if (!apiKey) return { ok: false, text: '', error: 'MiniMax API Key 未配置', status: 401 };

  const url = `${minimaxBaseUrl(region)}/v1/messages`;
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens };
  if (system) body.system = system;

  try {
    const raw = await postJson(url, minimaxHeaders(apiKey), body, timeoutMs, signal);
    if (raw.status >= 400) {
      return {
        ok: false,
        text: '',
        error: raw.error || `MiniMax 请求失败(HTTP ${raw.status})`,
        status: raw.status,
      };
    }
    const parsed = JSON.parse(raw.body) as {
      content?: { type?: string; text?: string; thinking?: string }[];
    };
    const blocks = parsed.content ?? [];
    let text = '';
    let reasoning = '';
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    }
    return { ok: true, text: text.trim(), reasoning: reasoning.trim() || undefined };
  } catch (e) {
    return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 调 MiniMax 的 ASR 端点转写一段本地音频。
 *
 * 端点是 multipart:`model=asr-1.0` + `file`。**只接受 wav**——
 * 上游 dsh-douyin-agent 的实现也是先转成 wav 再发,这里保持一致。
 * 响应带 segments(句级时间戳),抖音那边要按时间点抽对白就用得上。
 */
export async function minimaxTranscribe(params: {
  apiKey: string;
  /** 本地音频文件绝对路径(wav)。 */
  filePath: string;
  /** 语言。空 = 混合语言识别。 */
  language?: string;
  region?: MiniMaxRegion;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<MiniMaxTranscribeResult> {
  const { apiKey, filePath, language = '', region = 'cn', timeoutMs = 180_000, signal } = params;

  if (!apiKey) {
    return { ok: false, text: '', segments: [], error: 'MiniMax API Key 未配置', status: 401 };
  }

  try {
    const fs = await import('node:fs');
    const bytes = await fs.promises.readFile(filePath);

    const url = `${minimaxAsrBaseUrl(region)}/v1/speech_to_text`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (language && language !== 'auto') headers.language = language;

    const raw = await postMultipart(
      url,
      headers,
      [
        { name: 'model', value: MINIMAX_ASR_MODEL },
        { name: 'response_format', value: 'verbose_json' },
        { name: 'timestamp_level', value: 'sentence' },
        { name: 'stream', value: 'false' },
      ],
      { name: 'file', filename: 'audio.wav', mimeType: 'audio/wav', bytes },
      timeoutMs,
      signal,
    );
    if (raw.status >= 400) {
      return {
        ok: false,
        text: '',
        segments: [],
        error: raw.error || `MiniMax 转写失败(HTTP ${raw.status})`,
        status: raw.status,
      };
    }
    const parsed = JSON.parse(raw.body) as {
      text?: string;
      duration?: number;
      segments?: { start?: number; end?: number; text?: string; speaker?: string }[];
    };
    const segments: MiniMaxTranscribeSegment[] = (parsed.segments ?? [])
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.text === 'string')
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: s.text as string,
        speaker: typeof s.speaker === 'string' ? s.speaker : undefined,
      }));
    return {
      ok: true,
      text: (parsed.text ?? '').trim(),
      segments,
      duration: typeof parsed.duration === 'number' ? parsed.duration : undefined,
    };
  } catch (e) {
    return { ok: false, text: '', segments: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface MiniMaxTranscribeSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface MiniMaxTranscribeResult {
  ok: boolean;
  text: string;
  segments: MiniMaxTranscribeSegment[];
  duration?: number;
  error?: string;
  status?: number;
}

/** 把本地图片文件读成 Anthropic 兼容的 image 块。 */
export async function minimaxImageBlock(
  filePath: string,
): Promise<{ type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } } | null> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ext = path.extname(filePath).toLowerCase();
  const mediaType =
    ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : null;
  if (!mediaType) return null;
  const bytes = await fs.promises.readFile(filePath);
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: Buffer.from(bytes).toString('base64') },
  };
}

// ---------------- 内部 HTTP ----------------

interface RawResponse {
  status: number;
  body: string;
  error?: string;
}

function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  return postRaw(url, headers, Buffer.from(JSON.stringify(body), 'utf-8'), timeoutMs, signal);
}

/** multipart 的一个普通字段。 */
interface MultipartField {
  name: string;
  value: string;
}

/** multipart 的一个文件字段。 */
interface MultipartFile {
  name: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * 发一个 multipart 请求。
 *
 * 为什么手拼而不是用 FormData:Electron 主进程里 FormData 的 File 拿不到原始字节
 * (Blob.arrayBuffer 是异步的,而这里要在同步的 body 拼装里拿到),踩过一次坑,
 * 所以这里直接构造 Buffer,字节可控。
 */
function postMultipart(
  url: string,
  headers: Record<string, string>,
  fields: MultipartField[],
  file: MultipartFile,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  const boundary = '----HermesMiniMaxBoundary7MA4YWxkTrZu0gW';
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        'utf-8',
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.mimeType}\r\n\r\n`,
      'utf-8',
    ),
  );
  chunks.push(file.bytes);
  chunks.push(Buffer.from('\r\n', 'utf-8'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  return postRaw(url, headers, Buffer.concat(chunks), timeoutMs, signal);
}

function postRaw(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url });
    for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);
    request.setHeader('Content-Length', String(body.length));

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      request.abort();
      finish(() => reject(new Error('请求已取消')));
    };
    const timer = setTimeout(() => {
      request.abort();
      finish(() => reject(new Error(`请求超时(${timeoutMs}ms)`)));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    request.on('response', (resp) => {
      let out = '';
      resp.on('data', (chunk) => {
        out += chunk.toString('utf-8');
      });
      resp.on('end', () => {
        const status = resp.statusCode ?? 0;
        let error: string | undefined;
        if (status >= 400) {
          try {
            const parsed = JSON.parse(out) as { error?: { message?: string } | string };
            const raw = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
            error = raw || out.slice(0, 300);
          } catch {
            error = out.slice(0, 300);
          }
        }
        finish(() => resolve({ status, body: out, error }));
      });
    });
    request.on('error', (e) => finish(() => reject(e)));
    request.write(body);
    request.end();
  });
}
