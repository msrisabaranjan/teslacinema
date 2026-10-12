// replicate the engine's poll pattern against the local relay, log every response
const vid = process.argv[2] || '1-LpQekNa9g';
const j = await (await fetch('http://127.0.0.1:8124/yt/' + vid)).json();
if (!j.videoUrl) { console.log('resolve failed:', j.error); process.exit(1); }
console.log('resolved itag', j.itag, j.height + 'p');
async function poll(label, url, i) {
  const rr = await fetch('http://127.0.0.1:8124/relay?raw=1&url=' + encodeURIComponent(url + '&range=0-'));
  const buf = Buffer.from(await rr.arrayBuffer());
  let boxes = '';
  if (buf.length > 100) {
    let off = 0; const b = [];
    while (off + 8 <= buf.length && b.length < 6) {
      const sz = buf.readUInt32BE(off); const ty = buf.toString('latin1', off + 4, off + 8);
      if (sz < 8 || off + sz > buf.length) break;
      b.push(ty + '(' + sz + ')'); off += sz;
    }
    boxes = b.join(' ');
  }
  console.log(label, '#' + i, 'HTTP', rr.status, 'len', buf.length, boxes);
  return buf;
}
// video poll every 300ms x10, audio poll every 300ms x10 (like the engine)
const vUrl = j.videoUrl, aUrl = j.audioUrl;
for (let i = 1; i <= 10; i++) {
  await poll('V', vUrl, i);
  if (aUrl) await poll('A', aUrl, i);
  await new Promise(r => setTimeout(r, 300));
}
