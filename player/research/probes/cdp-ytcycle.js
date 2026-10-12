// observe the yt-live loop: status changes, _buf failures, poll state over time
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
  await new Promise(r => setTimeout(r, 8000));
  // install hooks mid-stream; they survive until next reload
  const hook = `(async () => {
    const p = window.player;
    const L = window.__cyc = [];
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0) + 'ms';
    const os = p.status.bind(p);
    p.status = m => { L.push(at() + ' STATUS: ' + m); os(m); };
    const ob = p._buf.bind(p);
    p._buf = async u => {
      try { const b = await ob(u); return b; }
      catch (e) { L.push(at() + ' BUF-FAIL ' + e.message + ' ' + u.slice(-60)); throw e; }
    };
    const op = p._ytPoll.bind(p);
    p._ytPoll = async (url, dm, isV) => {
      L.push(at() + ' POLL-START ' + (isV ? 'V' : 'A'));
      try { await op(url, dm, isV); L.push(at() + ' POLL-END ' + (isV ? 'V' : 'A')); }
      catch (e) { L.push(at() + ' POLL-THROW ' + (isV ? 'V' : 'A') + ': ' + e.message); throw e; }
    };
    const oreset = p._resetTrackState.bind(p);
    p._resetTrackState = () => { L.push(at() + ' RESET'); oreset(); };
    // periodic state
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      L.push(at() + ' STATE q=' + p.videoQ.length + ' lastV=' + (p.lastVideoPts != null ? (p.lastVideoPts / 1e6).toFixed(1) : null) +
        ' clock=' + p._clock().toFixed(1) + ' ahead=' + p._ahead().toFixed(1) +
        ' vq=' + (p.videoQ === p.__q0 ? 0 : (p.__q0 = p.videoQ, 1)) +
        ' vdec=' + (p.videoDecoder && p.videoDecoder.state) + ' qs=' + (p.videoDecoder && p.videoDecoder.decodeQueueSize) +
        ' running=' + p.running + ' sw=' + p._switchVariant + ' ab=' + p._ytAbort);
    }
    return 'hooked';
  })()`;
  const r0 = await send('Runtime.evaluate', { expression: hook, returnByValue: true, awaitPromise: true });
  console.log('hook:', r0.result.value);
  await new Promise(r => setTimeout(r, 4000));
  const r1 = await send('Runtime.evaluate', { expression: `(window.__cyc||[]).join('\\n')`, returnByValue: true });
  console.log(r1.result.value);
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
