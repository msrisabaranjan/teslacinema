// dump tfhd/trun/tfdt details from a real live moof so the demuxer fix is evidence-based
const vid = process.argv[2] || '1-LpQekNa9g';
const j = await (await fetch('http://127.0.0.1:8124/yt/' + vid)).json();
const rr = await fetch('http://127.0.0.1:8124/relay?raw=1&url=' + encodeURIComponent(j.videoUrl + '&range=0-'));
const buf = Buffer.from(await rr.arrayBuffer());
console.log('resp', rr.status, buf.length);
const u32 = (b, o) => b.readUInt32BE(o);
const ty = (b, o) => b.toString('latin1', o + 4, o + 8);
let off = 0;
while (off + 8 <= buf.length) {
  const sz = u32(buf, off), t = ty(buf, off);
  if (sz < 8 || off + sz > buf.length) break;
  if (t === 'moof') {
    const moof = buf.subarray(off, off + sz);
    let o = 8;
    while (o + 8 <= moof.length) {
      const s2 = u32(moof, o), t2 = ty(moof, o);
      if (s2 < 8 || o + s2 > moof.length) break;
      if (t2 === 'traf') {
        const traf = moof.subarray(o, o + s2);
        let q = 8;
        while (q + 8 <= traf.length) {
          const s3 = u32(traf, q), t3 = ty(traf, q);
          if (s3 < 8 || q + s3 > traf.length) break;
          const b = traf.subarray(q, q + s3);
          const ver = b[8], flags = (b[9] << 16) | (b[10] << 8) | b[11];
          if (t3 === 'tfhd') {
            console.log('tfhd ver=' + ver + ' flags=0x' + flags.toString(16) + ' trackId=' + u32(b, 12));
            let p = 16;
            if (flags & 0x01) { console.log('  base_data_offset=', Number(b.readBigUInt64BE(p))); p += 8; }
            if (flags & 0x02) { console.log('  sample_desc_idx=', u32(b, p)); p += 4; }
            if (flags & 0x08) { console.log('  default_dur=', u32(b, p)); p += 4; }
            if (flags & 0x10) { console.log('  default_size=', u32(b, p)); p += 4; }
            if (flags & 0x20) { console.log('  default_flags=0x' + u32(b, p).toString(16)); p += 4; }
          } else if (t3 === 'tfdt') {
            console.log('tfdt ver=' + ver + ' baseDecode=' + (ver === 1 ? b.readBigUInt64BE(12) : u32(b, 12)));
          } else if (t3 === 'trun') {
            console.log('trun ver=' + ver + ' flags=0x' + flags.toString(16) + ' count=' + u32(b, 12));
            let p = 16;
            if (flags & 0x01) { console.log('  data_offset=', u32(b, p)); p += 4; }
            if (flags & 0x04) { console.log('  first_sample_flags=0x' + u32(b, p).toString(16)); p += 4; }
            const dur = flags & 0x100, szf = flags & 0x200, flf = flags & 0x400, ctsf = flags & 0x800;
            for (let i = 0; i < Math.min(3, u32(b, 12)); i++) {
              let d = 0, s = 0, f = 0, c = 0;
              if (dur) { d = u32(b, p); p += 4; }
              if (szf) { s = u32(b, p); p += 4; }
              if (flf) { f = u32(b, p); p += 4; }
              if (ctsf) { c = u32(b, p); p += 4; }
              console.log('  sample[' + i + '] dur=' + d + ' size=' + s + ' flags=0x' + f.toString(16) + ' cts=' + c +
                ' depends=' + ((f >>> 28) & 3) + ' nonSync=' + ((f >>> 24) & 1));
            }
          }
          q += s3;
        }
      }
      o += s2;
    }
  }
  off += sz;
}
