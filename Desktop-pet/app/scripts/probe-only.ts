import { probeBackends } from '../electron/agent-bridge';

console.log('=== 探测 ===');
for (const i of probeBackends()) {
  console.log(`${i.available ? 'OK ' : 'NO '} ${i.id.padEnd(13)} | ${i.reason}`);
}
