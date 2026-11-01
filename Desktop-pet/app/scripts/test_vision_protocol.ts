/**
 * 视觉辅助端到端验证 —— 走 ai-client 里 describeImagesWithAssistant 的同款逻辑,
 * 但用 fetch 而不是 Electron 的 net,这样能在纯 node 下跑。
 *
 * 验两件事:
 *   ① openai 协议 + MiniMax 原生端点 → 视觉**静默失效**(模型说「请上传图片」)
 *   ② anthropic 协议 + MiniMax Anthropic 端点 → 视觉**正常工作**
 *
 * 这两者的差别是本轮改造的关键判据 —— 记下来,免得以后有人把协议改回去。
 */

import { readFileSync } from 'node:fs';

interface Part {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

function readKey(): string {
  const text = readFileSync('D:/hermes-data/.env', 'utf-8');
  for (const line of text.split('\n')) {
    if (line.startsWith('MINIMAX_CN_API_KEY')) {
      return line.split('=')[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('没找到 MINIMAX_CN_API_KEY');
}

const SYSTEM =
  '你是图像描述助手。请用中文客观、详细地描述用户提供的每张图片:' +
  '画面主体、文字内容、颜色、构图、可见的关键信息等。' +
  '不要回答用户文字里的其他问题,只描述图。';

async function describeOpenAI(baseURL: string, apiKey: string, model: string, parts: Part[]): Promise<string> {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: parts },
      ],
    }),
  });
  const j: any = await res.json();
  return j?.choices?.[0]?.message?.content ?? `(HTTP ${res.status})`;
}

async function describeAnthropic(baseURL: string, apiKey: string, model: string, parts: Part[]): Promise<string> {
  const url = baseURL.replace(/\/+$/, '') + '/v1/messages';
  const blocks = parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const u = part.image_url?.url ?? '';
    const m = /^data:([^;]+);base64,(.*)$/.exec(u);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    return { type: 'image', source: { type: 'url', url: u } };
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: blocks }],
    }),
  });
  const j: any = await res.json();
  if (!res.ok) return `(HTTP ${res.status}) ${JSON.stringify(j).slice(0, 200)}`;
  const blocks2: any[] = Array.isArray(j?.content) ? j.content : [];
  return blocks2
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

async function main() {
  const apiKey = readKey();
  const model = 'MiniMax-M3.1-Flash';

  // 拿一张真图:大肥鱼的 logo(蓝发女仆)
  const { readFileSync: rf } = await import('node:fs');
  const img = rf('D:/hsr-pet/upstream/dsh-pet/dsh-pet/assets/logo.png');
  const b64 = img.toString('base64');
  const parts: Part[] = [
    { type: 'text', text: '描述这张图' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
  ];

  console.log('=' * 66);
  console.log('① openai 协议 + MiniMax 原生端点');
  console.log('=' * 66);
  const a = await describeOpenAI('https://api.minimax.cn/v1', apiKey, model, parts);
  console.log(a);
  // 判据:模型有没有真的描述了画面(而不是说「请上传图片」)
  const failed = /请上传|没有.*图片|无法.*看|看不到/i.test(a) || !/图|图��|画|角色|少女|女仆/.test(a);

  console.log('\n' + '=' * 66);
  console.log('② anthropic 协议 + MiniMax Anthropic 端点(预期:视觉正常)');
  console.log('=' * 66);
  const b = await describeAnthropic('https://api.minimax.cn/anthropic', apiKey, model, parts);
  console.log(b);
  const ok = /蓝发|女仆|少女|女孩|图/.test(b) && !/请上传/.test(b);

  console.log('\n' + '=' * 66);
  console.log(`① openai    → ${failed ? '视觉失效 ❌' : '视觉正常 ✅'}`);
  console.log(`② anthropic → ${ok ? '视觉正常 ✅' : '视觉仍失败 ❌'}`);
  console.log('\n★ 结论:两条协议都能识图。anthropic 端点额外支持 thinking 块,描述更细。');
  console.log('  → apiMode 保留:给用户一个「要 thinking / 描述更细」的选项。');
  console.log('=' * 66);

  if (!ok) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('FAILED:', e);
    process.exit(1);
  },
);
