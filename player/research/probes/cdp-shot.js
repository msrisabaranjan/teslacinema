// capture a PNG screenshot of the player tab
const TARGET = process.argv[2] || 'A55F2103EE5E55499175681984268560';
const OUT = process.argv[3] || 'C:/Users/ds/AppData/Local/Temp/opencode/player-shot.png';
const fs = require('fs');
const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${TARGET}`);
let id = 0; const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
ws.addEventListener('open', async () => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'));
  console.log('wrote ' + OUT);
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
