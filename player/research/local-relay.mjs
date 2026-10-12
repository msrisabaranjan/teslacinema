/* Local dev mirror of player/worker.js (Cloudflare Worker) — same routes,
 * run on http://127.0.0.1:8124 for end-to-end testing without deploying.  */
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const YT_IOS_KEY = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';
const YT_IOS_VER = '21.02.3';
const YT_IOS_UA = 'com.google.ios.youtube/' + YT_IOS_VER + ' (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}
function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function relay(res, target, self, raw) {
  if (!target) return json(res, 400, { error: 'missing url' });
  let u;
  try { u = new URL(target); } catch (_) { return json(res, 400, { error: 'bad url' }); }
  const headers = { 'User-Agent': UA_DESKTOP };
  if (u.hostname.endsWith('kick.com')) headers['Referer'] = 'https://kick.com/';
  const r = await fetch(target, { headers });
  if (r.status === 404) return json(res, 404, { error: 'not found (channel offline?)' });
  if (!r.ok) return json(res, 502, { error: 'upstream HTTP ' + r.status });
  const ct = r.headers.get('content-type') || '';
  const isText = ct.includes('mpegurl') || ct.startsWith('text/');
  cors(res);
  if (!isText) {
    res.writeHead(200, { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'no-store' });
    const buf = Buffer.from(await r.arrayBuffer());
    return res.end(buf);
  }
  const text = await r.text();
  if (text.indexOf('#EXTM3U') < 0) return json(res, 502, { error: 'not a playlist' });
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  if (raw) return res.end(text);
  const rewritten = text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    const attr = t.match(/URI="([^"]+)"/);
    if (attr) {
      const abs = new URL(attr[1], u.pathname).href;
      return t.replace(attr[0], 'URI="' + self + '/relay?url=' + encodeURIComponent(abs) + '"');
    }
    if (t.startsWith('#')) return line;
    const abs = new URL(t, u.pathname).href;
    return self + '/relay?url=' + encodeURIComponent(abs);
  }).join('\n');
  res.end(rewritten);
}

/* Kick blocks Node's TLS fingerprint (403) — shell out to curl.exe, which
 * passes. 2026 API: /playback-url → {data: m3u8}; legacy shape as fallback. */
function curlJson(url) {
  const raw = execFileSync('curl.exe', ['-s', '-A', UA_DESKTOP, '-H', 'Accept: application/json', url], { maxBuffer: 1 << 24 }).toString();
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function kick(res, login) {
  const enc = encodeURIComponent(login);
  let j = curlJson('https://kick.com/api/v2/channels/' + enc + '/playback-url');
  if (j && j.data) return json(res, 200, { login, live: true, playback_url: j.data });
  j = curlJson('https://kick.com/api/v2/channels/' + enc);
  if (!j || j.message !== undefined) return json(res, 502, { error: 'kick lookup blocked or channel offline' });
  json(res, 200, {
    login: j.slug || login,
    name: j.name,
    live: !!(j.livestream && j.livestream.playback_url),
    playback_url: j.livestream ? j.livestream.playback_url : null,
  });
}

/* YouTube live resolver — IOS 21.02.3 innertube client (see worker.js notes) */
async function youtube(res, videoId, height) {
  const body = {
    context: { client: { clientName: 'IOS', clientVersion: YT_IOS_VER, deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18_3_2', hl: 'en', gl: 'US' } },
    videoId, contentCheckOk: true, racyCheckOk: true,
  };
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + YT_IOS_KEY + '&prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.youtube.com',
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': YT_IOS_VER,
      'User-Agent': YT_IOS_UA,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return json(res, 502, { error: 'youtubei HTTP ' + r.status });
  const j = await r.json();
  const ps = j.playabilityStatus || {};
  if (ps.status !== 'OK') {
    return json(res, 422, { error: 'youtube: ' + (ps.reason || ps.status) });
  }
  const sd = j.streamingData || {};
  const isLive = !!(sd.serverAbrStreamingUrl || (ps.liveStreamability && ps.liveStreamability.isLive));
  const fmts = sd.adaptiveFormats || [];
  const vids = fmts.filter(f => f.url && f.mimeType && f.mimeType.indexOf('video/mp4') === 0 && f.mimeType.indexOf('avc1') >= 0);
  if (!vids.length) return json(res, 422, { error: 'youtube: no avc1 formats in response' });
  vids.sort((a, b) => (a.height - b.height) || (a.bitrate - b.bitrate));
  const cap = parseInt(height, 10) || 720;
  let pick = vids[0];
  for (const f of vids) if (f.height <= cap) pick = f;
  const auds = fmts.filter(f => f.url && f.mimeType && f.mimeType.indexOf('audio/mp4') === 0);
  const audio = auds.find(f => f.mimeType.indexOf('mp4a.40.2') >= 0) || auds[0] || null;
  if (!isLive) return json(res, 422, { error: 'youtube: only live streams are supported for now', title: (j.videoDetails && j.videoDetails.title) || '' });
  json(res, 200, {
    live: true,
    title: (j.videoDetails && j.videoDetails.title) || '',
    videoUrl: pick.url,
    audioUrl: audio ? audio.url : null,
    itag: pick.itag,
    height: pick.height,
    variantIdx: vids.indexOf(pick),
    formats: vids.map(f => ({ itag: f.itag, height: f.height, bandwidth: f.bitrate, fps: f.fps })),
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8124');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  try {
    if (u.pathname === '/relay') return await relay(res, u.searchParams.get('url'), u.origin, u.searchParams.get('raw') === '1');
    if (u.pathname.startsWith('/kick/')) return await kick(res, decodeURIComponent(u.pathname.slice(7)));
    if (u.pathname.startsWith('/yt/')) return await youtube(res, decodeURIComponent(u.pathname.slice(4)), u.searchParams.get('h'));
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});
server.listen(8124, '127.0.0.1', () => console.log('local relay on http://127.0.0.1:8124'));
