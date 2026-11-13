import { spawn } from 'node:child_process';
const CMD='D:/hermes-data/bin/hermes.cmd';
function run(args,label){return new Promise(r=>{
 const c=spawn('cmd.exe',['/c',CMD,...args],{windowsHide:true,cwd:'D:/hermes-data/hermes-agent'});
 let o='',e='';c.stdout.on('data',d=>o+=d);c.stderr.on('data',d=>e+=d);
 c.on('exit',code=>{console.log(`[${label}] exit=${code}`);console.log('OUT:',o.trim().slice(0,200)||'(空)');console.log('ERR:',e.trim().slice(0,200));r();});});}
const multi='请调用 hermes-douyin-pet 插件的 douyin_watch 工具,让桌宠自己刷抖音。\n参数:max_videos=1, seconds_per_video=4。\n调用成功后用一句话口语化总结,不要解释。';
await run(['-m','minimax-cn/MiniMax-M3.1-Flash','--provider','minimax-cn','-z',multi],'参数在前+多行');
