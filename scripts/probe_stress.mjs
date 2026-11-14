const CDP='http://127.0.0.1:9222';
const list=await(await fetch(`${CDP}/json/list`)).json();
const page=list.find(t=>t.type==='page'&&(t.url.includes('index.html')||t.url.includes('5188')));
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
await new Promise(r=>{ws.onopen=r;});
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  if(r.result?.exceptionDetails) return 'EXC'; return r.result?.result?.value;};

const check = `(()=>{const vs=Array.from(document.querySelectorAll('video'));
  const vis=vs.filter(v=>getComputedStyle(v).visibility!=='hidden' && v.style.opacity!=='0');
  const front=vs.find(v=>!v.paused);
  return JSON.stringify({n:vs.length,visible:vis.length,visOK:vis.length===1,
    playing:!!front, t:front?+front.currentTime.toFixed(2):null,
    src:front?(front.currentSrc||'').split('/').pop().slice(-18):null});})()`;

console.log('=== 连点 8 次,每次间隔 400ms ===');
for(let i=0;i<8;i++){
  await ev(`(()=>{const h=document.querySelector('.video-pet-host');
    const r=h.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;
    const el=document.elementFromPoint(cx,cy)||h;
    for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
      el.dispatchEvent(new MouseEvent(t,{clientX:cx,clientY:cy,bubbles:true,cancelable:true,button:0}));
    return 1;})()`);
  await new Promise(r=>setTimeout(r,400));
  const s = await ev(check);
  console.log(`  click ${i+1}: ${s}`);
}

console.log('\n=== 等 30 秒(自然动画切换若干轮) ===');
for(let i=0;i<6;i++){
  await new Promise(r=>setTimeout(r,5000));
  console.log(`  +${(i+1)*5}s: ${await ev(check)}`);
}
ws.close();
