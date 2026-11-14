const CDP='http://127.0.0.1:9222';
const list=await(await fetch(`${CDP}/json/list`)).json();
const page=list.find(t=>t.type==='page'&&(t.url.includes('index.html')||t.url.includes('5188')));
if(!page){console.log('no page');process.exit(0);}
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
await new Promise(r=>{ws.onopen=r;});
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  if(r.result?.exceptionDetails) return 'EXC:'+JSON.stringify(r.result.exceptionDetails).slice(0,200);
  return r.result?.result?.value;};

const snap = `(()=>{const vs=Array.from(document.querySelectorAll('video'));
 return JSON.stringify(vs.map((v,i)=>({i,op:getComputedStyle(v).opacity,vis:getComputedStyle(v).visibility,
   paused:v.paused,t:+v.currentTime.toFixed(2),ready:v.readyState,
   src:(v.currentSrc||v.src||'').split('/').pop().slice(0,26)})));})()`;

console.log('=== 点击前 ===');
console.log(await ev(snap));

// 模拟真实点击(pointerdown/up + click),走桌宠自己的命中检测
console.log('\n=== 模拟点击角色 ===');
console.log(await ev(`(()=>{
  const h=document.querySelector('.video-pet-host');
  const r=h.getBoundingClientRect();
  const cx=r.left+r.width/2, cy=r.top+r.height/2;
  const opts={clientX:cx,clientY:cy,bubbles:true,cancelable:true,button:0,pointerId:1,isPrimary:true};
  const el=document.elementFromPoint(cx,cy);
  for(const t of ['pointerdown','mousedown','pointerup','mouseup','click']){
    (el||h).dispatchEvent(new MouseEvent(t,opts));
  }
  return 'clicked at '+Math.round(cx)+','+Math.round(cy)+' on '+(el?el.tagName:'none');
})()`));

for (const ms of [200, 500, 1000, 2000, 3500, 5000]) {
  await new Promise(r=>setTimeout(r, ms===200?200:ms- (ms===500?200:ms===1000?500:ms===2000?1000:ms===3500?2000:3500)));
  console.log(`\n=== ${ms}ms 后 ===`);
  console.log(await ev(snap));
}
ws.close();
