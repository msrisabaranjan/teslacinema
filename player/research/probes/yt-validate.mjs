// validate every video sample's NAL structure from live polls; dump moof/tfdt/mdat accounting
import fs from 'node:fs';
const src = fs.readFileSync('D:/Experiments/AI/TCinema/player/engine.js', 'utf8');
const { Fmp4Demuxer, firstTfdt, concatBytes, sameBytes } = new Function(
  'window', 'document', 'performance',
  src + '\nreturn { Fmp4Demuxer, firstTfdt, concatBytes, sameBytes };'
)(undefined, undefined, { now: () => Date.now() });

const vid = process.argv[2] || '1-LpQekNa9g';
const h = Number(process.argv[3] || 480);
const j = await (await fetch(`http://127.0.0.1:8124/yt/${vid}?h=${h}`)).json();
if (!j.videoUrl) { console.log('resolve failed:', j.error); process.exit(1); }
console.log('picked itag', j.itag, j.height + 'p');

function boxes(buf) {
  const out = []; let off = 0;
  while (off + 8 <= buf.length) {
    const sz = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
    const ty = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (sz < 8 || off + sz > buf.length) break;
    out.push({ ty, sz, off }); off += sz;
  }
  return out;
}

// NAL walk validator (AVCC, lenSize from avcC)
function walkNals(sample, lenSize) {
  let o = 0, nals = 0, bad = null;
  while (o + lenSize <= sample.length) {
    let sz = 0;
    for (let i = 0; i < lenSize; i++) sz = sz * 256 + sample[o + i];
    o += lenSize;
    if (sz <= 0 || o + sz > sample.length) { bad = `nal ${nals}: len ${sz} at ${o}/${sample.length}`; break; }
    const t = sample[o] & 0x1f;
    if (t === 0) { bad = `nal ${nals}: type 0 at ${o}`; break; }
    nals++; o += sz;
  }
  return { nals, bad, trailing: sample.length - o };
}

let lenSize = 4;
const stats = { samples: 0, badSamples: [], keys: 0 };
const dm = new Fmp4Demuxer({
  onVideoConfig: c => { lenSize = c.lenSize; console.log('cfg', c.codec, 'lenSize', lenSize); },
  onAudioConfig: () => {},
  onVideo: (d, us, key) => {
    stats.samples++;
    if (key) stats.keys++;
    const w = walkNals(d, lenSize);
    if (w.bad || w.trailing !== 0) stats.badSamples.push({ pts: us / 1e6, size: d.length, ...w });
  },
  onAudio: () => {},
});

let lastInit = null, lastTfdt = null;
for (let i = 0; i < 10; i++) {
  const rr = await fetch('http://127.0.0.1:8124/relay?raw=1&url=' + encodeURIComponent(j.videoUrl + '&range=0-'));
  const buf = Buffer.from(await rr.arrayBuffer());
  const bs = boxes(buf);
  const desc = bs.map(b => b.ty + '(' + b.sz + ')').join(' ');
  const initParts = bs.filter(b => b.ty === 'ftyp' || b.ty === 'moov').map(b => buf.subarray(b.off, b.off + b.sz));
  const mediaParts = bs.filter(b => b.ty !== 'ftyp' && b.ty !== 'moov').map(b => buf.subarray(b.off, b.off + b.sz));
  const media = concatBytes(mediaParts);
  const tf = firstTfdt(media);
  console.log(`poll#${i} ${rr.status} ${buf.length}B [${desc}] tfdt=${tf} ${tf === lastTfdt ? 'DUP' : 'NEW'}`);
  const init = concatBytes(initParts);
  if (init.length && (!lastInit || !sameBytes(init, lastInit))) { dm.setInit(init); lastInit = init; }
  if (media.length && tf !== lastTfdt) { lastTfdt = tf; dm.push(media); }
  await new Promise(r => setTimeout(r, 1600));
}
console.log('samples', stats.samples, 'keys', stats.keys, 'bad', stats.badSamples.length);
for (const b of stats.badSamples.slice(0, 8)) console.log('BAD', JSON.stringify(b));
