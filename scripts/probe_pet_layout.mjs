/**
 * 桌宠定位验收探针(2026-11-14)。
 *
 * 查三件事:
 *   ① 当前角色是哪个(id / name / 类型)—— 验证「换成 dsh-pet 默认角色」
 *   ② 右键菜单在不在桌宠旁边(而不是屏幕左边)
 *   ③ 气泡在不在桌宠头顶(而不是屏幕中间)
 *
 * 用法: node probe_pet_layout.mjs
 */
const CDP = 'http://127.0.0.1:9222';

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && (t.url.includes('index.html') || t.url.includes('5188')));
  if (!page) throw new Error('找不到桌宠页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id; pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.text;
    return r.result?.result?.value;
  };
  return { ev, close: () => ws.close() };
}

const HOST_EXPR = `(() => {
  const el = document.querySelector('.hatch-pet-host, .video-pet-host, .character-host');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    cls: el.className,
    id: el.dataset.petId || el.getAttribute('data-pet-id') || null,
    l: Math.round(r.left), t: Math.round(r.top),
    w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
  };
})()`;

async function main() {
  const { ev, close } = await connect();

  console.log('=== ① 当前角色 ===');
  console.log(await ev(`(() => {
    const el = document.querySelector('[data-pet-id]');
    const host = document.querySelector('.hatch-pet-host, .video-pet-host, .character-host');
    return JSON.stringify({
      petId: el ? el.getAttribute('data-pet-id') : null,
      hostClass: host ? host.className : null,
      hasVideo: !!document.querySelector('video'),
      canvases: Array.from(document.querySelectorAll('canvas')).map(c => c.width + 'x' + c.height),
    });
  })()`));

  console.log('\n=== ② 桌宠宿主位置 ===');
  const host = await ev(HOST_EXPR);
  console.log(host);
  const h = typeof host === 'string' ? JSON.parse(host) : host;

  console.log('\n=== ③ 触发右键菜单 ===');
  console.log(await ev(`(() => {
    const el = document.querySelector('.hatch-pet-host, .video-pet-host, .character-host');
    if (!el) return 'no host';
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    return 'dispatched at ' + Math.round(cx) + ',' + Math.round(cy);
  })()`));
  await new Promise((r) => setTimeout(r, 1200));

  console.log('\n=== ④ 菜单位置(判定:应贴着桌宠) ===');
  const menu = await ev(`(() => {
    const el = document.querySelector('.pet-menu');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             inline: el.getAttribute('style') };
  })()`);
  console.log(JSON.stringify(menu));
  if (menu && h) {
    const dx = Math.abs((menu.l + menu.w / 2) - h.cx);
    const dy = Math.abs((menu.t + menu.h / 2) - h.cy);
    console.log(`  菜单中心 (${menu.l + menu.w / 2},${menu.t + menu.h / 2}) vs 桌宠中心 (${h.cx},${h.cy}) → 距离 ${Math.round(Math.hypot(dx, dy))}px`);
    console.log(`  判定: ${Math.hypot(dx, dy) < 400 ? '✅ 贴着桌宠' : '❌ 离桌宠太远'}`);
  }

  console.log('\n=== ⑤ 气泡位置(判定:应在桌宠正上方) ===');
  console.log(await ev(`(() => {
    const el = document.querySelector('.pet-speech');
    if (!el) return '气泡元素不存在(没触发说话)';
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      cssLeft: cs.left, transform: cs.transform, text: el.textContent.slice(0, 40) });
  })()`));

  console.log('\n=== ⑥ 触发一句话气泡 ===');
  console.log(await ev(`(() => {
    // 通过主进程的 IPC 通道找不到,直接调 window.petAPI 看有没有触发碎碎念的方法
    return JSON.stringify(Object.keys(window.petAPI || {}));
  })()`));

  console.log('\n=== ⑦ 窗口尺寸 ===');
  console.log(await ev(`JSON.stringify({ innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
    screenW: screen.width, screenH: screen.height })`));

  close();
}

main();
