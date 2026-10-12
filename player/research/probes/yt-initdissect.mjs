// dissect the live init segment: replicate Fmp4Demuxer._track parsing, print where it bails
const vid = process.argv[2] || '1-LpQekNa9g';
const j = await (await fetch('http://127.0.0.1:8124/yt/' + vid)).json();
const rr = await fetch('http://127.0.0.1:8124/relay?raw=1&url=' + encodeURIComponent(j.videoUrl + '&range=0-'));
const buf = Buffer.from(await rr.arrayBuffer());
console.log('resp', rr.status, buf.length);
function u32(b, o) { return b.readUInt32BE(o); }
function ty(b, o) { return b.toString('latin1', o + 4, o + 8); }
// top-level boxes
let off = 0; const initParts = [];
while (off + 8 <= buf.length) {
  const sz = u32(buf, off), t = ty(buf, off);
  if (sz < 8 || off + sz > buf.length) { console.log('BAD box at', off, t, sz); break; }
  console.log('top:', t, sz);
  if (t === 'ftyp' || t === 'moov') initParts.push(buf.subarray(off, off + sz));
  off += sz;
}
const init = Buffer.concat(initParts);
// walk moov like _walk does
function walk(b, from, to, depth) {
  let o = from;
  while (o + 8 <= to) {
    const sz = u32(b, o), t = ty(b, o);
    if (sz < 8 || o + sz > to) { console.log(' '.repeat(depth * 2), 'BAD', t, sz, 'at', o, 'to', to); break; }
    console.log(' '.repeat(depth * 2), t, '(' + sz + ')');
    if (t === 'trak') {
      // replicate _track
      let trackId = 0, handler = '', timescale = 1, stsd = null;
      const tw = (bb, f, tt) => {
        let q = f;
        while (q + 8 <= tt) {
          const s2 = u32(bb, q), t2 = ty(bb, q);
          if (s2 < 8 || q + s2 > tt) { console.log(' '.repeat((depth + 1) * 2), 'BAD-in-trak', t2, s2); break; }
          if (t2 === 'tkhd') {
            const ver = bb[q + 8];
            trackId = ver === 1 ? u32(bb, q + 20) : u32(bb, q + 12);
            console.log(' '.repeat((depth + 1) * 2), 'tkhd ver=' + ver + ' trackId=' + trackId);
          } else if (t2 === 'hdlr') {
            handler = String.fromCharCode(bb[q + 16], bb[q + 17], bb[q + 18], bb[q + 19]);
            console.log(' '.repeat((depth + 1) * 2), 'hdlr handler=' + handler + ' bytes16-19=' + bb.subarray(q + 12, q + 24).toString('hex'));
          } else if (t2 === 'mdhd') {
            const ver = bb[q + 8];
            timescale = ver === 1 ? u32(bb, q + 20) : u32(bb, q + 12);
            console.log(' '.repeat((depth + 1) * 2), 'mdhd ver=' + ver + ' timescale=' + timescale);
          } else if (t2 === 'stsd') {
            stsd = bb.subarray(q, q + s2);
            console.log(' '.repeat((depth + 1) * 2), 'stsd size=' + s2);
          } else if (t2 === 'mdia' || t2 === 'minf' || t2 === 'stbl') tw(bb, q + 8, q + s2);
          q += s2;
        }
      };
      tw(b, o + 8, o + sz);
      console.log(' '.repeat(depth * 2), '=> trackId=' + trackId + ' handler=' + handler + ' timescale=' + timescale + ' stsd=' + (stsd ? 'yes' : 'NO'));
      if (stsd) {
        // _parseStsd
        let p = 8;
        const esz = u32(stsd, p), ef = ty(stsd, p);
        console.log(' '.repeat(depth * 2), 'stsd entry:', ef, esz);
        const entry = stsd.subarray(p, p + esz);
        let eo = 8;
        while (eo + 8 <= entry.length) {
          const s3 = u32(entry, eo), t3 = ty(entry, eo);
          if (s3 < 8) { console.log(' '.repeat(depth * 2), 'stsd sub BAD', t3, s3); break; }
          console.log(' '.repeat(depth * 2), '  sub:', t3, s3);
          eo += s3;
        }
      }
    }
    else if (t === 'moov' || t === 'mdia' || t === 'minf' || t === 'stbl') walk(b, o + 8, o + sz, depth + 1);
    o += sz;
  }
}
walk(init, 0, init.length, 0);
