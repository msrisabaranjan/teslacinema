// fault-inject: make _buf throw HTTP 403 once mid-stream; verify yt-expired → refetchYt recovery
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
  await new Promise(r => setTimeout(r, 6000));
  const r0 = await send('Runtime.evaluate', { expression: `(async () => {
    const p = window.player;
    const L = window.__fi = [];
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0) + 'ms';
    const os = p.status.bind(p);
    p.status = m => { L.push(at() + ' STATUS: ' + m); os(m); };
    let fired = 0;
    const ob = p._buf.bind(p);
    p._buf = async u => {
      if (fired === 0 && /range=0-/.test(u)) { fired = 1; throw new Error('HTTP 403'); }   // simulate expired URL
      return ob(u);
    };
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3000));
      L.push(at() + ' STATE q=' + p.videoQ.length + ' ahead=' + p._ahead().toFixed(1) +
        ' running=' + p.running + ' ab=' + p._ytAbort + ' gen=' + p._ytGen);
    }
    return 'armed';
  })()`, returnByValue: true, awaitPromise: true });
  console.log('inject:', r0.result.value);
  await new Promise(r => setTimeout(r, 9000));
  const r1 = await send('Runtime.evaluate', { expression: `(window.__fi||[]).join('\\n')`, returnByValue: true });
  console.log(r1.result.value);
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
