/* ════════════════════════════════════════════════════════════════════
 * TCinema stream resolver
 *
 * Turns user input (channel name, kick.com/xyz, youtube link, raw .m3u8)
 * into a master m3u8 URL + routing hints for the CanvasHlsPlayer.
 *
 *   Twitch  → gql PlaybackAccessToken (client-side) + usher.m3u8.
 *             usher.ttvnw.net sends NO CORS headers → master must go
 *             through the relay; media playlists + segments send
 *             ACAO: * and are fetched directly (same split as teslurk).
 *   Kick    → kick.com/api/v2 (direct if CORS allows, else via relay)
 *   YouTube → relay worker only (youtubei IOS client → direct live fMP4
 *             URLs; googlevideo URLs are IP-bound + CORS-less → the engine
 *             polls them through the relay, see engine.js loadYtLive)
 *
 * Set PROXY to your Cloudflare Worker (see worker.js) to enable Twitch
 * master fetch + Kick fallback + YouTube.
 * ════════════════════════════════════════════════════════════════════ */
'use strict';

const PROXY = (localStorage.getItem('tcinema:proxy') || '').replace(/\/+$/, '');

function relayUrl(u) { return PROXY + '/relay?raw=1&url=' + encodeURIComponent(u); }

const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

async function twitchGql(body) {
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function resolveTwitch(login) {
  // same persisted-style query teslurk.com ships (public web client-id)
  const j = await twitchGql({
    operationName: 'PlaybackAccessToken_Template',
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {\n' +
      '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }\n' +
      '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }\n' +
      '}',
    variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'embed' },
  });
  if (j.errors) throw new Error('Twitch playback service error');
  const pat = j.data && j.data.streamPlaybackAccessToken;
  if (!pat || !pat.value) throw new Error('Channel is offline or does not exist');
  const qs = new URLSearchParams({
    sig: pat.signature,
    token: pat.value,
    allow_source: 'true',
    allow_spectre: 'true',
    allow_audio_only: 'true',
    fast_bread: 'true',
    p: String(Math.floor(Math.random() * 999999)),
  });
  return 'https://usher.ttvnw.net/api/channel/hls/' + login + '.m3u8?' + qs;
}

async function resolveKick(login) {
  const enc = encodeURIComponent(login);
  let url = null;
  // 2026 API: /playback-url → {data: m3u8}. Direct from a non-kick origin is
  // usually CORS-blocked, so fall back to the relay worker.
  try {
    const r = await fetch('https://kick.com/api/v2/channels/' + enc + '/playback-url', { headers: { Accept: 'application/json' } });
    if (r.ok) { const j = await r.json(); if (j.data) url = j.data; }
  } catch (_) { /* CORS — fall through to relay */ }
  if (!url && PROXY) {
    const r = await fetch(PROXY + '/kick/' + enc);
    if (!r.ok) throw new Error('Kick lookup failed (HTTP ' + r.status + ')');
    const j = await r.json();
    if (j.playback_url) url = j.playback_url;
    else if (j.live === false) throw new Error('@' + login + ' is offline on Kick');
  }
  if (!url) throw new Error('Kick needs the relay worker — set it in Settings');
  return url;
}

async function resolveYoutube(videoId, height) {
  if (!PROXY) throw new Error('YouTube playback needs the relay worker — set it in Settings');
  const r = await fetch(PROXY + '/yt/' + encodeURIComponent(videoId) + (height ? '?h=' + height : ''));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.videoUrl) throw new Error(j.error || ('YouTube lookup failed (HTTP ' + r.status + ')'));
  // googlevideo URLs are IP-bound + CORS-less → engine polls them via relay
  return {
    mode: 'yt-live',
    key: videoId,
    videoUrl: j.videoUrl,
    audioUrl: j.audioUrl || null,
    title: j.title || '',
    variantIdx: j.variantIdx,
    formats: j.formats || [],
  };
}

/* Parse free-form input → {platform, key} */
function parseInput(raw) {
  raw = raw.trim();
  let m;
  if ((m = raw.match(/^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=([\w-]{11})/i))) return { platform: 'youtube', key: m[3] };
  if ((m = raw.match(/^(https?:\/\/)?(www\.|m\.)?youtu\.be\/([\w-]{11})/i))) return { platform: 'youtube', key: m[2] };
  if ((m = raw.match(/^(https?:\/\/)?(www\.)?youtube\.com\/live\/([\w-]{11})/i))) return { platform: 'youtube', key: m[2] };
  if ((m = raw.match(/^(https?:\/\/)?(www\.)?twitch\.tv\/([a-z0-9_]{2,25})/i))) return { platform: 'twitch', key: m[3].toLowerCase() };
  if ((m = raw.match(/^(https?:\/\/)?(www\.)?kick\.com\/([a-z0-9_]{2,30})/i))) return { platform: 'kick', key: m[3].toLowerCase() };
  if (/\.m3u8(\?.*)?$/i.test(raw)) return { platform: 'hls', key: raw };
  if (/^[\w-]{11}$/.test(raw)) return { platform: 'youtube', key: raw };
  if (/^[a-z0-9_]{2,30}$/i.test(raw)) return { platform: 'twitch', key: raw.toLowerCase() };
  return null;
}

/* Routing hints consumed by index.html:
 *   masterViaRelay → only the master m3u8 goes through the relay
 *   relayAll       → every playlist + segment goes through the relay  */
async function resolve(input) {
  const p = parseInput(input);
  if (!p) throw new Error('Could not understand that — try a channel name, twitch.link, kick.link, youtube link, or .m3u8 URL');
  switch (p.platform) {
    case 'twitch':  return { platform: p.platform, url: await resolveTwitch(p.key), masterViaRelay: true };
    case 'kick':    return { platform: p.platform, url: await resolveKick(p.key), masterViaRelay: true };
    case 'youtube': return Object.assign({ platform: p.platform, relayAll: true }, await resolveYoutube(p.key));
    default:        return { platform: p.platform, url: p.key };
  }
}
