import fs from 'node:fs';
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

// 把当前 video 帧画到 canvas,读 alpha 边界像素 —— 这才是真实的 alpha 质量
console.log(await ev(`(()=>{
  const v=Array.from(document.querySelectorAll('video')).find(x=>!x.paused);
  if(!v) return 'no playing video';
  const c=document.createElement('canvas'); c.width=v.videoWidth; c.height=v.videoHeight;
  const ctx=c.getContext('2d');
  ctx.drawImage(v,0,0);
  const d=ctx.getImageData(0,0,c.width,c.height).data;
  // 统计半透明像素(0<alpha<255)的数量和它们在哪
  let semi=0, opaque=0, clear=0; const xs=[],ys=[];
  for(let i=0;i<d.length;i+=4){
    const a=d[i+3];
    if(a===0) clear++; else if(a===255) opaque++; else { semi++; if(xs.length<8){const p=i/4;xs.push(p%c.width);ys.push(Math.floor(p/c.width));} }
  }
  // 采样几个半透明像素的 RGB
  const samples=[];
  for(let i=0;i<d.length;i+=4){
    const a=d[i+3];
    if(a>0&&a<255){ samples.push([d[i],d[i+1],d[i+2],a]); if(samples.length>=6) break; }
  }
  return JSON.stringify({total:d.length/4, clear, opaque, semi,
    semiPct:+(semi/(d.length/4)*100).toFixed(2),
    semiSamples:samples, sampleCoords:xs.slice(0,6).map((x,i)=>[x,ys[i]])});
})()`));
ws.close();
