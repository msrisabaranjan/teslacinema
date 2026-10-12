# TCinema Player

Self-hosted YouTube / Twitch / Kick player for the Tesla in-car browser,
built from what the REA teardown of **teslaplay.net** and **teslurk.com**
taught us:

> Tesla's browser plays nothing through `<video>`/MSE reliably (and Drive-mode
> throttles it), so both sites demux in JS and decode with **WebCodecs**,
> rendering to a **canvas**. Teslurk proves the media path can be 100%
> client-side for Twitch (public gql client-id + `usher.ttvnw.net` CORS `*`);
> only auth/Helix go through their server. Teslaplay proxies YouTube because
> googlevideo URLs can't be fetched cross-origin.

## How this is put together

| Piece | File | What it does |
|---|---|---|
| Canvas-HLS engine | `engine.js` | m3u8 → MPEG-TS demux (Twitch/Kick) or fMP4 demux (YouTube) → `VideoDecoder`/`AudioDecoder` → canvas + AudioContext PLL |
| Resolver | `resolve.js` | Twitch: client-side `gql` PlaybackAccessToken → usher m3u8. Kick: `kick.com/api/v2` (direct or via relay). YouTube: relay only |
| Relay (optional) | `worker.js` | Cloudflare Worker: `/relay` HLS proxy+rewriter, `/kick/<login>`, `/yt/<videoId>` |
| UI | `index.html` | Tesla-friendly fullscreen player, quality picker, deep links (`?ch=shroud`) |

## Run it

```bash
# from the TCinema repo root
python -m http.server 8000      # or: npx serve
# open http://localhost:8000/player/
```

Twitch works with **no server at all**. For Kick-fallback and YouTube:

1. Create a Cloudflare Worker, paste `worker.js`, deploy.
2. Paste the `https://….workers.dev` URL into the player's Settings field
   (stored in `localStorage["tcinema:proxy"]`).

## YouTube live (how it actually works in 2026)

Unauthenticated clients no longer get `hlsManifestUrl`, and the
`serverAbrStreamingUrl` (SABR, protobuf server-pull) is not usable from a
plain fetch. What still works is the **IOS innertube client with its public
key** (`21.02.3`, pinned — newer versions return SABR-only formats with no
URLs). The `/yt/<videoId>` route calls `player` with that client and returns
direct signed googlevideo URLs for a single-track H.264 video representation
(itags 137/136/135/… ≤ requested height) plus an AAC-LC audio track (140).

Live playback is not HLS: the engine polls `formatUrl + '&range=0-'`, which
returns `ftyp+moov+emsg+moof+mdat` — the init segment plus the **single
fMP4 segment at the live head** (5 s segments). Identical bytes repeat until
the head advances, so each poll is deduped by its `tfdt` base-decode time.
Video and audio are polled independently with two `Fmp4Demuxer` instances
(each representation has its own track ids). A 403 means the signed URL
expired → the player re-resolves via `/yt` (`opts.refetchYt`).

**IP binding caveat:** googlevideo signatures embed the requester's IP
(`ip` is in `sparams`), so resolution *and* every segment fetch must come
from the same egress IP. That's why YouTube sets `relayAll: true` — the
relay does both. A Cloudflare Worker's per-PoP egress is stable enough for
one stream, but a mid-stream IP change kills the URLs (they re-resolve).

## Known limits / next steps

- **YouTube bot-check**: googlevideo flags datacenter IPs. IOS 21.02.3 +
  key works from residential connections; on Workers you may get
  "Sign in to confirm you're not a bot". This is the part teslaplay runs on
  their own infra (their client only ever sees `/api/youtube/stream/…`).
- **YouTube VOD not supported yet** — the fMP4 demuxer only parses
  fragmented (moof/mdat) layouts, not progressive `moov/stbl`.
- **No AES-128 encrypted HLS** (Twitch/Kick/YouTube live are clear).
- **HEVC** variant not decoded yet (H.264 only) — Twitch serves avc1 by default.
- Speed control / WSOLA audio stretching (teslaplay does 0.75–2×) not ported.
- Chat panel: reuse the dashboard's existing Twitch chat iframe.

## Legal note

Same as teslaplay/teslurk: this only plays streams the platforms already
serve to browsers; it bypasses no DRM. Platform ToS still apply — keep it
for personal use.
