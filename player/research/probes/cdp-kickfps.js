// count decoded frames + decoder generations over a window, on a fresh reload
const TARGET = process.argv[2] || 'A55F2103EE5E55499175681984268560';
const URL_ = process.argv[3] || 'http://127.0.0.1:8123/player/index.html?ch=kick.com/nicklee';
const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${TARGET}`);
let id = 0; const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
ws.addEventListener('open', async () => {
  await send('Page.enable', {});
  await send('Page.navigate', { url: URL_ });
  await new Promise(r => setTimeout(r, 1200));
  await send('Runtime.evaluate', { expression: `localStorage.setItem('tcinema:proxy','http://127.0.0.1:8124')` });
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 6000));
  const expr = `(async () => {
    const p = window.player;
    const log = [];
    let gens = 0, errs = 0;
    const os = p.status.bind(p);
    p.status = m => { log.push(Math.round(performance.now()) + ' status: ' + m); os(m); };
    const oe = p._ensureVideoDecoder.bind(p);
    p._ensureVideoDecoder = () => {
      const before = p.videoDecoder;
      oe();
      if (!before && p.videoDecoder) {
        gens++;
        log.push(Math.round(performance.now()) + ' cfg gen' + gens);
        const dec = p.videoDecoder;
        const orig = dec.onerror;
        dec.onerror = e => { errs++; log.push(Math.round(performance.now()) + ' ERR gen' + gens + ': ' + e.message); if (orig) orig.call(dec, e); };
      }
    };
    const q = p.videoQ; const op = q.push.bind(q);
    let frames = 0;
    q.push = f => { frames++; return op(f); };
    const t0 = performance.now();
    let lastState = p.videoDecoder && p.videoDecoder.state;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      const st = p.videoDecoder && p.videoDecoder.state;
      if (st !== lastState) { log.push(Math.round(performance.now()) + ' state ' + lastState + ' -> ' + st + ' (nk=' + p._videoNeedKey + ')'); lastState = st; }
    }
    const dt = (performance.now() - t0) / 1000;
    return JSON.stringify({
      frames, fps: +(frames / dt).toFixed(1), gens, errs,
      vdec: p.videoDecoder && p.videoDecoder.state, needKey: p._videoNeedKey,
      status: document.getElementById('status').textContent.slice(0, 60),
      log,
    }, null, 1);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(r.result.value || JSON.stringify(r));
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 40000);
