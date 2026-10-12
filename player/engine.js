/* ════════════════════════════════════════════════════════════════════
 * TCinema canvas-HLS engine
 *
 * HLS → demux (MPEG-TS or fMP4) → WebCodecs decode → <canvas> + AudioContext.
 * No <video> element, no MSE, no hls.js — the same family of approach used
 * by teslaplay.net and teslurk.com, which is what makes playback work in
 * the Tesla in-car Chromium browser (and dodges Drive-mode <video> throttling).
 *
 * Supported:
 *   - HLS master + media playlists (clear streams only, no AES-128)
 *   - MPEG-TS segments  (Twitch usher, Kick)      → TSDemuxer
 *   - fMP4/CMAF segments (YouTube HLS, EXT-X-MAP) → Fmp4Demuxer
 *   - H.264 video (avc1), AAC-LC audio (mp4a.40.2)
 * ════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────── m3u8 parsing ─────────────────────────── */

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:([^\r\n]*)/);
    if (!m) continue;
    const attrs = m[1];
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    out.push({
      bandwidth: +(attrs.match(/BANDWIDTH=(\d+)/) || [])[1] || 0,
      resolution: (attrs.match(/RESOLUTION=(\d+x\d+)/) || [])[1] || '',
      url: new URL(uri, baseUrl).href,
    });
  }
  return out.sort((a, b) => a.bandwidth - b.bandwidth);
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let seq = 0, target = 4, endList = false;
  const segments = [];
  let mapUri = null, pendingDur = 0, pendingDisc = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) seq = +(line.split(':')[1] || 0);
    else if (line.startsWith('#EXT-X-TARGETDURATION')) target = +(line.split(':')[1] || 4);
    else if (line.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (line.startsWith('#EXT-X-DISCONTINUITY')) pendingDisc = true;
    else if (line.startsWith('#EXT-X-KEY')) throw new Error('Encrypted (AES) streams are not supported');
    else if (line.startsWith('#EXT-X-MAP')) {
      const uri = line.match(/URI="([^"]+)"/);
      if (uri) mapUri = new URL(uri[1], baseUrl).href;
    } else if (line.startsWith('#EXTINF')) {
      const m = line.match(/:([\d.]+)/);
      pendingDur = m ? +m[1] : target;
    } else if (line && !line.startsWith('#')) {
      segments.push({ uri: new URL(line.trim(), baseUrl).href, duration: pendingDur, discontinuity: pendingDisc });
      pendingDur = 0;
      pendingDisc = false;
    }
  }
  return { mediaSequence: seq, targetDuration: target, endList, mapUri, segments };
}

/* ─────────────────────────── shared helpers ───────────────────────── */

function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 90 kHz PTS (33-bit) → microseconds
function ptsToUs(pts) { return Math.round(pts * 1000000 / 90000); }

/* Split Annex-B byte stream into NAL units (emulation-prevention intact). */
function splitNals(data) {
  const nals = [];
  let i = 0;
  // find start codes (00 00 01 / 00 00 00 01)
  const starts = [];
  for (let j = 0; j + 2 < data.length; j++) {
    if (data[j] === 0 && data[j + 1] === 0) {
      if (data[j + 2] === 1) starts.push(j + 3);
      else if (data[j + 2] === 0 && j + 3 < data.length && data[j + 3] === 1) { starts.push(j + 4); j++; }
    }
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length;
    // trim trailing zero bytes / start-code prefix of next nal
    let e = end;
    while (e > starts[k] && data[e - 1] === 0) e--;
    nals.push(data.subarray(starts[k], e));
  }
  return nals;
}

/* NAL list → AVCC (4-byte length-prefixed) buffer for VideoDecoder. */
function nalsToAvcc(nals) {
  let n = 0;
  for (const nal of nals) n += 4 + nal.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const nal of nals) {
    out[o++] = nal.length >>> 24; out[o++] = (nal.length >>> 16) & 255;
    out[o++] = (nal.length >>> 8) & 255; out[o++] = nal.length & 255;
    out.set(nal, o); o += nal.length;
  }
  return out;
}

function buildAvcC(sps, pps) {
  const out = new Uint8Array(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1;               // configurationVersion
  out[o++] = sps[1];          // profile_idc
  out[o++] = sps[2];          // profile_compatibility
  out[o++] = sps[3];          // level_idc
  out[o++] = 0xFC | 3;        // NALU length size = 4
  out[o++] = 0xE1;            // 1 SPS
  out[o++] = sps.length >> 8; out[o++] = sps.length & 255;
  out.set(sps, o); o += sps.length;
  out[o++] = 1;               // 1 PPS
  out[o++] = pps.length >> 8; out[o++] = pps.length & 255;
  out.set(pps, o);
  return out;
}

/* ─────────────────────────── MPEG-TS demuxer ──────────────────────── */

class TSDemuxer {
  /* handlers: { onVideo(data, ptsUs), onAudio(data, ptsUs) } */
  constructor(handlers) {
    this.h = handlers;
    this.left = null;
    this.pmtPid = null;
    this.streams = new Map();          // pid → {type, chunks, pes, pts, dts}
    this.lastPts = { video: null, audio: null };
    this.wrap = { video: 0, audio: 0 };
    this.quirk = false;                // afc=01-with-payload encoder (Twitch)
  }

  push(chunk) {
    let data = chunk;
    if (this.left) {
      const c = new Uint8Array(this.left.length + chunk.length);
      c.set(this.left); c.set(chunk, this.left.length);
      data = c; this.left = null;
    }
    let i = 0;
    while (i < data.length && data[i] !== 0x47) i++;   // resync
    while (i + 188 <= data.length) {
      if (data[i] !== 0x47) { i++; while (i < data.length && data[i] !== 0x47) i++; continue; }
      this._packet(data.subarray(i, i + 188));
      i += 188;
    }
    if (i < data.length) this.left = data.subarray(i);
  }

  /* end of segment: any partial PES is complete enough to emit */
  flushSegment() {
    for (const s of this.streams.values()) this._flushPes(s);
  }

  /* Called after each segment's bytes. IVS/Kick muxer quirk: the last video
   * PES of a segment is complete within the segment, yet the next segment
   * starts with PUSI=0 packets that are NOT a continuation (new AU without
   * its PES header flag set). Appending them corrupts the boundary AU, so
   * unbounded (payload_length=0) PESes are terminated at segment end.
   * Bounded PESes may legitimately span segments — keep those open; the
   * need/got check in _flushPes drops them if the bytes never arrive. */
  segmentEnd() {
    for (const s of this.streams.values()) {
      if (s.pes && s.need === 0) this._flushPes(s);
      s.pending = null;
    }
  }

  _packet(p) {
    const pusi = (p[1] >> 6) & 1;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const afc = (p[3] >> 4) & 3;
    if (pid === 0x1fff) return;                        // null packet
    let pay;
    if (afc === 3) pay = 5 + p[4];                     // adaptation + payload
    else if (afc === 2) pay = 4;                       // payload only
    else if (afc === 1) {
      // Twitch/weaver quirk: afc=01 ("adaptation field only") yet a section/
      // PES payload with pointer field starts at byte 4 (byte4 values exceed
      // 183, so they cannot be adaptation lengths). Detect once from the PAT.
      if (!this.quirk && pid === 0 && pusi && p[4] === 0 && p[5] === 0x00 && p[6] === 0xb0)
        this.quirk = true;
      if (!this.quirk) return;                         // standard: no payload
      pay = 4;
    } else return;                                     // afc=0 reserved
    if (pay >= 188) return;
    if (pid === 0) { if (pusi) this._pat(p.subarray(pay)); return; }
    if (pid === this.pmtPid) { if (pusi) this._pmt(p.subarray(pay)); return; }
    const s = this.streams.get(pid);
    if (!s) return;
    if (pusi) this._pesHeader(s, p.subarray(pay));
    else if (s.pes) {
      if (s.pending) {
        // continuation of the old PES spills past the mid-packet header into
        // following packets; route bytes to it until the new AU's start code
        const d = p.subarray(pay);
        const k = this._findSc(d, 0);
        if (k < 0) { s.chunks.push(d); s.got += d.length; }
        else {
          if (k > 0) { s.chunks.push(d.subarray(0, k)); s.got += k; }
          const pend = s.pending; this._flushPes(s); this._beginPes(s, pend, d.subarray(k));
        }
      } else { s.chunks.push(p.subarray(pay)); s.got += 188 - pay; }
    }
  }

  _pat(sec) {
    let i = sec[0] + 1;                                // pointer field
    if (sec[i] !== 0x00) return;
    const len = ((sec[i + 1] & 0x0f) << 8) | sec[i + 2];
    const end = i + 3 + len - 4;                       // stop before CRC
    for (let j = i + 8; j + 3 < end; j += 4) {
      const prog = (sec[j] << 8) | sec[j + 1];
      const pmt = ((sec[j + 2] & 0x1f) << 8) | sec[j + 3];
      if (prog !== 0) { this.pmtPid = pmt; this.streams.clear(); }
    }
  }

  _pmt(sec) {
    let i = sec[0] + 1;
    if (sec[i] !== 0x02) return;
    const len = ((sec[i + 1] & 0x0f) << 8) | sec[i + 2];
    const end = i + 3 + len - 4;
    const pil = ((sec[i + 10] & 0x0f) << 8) | sec[i + 11];
    let j = i + 12 + pil;
    const found = new Map();
    while (j + 5 < end) {
      const st = sec[j];
      const espid = ((sec[j + 1] & 0x1f) << 8) | sec[j + 2];
      const esil = ((sec[j + 3] & 0x0f) << 8) | sec[j + 4];
      let type = null;
      if (st === 0x1b) type = 'video';                 // H.264
      else if (st === 0x0f) type = 'audio';            // AAC (ADTS)
      if (type) found.set(espid, { type, chunks: [], pes: false, pending: null, pts: 0, dts: 0 });
      j += 5 + esil;
    }
    for (const [pid, s] of found) if (!this.streams.has(pid)) this.streams.set(pid, s);
    for (const pid of [...this.streams.keys()]) if (!found.has(pid)) this.streams.delete(pid);
  }

  _isSc(d, k) {
    return d[k] === 0 && d[k + 1] === 0 &&
      (d[k + 2] === 1 || (d[k + 2] === 0 && k + 3 < d.length && d[k + 3] === 1));
  }

  _findSc(d, from) {
    for (let k = from; k + 2 < d.length; k++) if (this._isSc(d, k)) return k;
    return -1;
  }

  _pesHeader(s, d) {
    // pusi=1 packets carry a pointer field before the PES header (stream_id
    // 0x01 is illegal, so the 00 00 00 01 pattern is unambiguous)
    if (d.length > 4 && d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1)
      d = d.subarray(1);
    if (d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) { s.pes = false; s.pending = null; return; }
    const flags = (d[7] >> 6) & 3;
    const hdrLen = d[8];
    const hdrEnd = 9 + hdrLen;
    const plen = (d[4] << 8) | d[5];   // PES_packet_length (0 = unbounded)
    const pend = {
      pts: (flags & 2) ? this._readPts(d, 9) : 0,
      dts: (flags & 1) ? this._readPts(d, 14) : (flags & 2) ? this._readPts(d, 9) : 0,
      need: plen > 0 ? plen - 3 - hdrLen : 0,
    };
    const body = hdrEnd < d.length ? d.subarray(hdrEnd) : null;
    if (!s.pes || s.type !== 'video') { this._flushPes(s); this._beginPes(s, pend, body); return; }
    // Twitch/Kick (weaver) quirk: a new PES header can start mid-packet and the
    // *previous* PES's continuation bytes follow it. Hand those bytes (up to the
    // first Annex-B start code — slice data can never contain one, the
    // emulation-prevention 00 00 03 escape forbids it) to the old PES before
    // flushing it, otherwise the old AU is truncated mid-slice and kills the
    // decoder. Standard streams: first byte after the header is a start code,
    // so zero bytes move and behavior is unchanged. Audio PESes are bounded and
    // ADTS has no start codes, so they keep the plain flush-and-start path.
    if (!body) { s.pending = pend; return; }
    const k = this._findSc(body, 0);
    if (k < 0) { s.chunks.push(body); s.got += body.length; s.pending = pend; }
    else {
      if (k > 0) { s.chunks.push(body.subarray(0, k)); s.got += k; }
      this._flushPes(s); this._beginPes(s, pend, body.subarray(k));
    }
  }

  _beginPes(s, pend, body) {
    s.pes = true;
    s.pending = null;
    s.chunks = [];
    s.pts = pend.pts;
    s.dts = pend.dts;
    s.need = pend.need;
    s.got = 0;
    if (body) { s.chunks.push(body); s.got += body.length; }
  }

  _readPts(d, o) {
    return (
      ((d[o] >> 1) & 15) * 536870912 +
      (((d[o + 1] << 8) | d[o + 2]) >> 1) * 16384 +
      (((d[o + 3] << 8) | d[o + 4]) >> 1)
    );
  }

  _flushPes(s) {
    if (!s.pes) return;
    s.pes = false;
    s.pending = null;
    if (!s.chunks.length) return;
    // truncated at a segment boundary (declared payload never fully arrived):
    // emitting it would feed the decoder garbage — drop the frame instead
    if (s.need > 0 && s.got < s.need) { s.chunks = []; return; }
    const data = s.chunks.length === 1 ? s.chunks[0] : concatBytes(s.chunks);
    // normalize 33-bit PTS wraparound
    const last = this.lastPts[s.type];
    if (last !== null) {
      const d = s.pts - last;
      if (d < -2147483648) this.wrap[s.type] += 8589934592;
      else if (d > 4294967296) this.wrap[s.type] -= 8589934592;
    }
    this.lastPts[s.type] = s.pts;
    const us = ptsToUs(s.pts + this.wrap[s.type]);
    if (s.type === 'video') this.h.onVideo(data, us);
    else this.h.onAudio(data, us);
  }
}

/* ─────────────────────────── fMP4 (CMAF) demuxer ──────────────────── */

class Fmp4Demuxer {
  /* handlers: { onVideo(data, ptsUs, isKey), onAudio(data, ptsUs) } */
  constructor(handlers) {
    this.h = handlers;
    this.tracks = new Map();   // trackId → {type, timescale, config, lenSize}
    this.pending = new Uint8Array(0);
    this._mdat = null;
    this._pendingMoof = null;  // moof metadata waits for its mdat
  }

  /* parse an init segment (ftyp+moov) and configure decoders */
  setInit(bytes) {
    this._pendingMoof = null;
    this._walk(bytes, 0, bytes.length, null);
  }

  push(bytes) {
    let data = bytes;
    if (this.pending.length) {
      const c = new Uint8Array(this.pending.length + bytes.length);
      c.set(this.pending); c.set(bytes, this.pending.length);
      data = c; this.pending = new Uint8Array(0);
    }
    // whole boxes only; keep trailing partial box
    let off = 0;
    while (off + 8 <= data.length) {
      const size = (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
      if (size < 8 || off + size > data.length) break;
      this._box(data.subarray(off, off + size));
      off += size;
    }
    if (off < data.length) this.pending = data.subarray(off);
  }

  _box(b) {
    const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (type === 'moov') { this._walk(b, 8, b.length, 'moov'); }
    else if (type === 'moof') { this._pendingMoof = this._parseMoof(b); }
    else if (type === 'mdat') {
      this._mdat = b.subarray(8);
      if (this._pendingMoof) { this._emit(this._pendingMoof); this._pendingMoof = null; }
    }
  }

  _walk(b, from, to, ctx) {
    let off = from;
    while (off + 8 <= to) {
      const size = (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
      const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      if (size < 8 || off + size > to) break;
      const body = b.subarray(off, off + size);
      if (type === 'trak') this._track(body);
      else if (type === 'moov' || type === 'mdia' || type === 'minf' || type === 'stbl') this._walk(body, 8, body.length, type);
      off += size;
    }
  }

  /* collect one trak's info */
  _track(trak) {
    let trackId = 0, handler = '', timescale = 1, stsd = null;
    const walk = (b, from, to) => {
      let off = from;
      while (off + 8 <= to) {
        const size = (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
        const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
        if (size < 8 || off + size > to) break;
        const body = b.subarray(off, off + size);
        if (type === 'tkhd') {
          // v0: ver/flags(4) ctime(4) mtime(4) track_ID(4) → body[20]; v1: 8-byte times → body[28]
          const o = body[8] === 1 ? 28 : 20;
          trackId = (body[o] << 24) | (body[o + 1] << 16) | (body[o + 2] << 8) | body[o + 3];
        } else if (type === 'hdlr') {
          handler = String.fromCharCode(body[16], body[17], body[18], body[19]);
        } else if (type === 'mdhd') {
          // v0: ver/flags(4) ctime(4) mtime(4) timescale(4) → body[20]; v1 → body[28]
          const o = body[8] === 1 ? 28 : 20;
          timescale = (body[o] << 24) | (body[o + 1] << 16) | (body[o + 2] << 8) | body[o + 3];
        } else if (type === 'stsd') {
          stsd = body;
        } else if (type === 'mdia' || type === 'minf' || type === 'stbl') {
          walk(body, 8, body.length);
        }
        off += size;
      }
    };
    walk(trak, 8, trak.length);
    if (!trackId || (handler !== 'vide' && handler !== 'soun')) return;
    const t = { type: handler === 'vide' ? 'video' : 'audio', timescale, config: null, lenSize: 4 };
    if (stsd) {
      t.config = this._parseStsd(stsd);
      if (t.config && t.config.lenSize) t.lenSize = t.config.lenSize;
    }
    this.tracks.set(trackId, t);
    if (t.config) {
      if (t.type === 'video') this.h.onVideoConfig(t.config);
      else this.h.onAudioConfig(t.config);
    }
  }

  _parseStsd(stsd) {
    // stsd: size(4) type(4) ver/flags(4) entry_count(4) → first entry at off 16
    let off = 16;
    const size = (stsd[off] << 24) | (stsd[off + 1] << 16) | (stsd[off + 2] << 8) | stsd[off + 3];
    const format = String.fromCharCode(stsd[off + 4], stsd[off + 5], stsd[off + 6], stsd[off + 7]);
    const entry = stsd.subarray(off, off + size);
    if (format === 'avc1') {
      // sample-entry fixed fields make box-walking fragile — byte-scan for avcC
      const i = this._fourcc(entry, 'avcC');
      if (i > 0) {
        const sz = (entry[i - 4] << 24) | (entry[i - 3] << 16) | (entry[i - 2] << 8) | entry[i - 1];
        const avcC = entry.subarray(i + 4, i - 4 + sz);
        const codec = 'avc1.' + [avcC[1], avcC[2], avcC[3]].map(x => x.toString(16).padStart(2, '0')).join('');
        return { codec, description: avcC, lenSize: (avcC[4] & 3) + 1 };
      }
    } else if (format === 'mp4a') {
      // esds → DecoderConfigDescriptor → AudioSpecificConfig (tag 0x05)
      const i = this._fourcc(entry, 'esds');
      if (i > 0) {
        const sz = (entry[i - 4] << 24) | (entry[i - 3] << 16) | (entry[i - 2] << 8) | entry[i - 1];
        const body = entry.subarray(i + 4, i - 4 + sz);
        for (let k = 0; k < body.length - 2; k++) {
          if (body[k] === 0x05) {
            const len = body[k + 1];
            return { codec: 'mp4a.40.2', description: body.subarray(k + 2, k + 2 + len) };
          }
        }
      }
    }
    return null;
  }

  /* index of a fourcc inside a sample entry (skips the 8-byte entry header) */
  _fourcc(b, cc) {
    const c0 = cc.charCodeAt(0), c1 = cc.charCodeAt(1), c2 = cc.charCodeAt(2), c3 = cc.charCodeAt(3);
    for (let i = 8; i + 4 <= b.length; i++) {
      if (b[i] === c0 && b[i + 1] === c1 && b[i + 2] === c2 && b[i + 3] === c3) return i;
    }
    return -1;
  }

  /* parse moof metadata only; samples are emitted when its mdat arrives */
  _parseMoof(moof) {
    const m = { size: moof.length, trafs: [] };
    let off = 8;
    while (off + 8 <= moof.length) {
      const size = this._u32(moof, off);
      const type = String.fromCharCode(moof[off + 4], moof[off + 5], moof[off + 6], moof[off + 7]);
      if (size < 8 || off + size > moof.length) break;
      if (type === 'traf') m.trafs.push(this._traf(moof.subarray(off, off + size)));
      off += size;
    }
    return m;
  }

  _traf(traf) {
    let off = 8;
    const d = { trackId: 0, baseDecode: 0, defDur: 0, defSize: 0, defFlags: 0, truns: [] };
    while (off + 8 <= traf.length) {
      const size = this._u32(traf, off);
      const type = String.fromCharCode(traf[off + 4], traf[off + 5], traf[off + 6], traf[off + 7]);
      if (size < 8 || off + size > traf.length) break;
      const b = traf.subarray(off, off + size);
      const flags = (b[9] << 16) | (b[10] << 8) | b[11];        // version at b[8]
      if (type === 'tfhd') {
        d.trackId = this._u32(b, 12);
        let o = 16;
        if (flags & 0x01) o += 8;                                // base_data_offset
        if (flags & 0x02) o += 4;                                // sample_description_index
        if (flags & 0x08) { d.defDur = this._u32(b, o); o += 4; }
        if (flags & 0x10) { d.defSize = this._u32(b, o); o += 4; }
        if (flags & 0x20) { d.defFlags = this._u32(b, o); o += 4; }
      } else if (type === 'tfdt') {
        d.baseDecode = b[8] === 1 ? this._u64(b, 12) : this._u32(b, 12);
      } else if (type === 'trun') {
        d.truns.push({ b, flags });
      }
      off += size;
    }
    return d;
  }

  _emit(m) {
    const mdat = this._mdat;
    if (!mdat) return;
    for (const d of m.trafs) {
      const t = this.tracks.get(d.trackId);
      if (!t) continue;
      let run = 0;                                               // tfdt is absolute per moof
      for (const { b, flags } of d.truns) {
        const count = this._u32(b, 12);
        let o = 16;
        // trun data_offset is moof-relative; mdat payload sits at moof+size+8
        let cursor = (flags & 0x01) ? this._u32(b, o) - m.size - 8 : 0;
        if (flags & 0x01) o += 4;
        if (flags & 0x04) o += 4;                                // first_sample_flags
        for (let i = 0; i < count; i++) {
          let dur = d.defDur, sz = d.defSize, cts = 0;           // fall back to tfhd defaults
          if (flags & 0x100) { dur = this._u32(b, o); o += 4; }
          if (flags & 0x200) { sz = this._u32(b, o); o += 4; }
          if (flags & 0x400) o += 4;
          if (flags & 0x800) { cts = this._u32(b, o); o += 4; }
          if (!sz || cursor + sz > mdat.length) break;
          const sample = mdat.subarray(cursor, cursor + sz);
          cursor += sz;
          const ptsUs = Math.round((d.baseDecode + run + cts) * 1000000 / t.timescale);
          run += dur;
          if (t.type === 'video') {
            // sample_flags depends bits are useless on YouTube live (all 0) —
            // scan the AVCC NAL units for an IDR instead
            this.h.onVideo(sample, ptsUs, this._avccKey(sample, t.lenSize));
          } else {
            this.h.onAudio(sample, ptsUs);
          }
        }
      }
    }
  }

  /* length-prefixed AVCC sample → does it contain an IDR (NAL type 5)? */
  _avccKey(sample, lenSize) {
    let o = 0;
    while (o + lenSize <= sample.length) {
      let sz = 0;
      for (let i = 0; i < lenSize; i++) sz = sz * 256 + sample[o + i];
      o += lenSize;
      if (sz <= 0 || o + sz > sample.length) return false;
      if ((sample[o] & 0x1f) === 5) return true;
      o += sz;
    }
    return false;
  }

  _u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  _u64(b, o) { return this._u32(b, o) * 4294967296 + this._u32(b, o + 4); }
}

/* ─────────────────────── fMP4 box helpers ─────────────────────────── */

function concatBytes(parts) {
  if (parts.length === 1) return parts[0];
  let n = 0; for (const p of parts) n += p.length;
  const c = new Uint8Array(n); let o = 0;
  for (const p of parts) { c.set(p, o); o += p.length; }
  return c;
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 7) if (a[i] !== b[i]) return false;  // spot-check
  return true;
}

/* baseMediaDecodeTime of the first traf in a moof-bearing byte range */
function firstTfdt(b) {
  let off = 0;
  while (off + 8 <= b.length) {
    const sz = (b[off] << 24 | b[off + 1] << 16 | b[off + 2] << 8 | b[off + 3]) >>> 0;
    const ty = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (sz < 8 || off + sz > b.length) break;
    if (ty === 'moof') {
      let o = off + 8;
      while (o + 8 <= off + sz) {
        const s2 = (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
        const t2 = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
        if (s2 < 8 || o + s2 > off + sz) break;
        if (t2 === 'traf') {
          let q = o + 8;
          while (q + 8 <= o + s2) {
            const s3 = (b[q] << 24 | b[q + 1] << 16 | b[q + 2] << 8 | b[q + 3]) >>> 0;
            const t3 = String.fromCharCode(b[q + 4], b[q + 5], b[q + 6], b[q + 7]);
            if (s3 < 8 || q + s3 > o + s2) break;
            if (t3 === 'tfdt') {
              const ver = b[q + 8];
              const hi = (b[q + 12] << 24 | b[q + 13] << 16 | b[q + 14] << 8 | b[q + 15]) >>> 0;
              return ver === 1 ? hi * 4294967296 + (b[q + 16] << 24 | b[q + 17] << 16 | b[q + 18] << 8 | b[q + 19] >>> 0) : hi;
            }
            q += s3;
          }
        }
        o += s2;
      }
    }
    off += sz;
  }
  return null;
}

/* ─────────────────────────── main player ──────────────────────────── */

class CanvasHlsPlayer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.g2d = canvas.getContext('2d');
    this.opts = opts;                       // {onStatus, onStats}
    this.running = false;
    this.videoQ = [];                       // {frame, pts}
    this.videoDecoder = null;
    this._videoNeedKey = true;              // fresh decoder: drop deltas until first key
    this.audioDecoder = null;
    this.videoConfig = null;
    this.audioConfig = null;
    this.lastVideoPts = null;
    this.variants = [];
    this.variantIdx = 0;
    this.demuxer = null;
    this._initUri = null;
    this._resetTrackState();
  }

  static supported() {
    return typeof VideoDecoder !== 'undefined' &&
           typeof AudioDecoder !== 'undefined' &&
           typeof EncodedVideoChunk !== 'undefined';
  }

  _resetTrackState() {
    this.videoQ = [];
    this._played = false;
    this.lastVideoPts = null;
    this.lastSamplePts = null;
    this.videoConfig = null;
    this.audioConfig = null;
    this.audioAnchor = null;   // {ctxTime, ptsUs}
    this.nextAudioTime = 0;
    this.newestAudioPts = null;
    this.wallAnchor = null;    // {t0, ptsUs} fallback clock
    this.audioActive = false;
  }

  status(msg) { if (this.opts.onStatus) this.opts.onStatus(msg); }

  /* ── public API ── */

  async load(masterUrl) {
    this.stop();
    this.running = true;
    this._ensureAudioCtx();
    // Playlist fetches: usher.ttvnw.net / playlist.ttvnw.net return 403 when
    // the browser attaches an Origin header (anti-third-party), so the caller
    // supplies fetchPlaylist(url)→text via the relay. Segments are fetched
    // directly — they send ACAO: * and are NOT Origin-checked.
    const text = this.opts.fetchPlaylist ? await this.opts.fetchPlaylist(masterUrl)
                                         : await this._text(masterUrl);
    if (text.indexOf('#EXTM3U') < 0) throw new Error('Not an m3u8 playlist');
    this.variants = parseMaster(text, masterUrl);
    if (this.variants.length) {
      // default: best ≤ 3.5 Mbps (Tesla-friendly), else lowest
      let idx = this.variants.length - 1;
      for (let i = 0; i < this.variants.length; i++) {
        if (this.variants[i].bandwidth <= 3500000) idx = i;
      }
      this.variantIdx = idx;
    } else {
      this.variants = [{ bandwidth: 0, resolution: '', url: masterUrl }];
      this.variantIdx = 0;
    }
    this._loop = this._run();
  }

  /* YouTube live (2026): no HLS manifests anymore — googlevideo serves the
     live edge as init+one fMP4 segment per `&range=0-` request; re-polling
     returns the same bytes until x-head-time advances. We poll video and
     audio representations separately (each is a single-track fMP4 stream). */
  async loadYtLive(src) {
    this.stop();
    this.running = true;
    this._ensureAudioCtx();
    const fmts = src.formats && src.formats.length ? src.formats : [{ height: 0, bandwidth: 0 }];
    this.variants = fmts.map(f => ({
      bandwidth: f.bandwidth || 0,
      resolution: f.height ? f.height + 'p' : 'Auto',
      heightNum: f.height || 0,
      url: '',
    }));
    this.variantIdx = src.variantIdx != null ? src.variantIdx : this.variants.length - 1;
    this._ytSrc = src;
    this._loop = this._runYtLive();
  }

  qualityList() {
    return this.variants.map((v, i) => ({
      idx: i,
      label: v.resolution || (v.bandwidth ? Math.round(v.bandwidth / 1000) + ' kbps' : 'Auto'),
      bandwidth: v.bandwidth,
    }));
  }

  setQuality(idx) {
    if (idx === this.variantIdx || !this.running) return;
    this.variantIdx = idx;
    this._switchVariant = true;
  }

  stop() {
    this.running = false;
    try { this.videoDecoder && this.videoDecoder.state !== 'unconfigured' && this.videoDecoder.close(); } catch (_) {}
    try { this.audioDecoder && this.audioDecoder.state !== 'unconfigured' && this.audioDecoder.close(); } catch (_) {}
    this.videoDecoder = null;
    this.audioDecoder = null;
    this._killAudio();
    this._resetTrackState();
    this.g2d && this.g2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /* ── playlist loop ── */

  async _run() {
    let curVariant = -1;
    while (this.running) {
      if (curVariant !== this.variantIdx) {
        curVariant = this.variantIdx;
        this._switchVariant = false;
        this._resetTrackState();
        this.demuxer = null;
        this._initUri = null;
        this.status('Loading ' + (this.variants[curVariant].resolution || 'stream') + '…');
      }
      try {
        await this._runVariant(this.variants[curVariant]);
        if (!this.running) return;
        this.status('Stream ended');
        return;
      } catch (e) {
        if (!this.running) return;
        this.status('Reconnecting… (' + e.message + ')');
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async _runVariant(variant) {
    let seq = null;
    while (this.running) {
      if (this._switchVariant) return this._runVariant(variant); // handled by outer loop
      const text = this.opts.fetchPlaylist ? await this.opts.fetchPlaylist(variant.url)
                                           : await this._text(variant.url);
      const media = parseMedia(text, variant.url);
      if (!media.segments.length) { await new Promise(r => setTimeout(r, 2000)); continue; }
      if (seq === null) {
        // live: start near the live edge; VOD: start at the beginning
        const start = media.endList ? 0 : Math.max(0, media.segments.length - 3);
        seq = media.mediaSequence + start;
      } else if (!media.endList && this._ahead() < -10) {
        // fallen far behind the live edge: skip forward instead of crawling
        seq = media.mediaSequence + Math.max(0, media.segments.length - 3);
      }
      for (let i = 0; i < media.segments.length; i++) {
        if (!this.running || this._switchVariant) return;
        const n = media.mediaSequence + i;
        if (n < seq) continue;
        if (n > seq) seq = n;                       // playlist jumped ahead
        const seg = media.segments[i];
        if (seg.discontinuity) this.demuxer = null;  // fresh PTS base
        if (media.mapUri && media.mapUri !== this._initUri) {
          this._initUri = media.mapUri;
          const init = await this._buf(media.mapUri);
          this._ensureDemuxer('fmp4').setInit(init);
        }
        const buf = await this._buf(seg.uri);
        const kind = this._sniff(buf);
        const dm = this._ensureDemuxer(kind);
        dm.push(buf);
        if (dm.segmentEnd) dm.segmentEnd();          // flush open unbounded PES at boundary
        seq++;
        // backpressure: keep ~4–8 s ahead of the audio clock
        while (this.running && this._ahead() > 8) await new Promise(r => setTimeout(r, 250));
        if (!this.running) return;
      }
      if (media.endList) return;
      // reload when the last pushed segment is about to end, at latest every
      // targetDuration; when behind, reload promptly to catch up
      const wait = Math.max(300, Math.min(media.targetDuration * 1000,
                                          Math.max(0, this._ahead()) * 1000));
      await new Promise(r => setTimeout(r, wait));
    }
  }

  /* ── YouTube live loop: poll googlevideo `&range=0-` per track ── */

  async _runYtLive() {
    let src = this._ytSrc;
    while (this.running) {
      // generation guard: polls from a previous iteration (stuck in a sleep
      // when _switchVariant was set, then reset) must die, not resurrect
      const gen = this._ytGen = (this._ytGen || 0) + 1;
      this._switchVariant = false;
      this._ytAbort = false;
      this._resetTrackState();
      this.demuxer = null;
      const handlers = {
        onVideo: (d, us, key) => this._onVideoSample(d, us, key),
        onAudio: (d, us) => this._onAudioSample(d, us),
        onVideoConfig: cfg => this._configVideo(cfg),
        onAudioConfig: cfg => this._configAudio(cfg),
      };
      // separate demuxers: each representation has its own track ids
      const vdm = new Fmp4Demuxer(handlers); vdm.kind = 'fmp4';
      const adm = new Fmp4Demuxer(handlers); adm.kind = 'fmp4';
      this.demuxer = vdm;   // _onVideoSample/_onAudioSample check demuxer.kind
      this.status('Loading YouTube ' + (this.variants[this.variantIdx].resolution || 'live') + '…');
      try {
        await Promise.all([
          this._ytPoll(src.videoUrl, vdm, true, gen),
          src.audioUrl ? this._ytPoll(src.audioUrl, adm, false, gen) : new Promise(r => { this._ytAudioIdle = r; }),
        ]);
        if (!this.running) return;
        if (this._switchVariant && this.opts.refetchYt) {
          try { src = await this.opts.refetchYt(this.variants[this.variantIdx].heightNum); continue; }
          catch (e2) { this.status('Quality switch failed: ' + e2.message); }
        }
        this.status('Stream ended');
        return;
      } catch (e) {
        if (!this.running) return;
        if ((e.message === 'yt-switch' || e.message === 'yt-expired') && this.opts.refetchYt) {
          try { src = await this.opts.refetchYt(this.variants[this.variantIdx].heightNum); continue; }
          catch (e2) { this.status('YouTube re-resolve failed: ' + e2.message); }
        } else if (e.message === 'yt-switch') {
          continue;
        }
        this.status('Reconnecting… (' + e.message + ')');
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async _ytPoll(url, dm, isVideo, gen) {
    let lastInit = null, lastTfdt = null;
    const alive = () => this.running && this._ytGen === gen && !this._switchVariant && !this._ytAbort;
    while (alive()) {
      let buf;
      try {
        buf = await this._buf(url + '&range=0-');
      } catch (e) {
        if (this._ytGen !== gen) return;                    // stale generation: die quietly
        if (/HTTP 403/.test(e.message)) { this._ytAbort = true; throw new Error('yt-expired'); }
        this._ytAbort = true; throw e;
      }
      if (!alive()) return;
      if (!buf.length) { await new Promise(r => setTimeout(r, 1000)); continue; }
      // split top-level boxes: init (ftyp/moov) vs media (emsg/moof/mdat)
      const initParts = [], mediaParts = [];
      let off = 0;
      while (off + 8 <= buf.length) {
        const sz = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
        const ty = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
        if (sz < 8 || off + sz > buf.length) break;
        (ty === 'ftyp' || ty === 'moov' ? initParts : mediaParts).push(buf.subarray(off, off + sz));
        off += sz;
      }
      if (initParts.length) {
        const init = concatBytes(initParts);
        if (!lastInit || !sameBytes(init, lastInit)) { lastInit = init; dm.setInit(init); }
      }
      if (mediaParts.length) {
        if (this._ytGen !== gen) return;                    // don't feed samples after a switch
        const media = concatBytes(mediaParts);
        const tfdt = firstTfdt(media);
        if (tfdt !== null && tfdt === lastTfdt) {         // live head not advanced
          await new Promise(r => setTimeout(r, 700));
          continue;
        }
        lastTfdt = tfdt;
        dm.push(media);
        if (isVideo) {
          while (alive() && this._ahead() > 8) await new Promise(r => setTimeout(r, 250));
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (this._ytGen === gen && this._switchVariant) throw new Error('yt-switch');
  }

  _sniff(buf) {
    if (buf.length > 4 && buf[0] === 0x47) return 'ts';
    if (buf.length > 12 && String.fromCharCode(buf[4], buf[5], buf[6], buf[7]) === 'ftyp') return 'fmp4';
    if (buf.length > 12 && String.fromCharCode(buf[4], buf[5], buf[6], buf[7]) === 'moof') return 'fmp4';
    if (buf.length > 12 && String.fromCharCode(buf[4], buf[5], buf[6], buf[7]) === 'styp') return 'fmp4';
    return 'ts';
  }

  _ensureDemuxer(kind) {
    if (this.demuxer && this.demuxer.kind === kind) return this.demuxer;
    const handlers = {
      onVideo: (d, us, key) => this._onVideoSample(d, us, key),
      onAudio: (d, us) => this._onAudioSample(d, us),
      onVideoConfig: cfg => this._configVideo(cfg),
      onAudioConfig: cfg => this._configAudio(cfg),
    };
    const d = kind === 'ts' ? new TSDemuxer(handlers) : new Fmp4Demuxer(handlers);
    d.kind = kind;
    this.demuxer = d;
    return d;
  }

  /* PTS discontinuity (live-edge skip, variant switch, stream restart):
     re-anchor both clocks to the new PTS base and drop stale frames. */
  _ptsShift(us) {
    if (this.lastSamplePts == null) { this.lastSamplePts = us; return; }
    const d = us - this.lastSamplePts;
    if (d > 2e6 || d < -2e6) {
      if (this.wallAnchor) this.wallAnchor.ptsUs += d;
      if (this.audioAnchor) this.audioAnchor.ptsUs += d;
      this.nextAudioTime = 0;                       // re-anchor audio schedule
      for (const q of this.videoQ) q.frame.close();
      this.videoQ.length = 0;
      if (this.lastVideoPts != null) this.lastVideoPts += d;
    }
    this.lastSamplePts = us;
  }

  /* ── video path ── */

  _onVideoSample(annexb, us, isKey) {
    this._ptsShift(us);
    // TS path: Annex-B byte stream → NALs → config + AVCC.
    // fMP4 path: already AVCC length-prefixed, config came from stsd.
    if (this.demuxer && this.demuxer.kind === 'fmp4') {
      if (!isKey && this._videoNeedKey) { this.lastVideoPts = us; return; }
      this._ensureVideoDecoder();
      if (this.videoDecoder) {
        try {
          this.videoDecoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: us, data: annexb }));
          if (isKey) this._videoNeedKey = false;
        } catch (e) {
          try { this.videoDecoder.close(); } catch (_) {}
          this.videoDecoder = null;
          this._videoNeedKey = true;
        }
      }
      this.lastVideoPts = us;
      return;
    }
    const nals = splitNals(annexb);
    let sps = null, pps = null, key = false, vcl = false;
    for (const nal of nals) {
      const t = nal[0] & 0x1f;
      if (t === 7) sps = nal;
      else if (t === 8) pps = nal;
      else if (t === 5) key = true;
      if (t >= 1 && t <= 5) vcl = true;
    }
    if (!vcl) return;
    if (!key && this._videoNeedKey) { this.lastVideoPts = us; return; }
    if (sps && pps) {
      const codec = 'avc1.' + [sps[1], sps[2], sps[3]].map(x => x.toString(16).padStart(2, '0')).join('');
      if (!this.videoConfig || this.videoConfig.codec !== codec) {
        this._configVideo({ codec, description: buildAvcC(sps, pps) });
      }
    }
    this._ensureVideoDecoder();
    if (this.videoDecoder) {
      try {
        this.videoDecoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: us, data: nalsToAvcc(nals) }));
        if (key) this._videoNeedKey = false;
      } catch (e) {
        // a decoding error closes the decoder — recreate it on the next key frame
        try { this.videoDecoder.close(); } catch (_) {}
        this.videoDecoder = null;
        this._videoNeedKey = true;
      }
    }
    this.lastVideoPts = us;
  }

  _configVideo(cfg) {
    this.videoConfig = cfg;
    if (this.videoDecoder) { try { this.videoDecoder.close(); } catch (_) {} this.videoDecoder = null; }
    this._ensureVideoDecoder();
  }

  _ensureVideoDecoder() {
    // an error event closes the decoder but leaves the object — treat closed as absent
    if (this.videoDecoder && this.videoDecoder.state !== 'closed') return;
    if (!this.videoConfig) return;
    this._videoNeedKey = true;
    const dec = new VideoDecoder({
      output: frame => {
        if (!this._played) {
          this._played = true;
          const v = this.variants[this.variantIdx];
          this.status('Playing ' + ((v && v.resolution) || 'stream'));
        } else if (this._videoErr) {
          // decoding resumed after an error — clear the stale error banner
          this._videoErr = null;
          const v = this.variants[this.variantIdx];
          this.status('Playing ' + ((v && v.resolution) || 'stream'));
        }
        this.videoQ.push({ frame, pts: frame.timestamp });
        // hard cap: drop stale frames if we fall behind
        if (this.videoQ.length > 150) {
          const drop = this.videoQ.splice(0, this.videoQ.length - 60);
          for (const d of drop) d.frame.close();
        }
      },
      error: e => {
        // decoder is now closed; force a key frame on the replacement.
        // If it was already replaced, the error is stale — stay quiet.
        if (this.videoDecoder !== dec) return;
        this.videoDecoder = null;
        this._videoNeedKey = true;
        this._videoErr = e.message;
        this.status('Video decoder error: ' + e.message);
      },
    });
    dec.configure(Object.assign({ optimizeForLatency: true }, this.videoConfig));
    this.videoDecoder = dec;
  }

  /* ── audio path ── */

  _onAudioSample(adtsOrRaw, us) {
    this._ptsShift(us);
    this.newestAudioPts = us;
    if (this.demuxer && this.demuxer.kind === 'fmp4') {
      this._ensureAudioDecoder();
      if (this.audioDecoder) this.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: us, data: adtsOrRaw }));
      return;
    }
    // TS path: ADTS frames — strip headers, derive config from first frame
    let i = 0;
    const d = adtsOrRaw;
    while (i + 7 <= d.length) {
      if (d[i] !== 0xff || (d[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
      const profile = (d[i + 2] >> 6) & 3;                 // 1 = AAC-LC
      const fidx = (d[i + 2] >> 2) & 15;
      const chan = ((d[i + 2] & 1) << 2) | ((d[i + 3] >> 6) & 3) || 2;
      const flen = ((d[i + 3] & 3) << 11) | (d[i + 4] << 3) | ((d[i + 5] >> 5) & 7);
      if (flen < 7 || i + flen > d.length) break;
      if (!this.audioConfig) {
        const sr = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][fidx] || 48000;
        // AudioSpecificConfig: OT(5) | freqIdx(4) | ext(1) | chanCfg(4) …
        const asc = new Uint8Array([((profile + 1) << 3) | (fidx >> 1), ((fidx & 1) << 7) | (chan << 2)]);
        this._configAudio({ codec: 'mp4a.40.' + (profile + 1), sampleRate: sr, numberOfChannels: chan, description: asc });
      }
      this._ensureAudioDecoder();
      if (this.audioDecoder) {
        try {
          this.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: us, data: d.subarray(i + 7, i + flen) }));
        } catch (e) {
          // a decoding error closes the decoder — recreate it on the next frame
          try { this.audioDecoder.close(); } catch (_) {}
          this.audioDecoder = null;
        }
      }
      i += flen;
    }
  }

  _configAudio(cfg) {
    // WebCodecs AudioDecoderConfig requires sampleRate + numberOfChannels;
    // the fMP4/esds path only yields codec + AudioSpecificConfig, so derive
    // the rest from the ASC header (OT:5 | freqIdx:4 | priv:1 | chanCfg:4).
    const a = cfg.description;
    if (a && a.length >= 2) {
      const fidx = ((a[0] & 7) << 1) | ((a[1] >> 7) & 1);
      if (!cfg.sampleRate)
        cfg.sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][fidx] || 44100;
      if (!cfg.numberOfChannels) cfg.numberOfChannels = ((a[1] >> 2) & 15) || 2;
    }
    if (!cfg.sampleRate) cfg.sampleRate = 44100;
    if (!cfg.numberOfChannels) cfg.numberOfChannels = 2;
    this.audioConfig = cfg;
    if (this.audioDecoder) { try { this.audioDecoder.close(); } catch (_) {} this.audioDecoder = null; }
    this._ensureAudioDecoder();
  }

  _ensureAudioDecoder() {
    if (this.audioDecoder || !this.audioConfig) return;
    this._ensureAudioCtx();
    this.audioActive = true;
    const dec = new AudioDecoder({
      output: ad => this._scheduleAudio(ad),
      error: e => this.status('Audio decoder error: ' + e.message),
    });
    try {
      dec.configure(this.audioConfig);
      this.audioDecoder = dec;
    } catch (e) {
      // never leave an unconfigured decoder behind — it would poison every
      // later decode() call with "Cannot call 'decode' on an unconfigured codec"
      try { dec.close(); } catch (_) {}
      this.audioActive = false;
      this.status('Audio config error: ' + e.message);
    }
  }

  _ensureAudioCtx() {
    if (!this._actx) {
      this._actx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this._actx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this._actx.destination);
    }
    if (this._actx.state === 'suspended') this._actx.resume().catch(() => {});
  }

  _scheduleAudio(ad) {
    const ctx = this._actx;
    // Autoplay policy: until the user interacts the context stays suspended,
    // currentTime never advances and scheduling is pointless — drop frames and
    // let the wall clock drive video instead.
    if (!ctx || ctx.state !== 'running') { ad.close(); return; }
    // drop decoder backlog that is stale vs the newest input (post-resume burst)
    if (this.newestAudioPts != null && ad.timestamp < this.newestAudioPts - 3e6) { ad.close(); return; }
    const n = ad.numberOfFrames, ch = ad.numberOfChannels;
    const buf = ctx.createBuffer(ch, n, ad.sampleRate);
    let ok = true;
    for (let c = 0; c < ch; c++) {
      try { ad.copyTo(buf.getChannelData(c), { planeIndex: c, format: 'f32-planar' }); }
      catch (_) { ok = false; }
    }
    const pts = ad.timestamp;
    ad.close();
    if (!ok) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const now = ctx.currentTime;
    if (!this.nextAudioTime || this.nextAudioTime < now + 0.02) {
      this.nextAudioTime = now + 0.15;          // (re)anchor after startup/underrun
      this.audioAnchor = { ctxTime: this.nextAudioTime, ptsUs: pts };
    } else if (!this.audioAnchor) {
      this.audioAnchor = { ctxTime: this.nextAudioTime, ptsUs: pts };
    }
    src.start(this.nextAudioTime);
    src.onended = () => { if (src === this._lastSrc) this._lastSrc = null; };
    this._lastSrc = src;
    this._sources = this._sources || [];
    this._sources.push(src);
    if (this._sources.length > 60) this._sources.splice(0, 20).forEach(s => { try { s.disconnect(); } catch (_) {} });
    this.nextAudioTime += buf.duration;
  }

  _killAudio() {
    if (this._sources) { this._sources.forEach(s => { try { s.stop(); s.disconnect(); } catch (_) {} }); this._sources = null; }
    this._lastSrc = null;
    this.nextAudioTime = 0;
  }

  setMuted(m) { this._ensureAudioCtx(); this.gain.gain.value = m ? 0 : 1; }

  /* ── clock + render loop ── */

  _clock() {
    if (this.audioActive && this.audioAnchor && this._actx && this._actx.state === 'running') {
      return this.audioAnchor.ptsUs / 1e6 + (this._actx.currentTime - this.audioAnchor.ctxTime);
    }
    // no audio (or context suspended by autoplay policy): wall clock anchored
    // to first video sample
    if (!this.wallAnchor && this.lastVideoPts != null) {
      this.wallAnchor = { t0: performance.now() / 1000, ptsUs: this.lastVideoPts };
    }
    if (!this.wallAnchor) return 0;
    return this.wallAnchor.ptsUs / 1e6 + (performance.now() / 1000 - this.wallAnchor.t0);
  }

  /* Call from a user gesture (click/keypress) to enable audio; re-anchors the
     audio clock so video syncs to the audio context from that point on. */
  resumeAudio() {
    this._ensureAudioCtx();
    if (this._actx && this._actx.state === 'suspended') {
      this._actx.resume().then(() => {
        this.audioAnchor = null;
        this.nextAudioTime = 0;
        // discard any decoder backlog so audio restarts at the live edge
        if (this.audioDecoder) { try { this.audioDecoder.close(); } catch (_) {} this.audioDecoder = null; }
        this.newestAudioPts = null;
      }).catch(() => {});
    }
  }

  _ahead() {
    if (this.lastVideoPts == null) return 0;
    return this.lastVideoPts / 1e6 - this._clock();
  }

  startRenderLoop() {
    if (this._raf) return;
    const tick = () => {
      if (!this.running) { this._raf = null; return; }
      let clock = this._clock();
      // wall-clock underrun (startup latency, catch-up skip): if the clock ran
      // ahead of available content, resync it to the next frame. Never touch
      // the clock while audio is the master.
      if (this.videoQ.length && this.videoQ[0].pts / 1e6 > clock + 0.5 &&
          !(this.audioActive && this.audioAnchor && this._actx && this._actx.state === 'running')) {
        this.wallAnchor = { t0: performance.now() / 1000, ptsUs: this.videoQ[0].pts };
        clock = this._clock();
      }
      let drawn = null;
      while (this.videoQ.length && this.videoQ[0].pts / 1e6 <= clock + 0.03) {
        if (drawn) drawn.frame.close();
        drawn = this.videoQ.shift();
      }
      if (drawn) { this._blit(drawn.frame); drawn.frame.close(); }
      if (this.opts.onStats) this.opts.onStats({ ahead: this._ahead(), bufferedFrames: this.videoQ.length });
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _blit(frame) {
    const c = this.canvas;
    if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
      c.width = frame.displayWidth;
      c.height = frame.displayHeight;
    }
    this.g2d.drawImage(frame, 0, 0);
  }

  /* ── fetch helpers ── */

  async _text(url) {
    const r = await fetch(this.opts.relayAll ? this.opts.relay(url) : url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for playlist');
    return r.text();
  }

  async _buf(url) {
    const r = await fetch(this.opts.relayAll ? this.opts.relay(url) : url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for segment');
    return r.arrayBuffer().then(b => new Uint8Array(b));
  }
}
