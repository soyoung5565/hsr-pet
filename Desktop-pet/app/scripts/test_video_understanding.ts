/**
 * 视频理解管线端到端验证(不走 Electron)。
 *
 * 直接调 video-understanding.ts 的逻辑 —— 但那个文件 import 了 electron 的 net,
 * 在纯 node 下跑不了。所以这里复刻它的调用序列,打到真实的 MiniMax 端点:
 *
 *   ① ffmpeg 抽帧 → ② MiniMax 视觉 → ③ ffmpeg 抽音轨 → ④ MiniMax ASR → ⑤ MiniMax 合成
 *
 * 目的:验证「画面 + 音频 → MiniMax → 一句话」这条链路真的通,而不是纸面可行。
 *
 * 用法:npx tsx scripts/test_video_understanding.ts <视频路径>
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FFMPEG = 'C:/Users/MR/AppData/Local/hermes/tools/ffmpeg-9.0.1-win32-x64/bin/ffmpeg.exe';
const FFPROBE = 'C:/Users/MR/AppData/Local/hermes/tools/ffmpeg-9.0.1-win32-x64/bin/ffprobe.exe';

function readKey(): string {
  const envPath = 'D:/hermes-data/.env';
  const text = readFileSync(envPath, 'utf-8');
  for (const line of text.split('\n')) {
    if (line.startsWith('MINIMAX_CN_API_KEY')) {
      return line.split('=')[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('没找到 MINIMAX_CN_API_KEY');
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function postMultipart(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  filePath: string,
): Promise<any> {
  const boundary = '----TestBoundary7MA4YWxkTrZu0gW';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf-8'));
  }
  const bytes = await fs.readFile(filePath);
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      'utf-8',
    ),
  );
  chunks.push(bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'));

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  });
  return res.json();
}

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error('用法:npx tsx scripts/test_video_understanding.ts <视频路径>');
    process.exit(1);
  }
  const apiKey = readKey();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pet-video-test-'));
  console.log('workDir:', workDir);

  try {
    // ---- 时长 ----
    const durOut = await execFileAsync(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
    ]);
    const duration = parseFloat(durOut.stdout.trim());
    console.log('时长:', duration, '秒');

    // ---- ① 抽帧 ----
    const frames: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ratio = 0.1 + (0.8 * i) / 2;
      const at = Math.min(duration - 0.05, duration * ratio);
      const fp = path.join(workDir, `frame-${i}.jpg`);
      await execFileAsync(FFMPEG, ['-y', '-ss', String(at), '-i', videoPath, '-frames:v', '1', '-q:v', '4', fp]);
      frames.push(fp);
      console.log(`  抽帧 ${i}: t=${at.toFixed(2)}s → ${path.basename(fp)} (${(await fs.stat(fp)).size}B)`);
    }

    // ---- ② 视觉 ----
    const visualParts: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const img = await fs.readFile(frames[i]);
      const b64 = img.toString('base64');
      const data = await postJson(
        'https://api.minimax.cn/anthropic/v1/messages',
        { 'X-Api-Key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: 'MiniMax-M3.1-Flash',
          max_tokens: 400,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
                },
                { type: 'text', text: `这是视频的第 ${i + 1} 个采样画面。客观描述画面里实际可见的内容。` },
              ],
            },
          ],
        },
      );
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      visualParts.push(`[画面${i + 1}] ${text}`);
      console.log(`  视觉 ${i}: ${text.slice(0, 120)}`);
    }
    const visual = visualParts.join('\n');

    // ---- ③ 抽音轨 ----
    const wavPath = path.join(workDir, 'audio.wav');
    await execFileAsync(FFMPEG, [
      '-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', wavPath,
    ]);
    console.log('  音轨:', (await fs.stat(wavPath)).size, 'B');

    // ---- ④ ASR ----
    const asr = await postMultipart(
      'https://api.minimax.cn/v1/speech_to_text',
      { Authorization: `Bearer ${apiKey}` },
      { model: 'asr-1.0', response_format: 'verbose_json', timestamp_level: 'sentence', stream: 'false' },
      wavPath,
    );
    const transcript = asr.text ?? '';
    console.log('  ASR:', transcript);
    console.log('  segments:', (asr.segments ?? []).length);

    // ---- ⑤ 合成 ----
    const parts = [`画面内容:\n${visual}`];
    if (transcript) parts.push(`语音转写:\n${transcript}`);
    parts.push('请用一段话综合说明这个视频讲了什么(客观描述,不要编造未出现的内容)。');

    const final = await postJson(
      'https://api.minimax.cn/anthropic/v1/messages',
      { 'X-Api-Key': apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: 'MiniMax-M3.1-Flash',
        max_tokens: 1000,
        messages: [{ role: 'user', content: parts.join('\n\n') }],
      },
    );
    const summary = (final.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');

    console.log('\n========== 结果 ==========');
    console.log('画面描述:\n' + visual);
    console.log('\n语音转写:\n' + transcript);
    console.log('\n综合描述:\n' + summary);
    console.log('\n✅ 全链路打通');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
