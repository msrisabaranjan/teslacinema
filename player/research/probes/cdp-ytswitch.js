// verify yt-live quality switching: list variants, switch down, confirm re-resolve + smaller segments
const TARGET = process.argv[2] || 'A55F2103EE5E55499175681984268560';
const URL_ = process.argv[3] || 'http://127.0.0.1:8123/player/index.html?ch=1-LpQekNa9g';
const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${TARGET}`);
let id = 0; const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
ws.addEventListener('open', async () => {
  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await send('Page.navigate', { url: URL_ });
  await new Promise(r => setTimeout(r, 1200));
  await send('Runtime.evaluate', { expression: `localStorage.setItem('tcinema:proxy','http://127.0.0.1:8124')` });
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 7000));
  const r0 = await send('Runtime.evaluate', { expression: `(async () => {
    const p = window.player;
    const L = window.__sw = [];
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0) + 'ms';
    const os = p.status.bind(p);
    p.status = m => { L.push(at() + ' STATUS: ' + m); os(m); };
    const ob = p._buf.bind(p);
    p._buf = async u => {
      const b = await ob(u);
      if (/range=0-/.test(u)) L.push(at() + ' SEG ' + (u.indexOf('range') < u.length - 20 ? '' : '') + b.length + 'B');
      return b;
    };
    return JSON.stringify({ qualities: p.qualityList(), idx: p.variantIdx });
  })()`, returnByValue: true, awaitPromise: true });
  console.log('before:', r0.result.value);
  const q = JSON.parse(r0.result.value);
  const want = process.argv[4] || '480p';
  const target = q.qualities.find(x => x.label === want) || q.qualities[Math.max(0, q.idx - 1)];
  await send('Runtime.evaluate', { expression: `window.player.setQuality(${target.idx}); 'set ' + ${target.idx}` });
  console.log('setQuality ->', target.label);
  await new Promise(r => setTimeout(r, 12000));
  const r1 = await send('Runtime.evaluate', { expression: `JSON.stringify({ idx: window.player.variantIdx, status: document.getElementById('status') ? document.getElementById('status').textContent : null, log: window.__sw })`, returnByValue: true });
  console.log('after:', r1.result.value);
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
