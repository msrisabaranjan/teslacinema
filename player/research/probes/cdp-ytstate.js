// inspect decode-output + clock state on the live yt-live page
const TARGET = process.argv[2] || 'A55F2103EE5E55499175681984268560';
const ws = new WebSocket(`ws://127.0.0.1:9333/devtools/page/${TARGET}`);
let id = 0; const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
ws.addEventListener('open', async () => {
  await send('Runtime.enable', {});
  const expr = `(async () => {
    const p = window.player;
    let decIn = 0, decOut = 0, decErr = null;
    const vd = p.videoDecoder;
    if (vd) {
      const od = vd.decode.bind(vd);
      vd.decode = c => { decIn++; try { od(c); } catch (e) { decErr = e.message; throw e; } };
    }
    const snap = () => ({
      q: p.videoQ.length,
      qHead: p.videoQ.length ? p.videoQ[0].pts / 1e6 : null,
      qTail: p.videoQ.length ? p.videoQ[p.videoQ.length - 1].pts / 1e6 : null,
      clock: p._clock(),
      ahead: p._ahead(),
      wall: p.wallAnchor && { t0: +p.wallAnchor.t0.toFixed(1), pts: p.wallAnchor.ptsUs / 1e6 },
      audioAnchor: !!p.audioAnchor,
      actx: p._actx && p._actx.state,
      audioActive: p.audioActive,
      lastVideoPts: p.lastVideoPts && p.lastVideoPts / 1e6,
      newestAudioPts: p.newestAudioPts && p.newestAudioPts / 1e6,
      raf: !!p._raf,
      vqIdent: p.videoQ === (p._probeQ || (p._probeQ = p.videoQ)),
    });
    const s1 = snap();
    await new Promise(r => setTimeout(r, 3000));
    const s2 = snap();
    return JSON.stringify({ decIn, decOut, decErr, vdec: vd && vd.state, queueSize: vd && vd.decodeQueueSize, s1, s2 }, null, 1);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(r.result.value || JSON.stringify(r));
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 30000);
