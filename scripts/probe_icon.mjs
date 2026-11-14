const CDP='http://127.0.0.1:9222';
const list=await(await fetch(`${CDP}/json/list`)).json();
const page=list.find(t=>t.type==='page'&&(t.url.includes('index.html')||t.url.includes('5188')));
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
await new Promise(r=>{ws.onopen=r;});
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  if(r.result?.exceptionDetails) return 'EXC:'+JSON.stringify(r.result.exceptionDetails).slice(0,200);
  return r.result?.result?.value;};

console.log('=== ① 所有元素(含 svg/img/canvas 之类的小图标) ===');
console.log(await ev(`(()=>{
  const out=[];
  document.querySelectorAll('body *').forEach(el=>{
    const cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden') return;
    const r=el.getBoundingClientRect();
    if(r.width<3||r.height<3) return;
    out.push({tag:el.tagName,cls:(el.className||'').toString().slice(0,44),
      z:cs.zIndex,l:Math.round(r.left),t:Math.round(r.top),
      w:Math.round(r.width),h:Math.round(r.height),vis:cs.visibility});
  });
  return JSON.stringify(out,null,1);
})()`));

console.log('\n=== ② 角色周围(角色矩形内)的所有元素 ===');
console.log(await ev(`(()=>{
  const host=document.querySelector('.video-pet-host');
  if(!host) return 'no host';
  const hr=host.getBoundingClientRect();
  const out=[];
  document.querySelectorAll('body *').forEach(el=>{
    if(el===host||host.contains(el)) return;
    const cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden') return;
    const r=el.getBoundingClientRect();
    if(r.width<2||r.height<2) return;
    // 是否与角色矩形相交
    const inter = r.left<hr.right && r.right>hr.left && r.top<hr.bottom && r.bottom>hr.top;
    if(!inter) return;
    out.push({tag:el.tagName,cls:(el.className||'').toString().slice(0,44),
      z:cs.zIndex,l:Math.round(r.left),t:Math.round(r.top),
      w:Math.round(r.width),h:Math.round(r.height)});
  });
  return JSON.stringify({host:{l:Math.round(hr.left),t:Math.round(hr.top),w:Math.round(hr.width),h:Math.round(hr.height)}, overlapping:out},null,1);
})()`));
ws.close();
