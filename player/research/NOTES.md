# REA Research Notes — teslaplay.net / teslurk.com teardown & stream protocols

Captured 2026-10-12. This folder preserves the reverse-engineering evidence
and probe scripts behind `player/`. The temp working copies are gone; these
are the canonical ones. `probes/` scripts assume a local relay on
`127.0.0.1:8124` (run `node local-relay.mjs`) and a CDP Chrome on
`127.0.0.1:9333` (see "Dev workflow" below).

## 1. teslaplay.net (reference impl #1)

- `/js/youtube-worker.js?v=36`: server fetches YouTube → returns **MPEG-TS** →
  client TS-demux → H.264 `VideoDecoder` → OffscreenCanvas/WebGL. Audio:
  ADTS-AAC `AudioDecoder` + AudioBufferSourceNode PLL. **No `<video>`, no MSE.**
- Server-side innertube (config never reaches the client, not extractable).
- Tesla gating: module 77884 checks UA `/Tesla|QtCarBrowser/i` or `?tesla=1`.
- Error codes seen: 459/458/884/409/401/403/502/504/503.

## 2. teslurk.com (reference impl #2)

- Next.js 15.5.25. Tesla **device-flow auth**: `/api/auth/device/start|token`,
  `/api/config` → clientId `3miphya6zbomnxmgus5r8fzwnyc865`.
- Helix proxied: `GET /api/helix?path=<enc>`. Media path is **100% client-side**:
  gql → usher m3u8 (their `/api/proxy` only for playlists, segments direct).
- Renderer modes: `canvas-hls` vs `native-hls-mobile`.
- Chunk `783.991bbb5db6356f70.js` = MIT **WebAV**; chunk
  `591.ea8a0b0a762b2341.js` = HLS engine glue (`variantUrl`, `initSegmentUrl`,
  `containerFormat` ts|mp4, `fetchNewSegments()` cache-buster `_<Date.now()>`,
  `advanceToLiveEdge()`, EXT-X-MAP).

## 3. Twitch (verified live)

- gql POST `https://gql.twitch.tv/gql` with public Client-ID
  `kimne78kx3ncx6brgo4mv6wki5h1ko`, works cross-origin from any browser.
  Query must be `operationName:"PlaybackAccessToken_Template"` with **both**
  `streamPlaybackAccessToken` and `videoPlaybackAccessToken` branches;
  variables `{isLive:true, login, isVod:false, vodID:'', playerType:'embed'}`.
  (Old `user(login){stream{playbackAccessToken}}` shape now fails.)
- Usher: `https://usher.ttvnw.net/api/channel/hls/<login>.m3u8` with
  `URLSearchParams({sig, token:pat.value, allow_source:'true',
  allow_spectre:'true', allow_audio_only:'true', fast_bread:'true', p:rand})`
  — `token` is the raw `value` string.
- **CORS/routing (live evidence)**: usher + `*.playlist.ttvnw.net` return 403
  whenever a browser `Origin` header is present → ALL m3u8 fetches (master and
  media reloads) go through the relay. Segments (`*.cloudfront.hls.ttvnw.net`)
  send `ACAO: *`, not Origin-checked → fetched direct. usher rejects HEAD (404).
- Playlist: 14×2s segments, mediaSequence advances ~1 per 2.1s.
- Twitch TS quirk: afc bits lie — afc=01 packets carry payload (incl. pointer)
  at byte 4; afc=03 normal.

## 4. Kick (verified live)

- `GET https://kick.com/api/v2/channels/<slug>/playback-url` → `{"data":"<m3u8>"}`
  (legacy fallback: `livestream.playback_url`). Node fetch gets Cloudflare-TLS
  fingerprinted → 403; `curl.exe` with browser UA passes (local-relay shells out).
- Playback host = AWS IVS `*.us-west-2.playback.live-video.net`; ES384 JWT with
  `aws:access-control-allow-origin`. Master m3u8 has no ACAO → via relay;
  media playlists + `*.cloudfront.hls.live-video.net` segments direct.
- Token short-lived (~1h) and IP-stamped.
- Kick TS = plain MPEG-TS, pmtPid 4096, streams 256:audio / 257:video, with the
  **IVS/weaver PES quirk**: a new PES header is muxed mid-packet with the
  previous PES's continuation bytes following it. Handled in `TSDemuxer`
  (`_pesHeader`/`_beginPes`/`_isSc`/`_findSc`); continuation split gated to
  video PES only (applying to audio caused "Audio decoder error" on Twitch).
- Segments 2s/60fps/120 AUs, each starts with fresh IDR (NALs 9,7,8,6,5);
  all video PES have `payload_length=0`. PTS sawtooth (−165ms jumps) harmless.

## 5. YouTube (2026 state — the hard one)

**Client matrix** (innertube `/player`, live video):

| client | result |
|---|---|
| WEB (any) | UNPLAYABLE bot-check |
| ANDROID 19.x | HTTP 400 FAILED_PRECONDITION |
| ANDROID 21.02.35 / ANDROID_VR 1.71.26 / 1.65.10 | "This video is unavailable" (1.65.10 live HLS now 403s) |
| TVHTML5 / TVHTML5_SIMPLY_EMBEDDED / tv_downgraded / tv_samsung / web_safari | UNPLAYABLE / LOGIN_REQUIRED bot-check |
| IOS 19.09.3 | 400 |
| **IOS 21.02.3 + key** | **OK — 14 adaptiveFormats with direct signed URLs** |
| IOS 20.10.4 + key | OK |
| IOS 21.26.4 (keyless) | OK but SABR-only (metadata, no URLs) |

Working recipe (pinned — newer IOS versions drop to SABR-only):

```
key:    AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc   (IOS public key)
UA:     com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)
context: {clientName:'IOS', clientVersion:'21.02.3', deviceMake:'Apple',
          deviceModel:'iPhone16,2', osName:'iPhone', osVersion:'18_3_2',
          hl:'en', gl:'US'}
```

WEB key `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`, ANDROID key
`AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w` (dead for live).
yt-dlp 2026 notes: since July 2026 HLS formats only returned for
logged-in/trusted sessions; `serverAbrStreamingUrl` = **SABR** (protobuf
server-pull; `&sq=N` GET returns `sabr.malformed_config` — not usable from
plain fetch).

**Live playback protocol** (no HLS manifest): poll `formatUrl + '&range=0-'`
→ HTTP 200 returning `ftyp+moov+emsg+moof+mdat` = init + the single live-edge
fMP4 segment (5s segments, `targetDurationSec:5`, `maxDvrDurationSec:43200`).
Identical bytes repeat until the head advances (`x-head-time-sec` header
tracks it); `&sq=` → 404; out-of-window ranges → empty 200. Video (H.264
itags 137/136/135/134/133/160) and audio (prefer 140 `mp4a.40.2`, avoid 139
HE-AAC) are separate single-track streams polled independently.
`expiresInSeconds` ~21540 but 403s observed much sooner for stale sessions.

**googlevideo URLs are IP-bound**: `ip` is in `sparams` (removing it → 403),
so resolve + all segment fetches must share one egress IP → `relayAll:true`.

**Live init/media box layout** (verified, `yt-initdissect.mjs`):
ftyp(28) + moov(676: single trak, tkhd ver0, mdhd ver0, hdlr 'vide', stsd 153)
+ emsg(~328) + moof + mdat. moof: tfhd flags `0x2000a` (trackId@b[12],
default_dur=3000 @ts 90000), tfdt **ver1** absolute baseDecode, trun flags
`0x601` (data_offset moof-relative = moofSize+8, sample_size, sample_flags;
NO duration field). sample_flags depends bits are all 0 → keyframe detection
must scan AVCC NALs for IDR. Audio init moov ~608B; video resp ~250-300KB,
audio ~82KB per 5s at 720p.

## 6. Engine gotchas (learned the hard way)

- PTS: TS is 90 kHz → `pts*1e6/90000` (a 1000× bug bit us once).
- `AudioDecoderConfig` needs `numberOfChannels`; ASC builder:
  `[((profile+1)<<3)|(fidx>>1), ((fidx&1)<<7)|(chan<<2)]`.
- WebCodecs: a decoding error fires the error callback and **auto-closes** the
  decoder (guard stale callbacks); `error`/`output` are constructor callbacks,
  not events; `decode()` before a key throws "A key frame is required…".
- Clock: audio-anchored only while `actx.state==='running'`; else wall clock
  anchored to first video sample; underrun resync; PTS-discontinuity re-anchor
  (`_ptsShift`, >2s jump); live-edge skip when >10s behind; `resumeAudio()`
  from any user gesture unlocks autoplay-suspended AudioContext.
- yt-live **generation guard** (`_ytGen`): a poll sleeping mid-loop when
  `_switchVariant` is set resurrects after the flag resets and feeds the OLD
  stream into the NEW decoder → periodic "Decoding error". Every loop
  iteration bumps `_ytGen`; stale polls die and never push.
- Static file servers cache `engine.js` — always `Page.reload {ignoreCache:true}`
  and verify loaded source.

## 7. Dev workflow

```powershell
# CDP Chrome for REA + probes (profile persists logins if ever needed)
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --remote-debugging-port=9333 `
  --user-data-dir=C:\Users\ds\AppData\Local\Temp\opencode\rea-chrome-profile `
  --new-window http://127.0.0.1:8123/player/index.html
# static server (repo root, port 8123) + local relay mirror of worker.js:
node player/research/local-relay.mjs        # 127.0.0.1:8124
python -m http.server 8123                  # or npx serve
```

- PowerShell 5 mangles `$`/quotes in inline `node -e` — write `.mjs` files;
  top-level await needs `.mjs`; no `&&` in PS5 command lines.
- Node fetch silently drops the forbidden `Origin` header — test CORS with
  `curl.exe -H "Origin: …"`.
- CDP probes: `probes/cdp-*.js <tabId> [url]` — tab id from
  `http://127.0.0.1:9333/json`. `cdp-shot.js` screenshots (no navigate);
  `cdp-kickfps.js` steady-state fps/errs probe (works for all platforms);
  `cdp-ytswitch.js` / `cdp-ytfault.js` exercise quality switch and
  403→re-resolve recovery.
- Top-level `class` in a classic script is NOT a `window` property — CDP
  injections must reference the class name directly.

## 8. Verification results (2026-10-12, Chrome 1270.0.8642.54)

| platform | stream | result |
|---|---|---|
| Twitch | twitch.tv/lofigirl | 23.2fps vs 24fps, 0 errs, 0 gens |
| Kick | kick.com/nicklee | 81fps (60 + catch-up burst), 0 errs |
| YouTube | 1-LpQekNa9g (Lofi Girl) | 720p/1080p, 0 errs; 720↔480/1080 switches clean; injected 403 → re-resolve in ~400ms |

Screenshots: `screenshots/{twitch,kick,yt}-final.png`.

Live test video IDs confirmed via watch page `isLiveNow:true` (rotate over
time): `1-LpQekNa9g`, `rFZHOHl-L8A`, `JD-kMIpDfnY`, `IPg9DRpm9xQ`,
`blAFxjhg62k`, `7NOSDKb0HlU`, `E2vONfzoyRI`, `5yx6BWlEVcY`.
(`jfKfPfyJRdk` is offline.) `probes/yt-checklive.mjs` re-checks candidates.

## 9. Open items

- Deploy `player/worker.js` to Cloudflare; point player Settings at it.
  IOS client behavior from Cloudflare datacenter IPs **untested** — if
  bot-checked, run the relay on a residential/VPS box (teslaplay does this).
- YouTube VOD: needs progressive `moov/stbl` parsing in `Fmp4Demuxer`.
- AES-128 HLS, HEVC, speed control (teslaplay does 0.75–2×), chat panel.
