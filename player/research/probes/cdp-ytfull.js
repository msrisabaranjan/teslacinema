// full-lifecycle yt-live trace: patch prototype before player exists, then reload
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__ytlog = [];
    const t0 = Date.now();
    const L = m => window.__ytlog.push((Date.now() - t0) + 'ms ' + m);
    const iv = setInterval(() => {
      if (typeof CanvasHlsPlayer === 'undefined') return;
      clearInterval(iv);
      const P = CanvasHlsPlayer.prototype;
      const ob = P._buf;
      P._buf = async function (u) {
        try { const b = await ob.call(this, u); L('_buf ok ' + b.length + ' ' + u.slice(-40)); return b; }
        catch (e) { L('_buf ERR ' + e.message + ' ' + u.slice(-40)); throw e; }
      };
      const oc = P._configVideo;
      P._configVideo = function (cfg) { L('configVideo ' + cfg.codec); return oc.call(this, cfg); };
      const oa = P._configAudio;
      P._configAudio = function (cfg) { L('configAudio ' + cfg.codec); return oa.call(this, cfg); };
      const ov = P._onVideoSample;
      let n = 0;
      P._onVideoSample = function (d, us, key) { if (++n <= 3 || n % 150 === 0) L('videoSample#' + n + ' pts=' + us + ' key=' + key); return ov.call(this, d, us, key); };
      const oy = P._ytPoll;
      P._ytPoll = function (url, dm, isV) { L('_ytPoll start ' + (isV ? 'V' : 'A') + ' url tail ' + url.slice(-30)); return oy.call(this, url, dm, isV); };
      const ol = P.loadYtLive;
      P.loadYtLive = function (src) { L('loadYtLive vTail ' + (src.videoUrl || '').slice(-30) + ' aTail ' + (src.audioUrl || '').slice(-30)); return ol.call(this, src); };
      L('patched');
    }, 5);
  ` });
  await send('Page.navigate', { url: URL_ });
  await new Promise(r => setTimeout(r, 1200));
  await send('Runtime.evaluate', { expression: `localStorage.setItem('tcinema:proxy','http://127.0.0.1:8124')` });
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 15000));
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ log: (window.__ytlog||[]).slice(0,60), status: document.getElementById('status').textContent, vdec: window.player && window.player.videoDecoder && window.player.videoDecoder.state }, null, 1)`,
    returnByValue: true,
  });
  console.log(r.result.value || JSON.stringify(r));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: (await send('Page.addScriptToEvaluateOnNewDocument', { source: '' })).identifier }).catch(() => {});
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1), 60000; }, 60000);
