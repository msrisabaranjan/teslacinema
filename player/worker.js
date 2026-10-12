/** ════════════════════════════════════════════════════════════════════
 * TCinema relay — Cloudflare Worker (optional; Twitch works without it)
 *
 * Routes:
 *   GET /relay?url=<encoded m3u8|segment>   fetch upstream, rewrite m3u8
 *                                           URIs to stay inside /relay,
 *                                           stream segments through, CORS:*
 *   GET /kick/<login>                       kick.com/api/v2/channels/<login>
 *   GET /yt/<videoId>[&h=720]               youtubei/v1/player (IOS client) →
 *                                           {live, videoUrl, audioUrl, formats}
 *
 * Deploy: dash.cloudflare.com → Workers → Create → paste this file → Deploy.
 * Then put the https://…workers.dev URL into the player's Settings field.
 *
 * ⚠ YouTube caveats (2026):
 *   - WEB/TV clients are bot-checked from datacenter IPs; the IOS 21.02.3
 *     client still answers with direct (signed, no cipher) live URLs.
 *   - googlevideo URLs are IP-bound (ip= is part of the signature), so the
 *     SAME worker that resolved must also proxy every segment fetch
 *     (Cloudflare egress IP is stable per-PoP; usually holds).
 *   - If /yt returns "Sign in to confirm you're not a bot", the worker's
 *     egress IP got flagged — redeploy from another region or run the
 *     relay somewhere residential (this is what teslaplay pays for).
 * ════════════════════════════════════════════════════════════════════ */
'use strict';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
// IOS innertube key + client — the only 2026 client that still returns
// direct-URL live formats without a PoToken/login from datacenter IPs.
const YT_IOS_KEY = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';
const YT_IOS_VER = '21.02.3';
const YT_IOS_UA = 'com.google.ios.youtube/' + YT_IOS_VER + ' (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    try {
      if (u.pathname === '/relay') return await relay(u.searchParams.get('url'), u.origin, u.searchParams.get('raw') === '1');
      if (u.pathname.startsWith('/kick/')) return await kick(u.pathname.slice(7));
      if (u.pathname.startsWith('/yt/')) return await youtube(u.pathname.slice(4), u.searchParams.get('h'));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}

/* ── generic HLS relay + manifest rewriter ──
 * raw=1 → return the playlist untouched (the TCinema player rewrites
 * URLs itself; avoids double-wrapping). Default rewrites every URI to
 * stay inside /relay so plain <video>/hls.js clients work too.        */
async function relay(target, self, raw) {
  if (!target) return json({ error: 'missing url' }, 400);
  let u;
  try { u = new URL(target); } catch (_) { return json({ error: 'bad url' }, 400); }
  const headers = { 'User-Agent': UA_DESKTOP };
  if (u.hostname.endsWith('kick.com')) headers['Referer'] = 'https://kick.com/';
  const r = await fetch(target, { headers, cf: { cacheTtl: 0 } });
  if (r.status === 404) return json({ error: 'not found (channel offline?)' }, 404);
  if (!r.ok) return json({ error: 'upstream HTTP ' + r.status }, 502);
  const ct = r.headers.get('content-type') || '';
  const isText = ct.includes('mpegurl') || ct.startsWith('text/');
  if (!isText) {
    // segment bytes: pass through
    return new Response(r.body, {
      headers: Object.assign({ 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'no-store' }, CORS),
    });
  }
  const text = await r.text();
  if (text.indexOf('#EXTM3U') < 0) return json({ error: 'not a playlist' }, 502);
  if (raw) {
    return new Response(text, {
      headers: Object.assign({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }, CORS),
    });
  }
  const rewritten = text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    // rewrite URI="..." attributes (#EXT-X-MAP, #EXT-X-KEY, …)
    const attr = t.match(/URI="([^"]+)"/);
    if (attr) {
      const abs = new URL(attr[1], u.pathname).href;
      return t.replace(attr[0], 'URI="' + self + '/relay?url=' + encodeURIComponent(abs) + '"');
    }
    if (t.startsWith('#')) return line;
    const abs = new URL(t, u.pathname).href;
    return self + '/relay?url=' + encodeURIComponent(abs);
  }).join('\n');
  return new Response(rewritten, {
    headers: Object.assign({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }, CORS),
  });
}

/* ── Kick channel lookup ──
 * 2026 API: GET /api/v2/channels/<login>/playback-url → {data: m3u8}.
 * Older shape (livestream.playback_url on the channel doc) kept as fallback. */
async function kick(login) {
  const enc = encodeURIComponent(login);
  const headers = { 'User-Agent': UA_DESKTOP, Accept: 'application/json' };
  try {
    const r1 = await fetch('https://kick.com/api/v2/channels/' + enc + '/playback-url', { headers });
    if (r1.ok) {
      const j1 = await r1.json().catch(() => ({}));
      if (j1.data) return json({ login, live: true, playback_url: j1.data });
    }
  } catch (_) { /* fall through to legacy shape */ }
  const r = await fetch('https://kick.com/api/v2/channels/' + enc, { headers });
  if (!r.ok) return json({ error: 'kick HTTP ' + r.status }, 502);
  const j = await r.json();
  return json({
    login: j.slug || login,
    name: j.name,
    live: !!(j.livestream && j.livestream.playback_url),
    playback_url: j.livestream ? j.livestream.playback_url : null,
  });
}

/* ── YouTube live resolver (IOS 21.02.3 innertube client) ──
 * 2026: no client returns hlsManifestUrl anymore (HLS is login-gated and
 * SABR/protobuf is the new default). IOS 21.02.3 still returns 14
 * adaptiveFormats with DIRECT signed URLs (no signatureCipher) plus a
 * serverAbrStreamingUrl. Live format URLs are byte-range addressable:
 *   GET url&range=0-  →  ftyp+moov + emsg + ONE moof+mdat at the live head
 * re-poll until x-head-time-sec advances. URLs are IP-bound (ip= signed),
 * so /relay must proxy every fetch from this same worker. */
async function youtube(videoId, height) {
  const body = {
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: YT_IOS_VER,
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18_3_2',
        hl: 'en',
        gl: 'US',
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
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
  if (!r.ok) return json({ error: 'youtubei HTTP ' + r.status }, 502);
  const j = await r.json();
  const ps = j.playabilityStatus || {};
  if (ps.status !== 'OK') {
    return json({ error: 'youtube: ' + (ps.reason || ps.status) }, 422);
  }
  const sd = j.streamingData || {};
  const isLive = !!(sd.serverAbrStreamingUrl || (ps.liveStreamability && ps.liveStreamability.isLive));
  const fmts = sd.adaptiveFormats || [];
  // H.264 only — our WebCodecs pipeline decodes avc1 (VP9/AV1 webm ignored)
  const vids = fmts.filter(f => f.url && f.mimeType && f.mimeType.indexOf('video/mp4') === 0 && f.mimeType.indexOf('avc1') >= 0);
  if (!vids.length) return json({ error: 'youtube: no avc1 formats in response' }, 422);
  vids.sort((a, b) => (a.height - b.height) || (a.bitrate - b.bitrate));
  // pick best ≤ requested height (default 720p — Tesla-browser friendly), else lowest
  const cap = parseInt(height, 10) || 720;
  let pick = vids[0];
  for (const f of vids) if (f.height <= cap) pick = f;
  const auds = fmts.filter(f => f.url && f.mimeType && f.mimeType.indexOf('audio/mp4') === 0);
  const audio = auds.find(f => f.mimeType.indexOf('mp4a.40.2') >= 0) || auds[0] || null;
  if (!isLive) return json({ error: 'youtube: only live streams are supported for now', title: (j.videoDetails && j.videoDetails.title) || '' }, 422);
  return json({
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
