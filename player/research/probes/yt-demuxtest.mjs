// offline test of the fixed Fmp4Demuxer against real YouTube live bytes
import fs from 'node:fs';
const src = fs.readFileSync('D:/Experiments/AI/TCinema/player/engine.js', 'utf8');
const { Fmp4Demuxer, firstTfdt, concatBytes, sameBytes } = new Function(
  'window', 'document', 'performance',
  src + '\nreturn { Fmp4Demuxer, firstTfdt, concatBytes, sameBytes };'
)(undefined, undefined, { now: () => Date.now() });

const vid = process.argv[2] || '1-LpQekNa9g';
const j = await (await fetch('http://127.0.0.1:8124/yt/' + vid)).json();
if (!j.videoUrl) { console.log('resolve failed:', j.error); process.exit(1); }

function split(buf) {
  let off = 0; const initParts = [], mediaParts = [];
  while (off + 8 <= buf.length) {
    const sz = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
    const ty = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (sz < 8 || off + sz > buf.length) break;
    (ty === 'ftyp' || ty === 'moov' ? initParts : mediaParts).push(buf.subarray(off, off + sz));
    off += sz;
  }
  return { init: concatBytes(initParts), media: concatBytes(mediaParts) };
}

async function run(label, url) {
  let configs = 0, samples = 0, keys = 0, firstPts = null, lastPts = null, sizes = 0;
  const dm = new Fmp4Demuxer({
    onVideoConfig: c => { configs++; console.log(label, 'VIDEO config:', c.codec, 'lenSize', c.lenSize, 'desc', c.description.length + 'B'); },
    onAudioConfig: c => { configs++; console.log(label, 'AUDIO config:', c.codec, 'asc', Array.from(c.description).map(x => x.toString(16)).join(' ')); },
    onVideo: (d, us, key) => { samples++; if (key) keys++; if (firstPts == null) firstPts = us; lastPts = us; sizes += d.length; },
    onAudio: (d, us) => { samples++; if (firstPts == null) firstPts = us; lastPts = us; sizes += d.length; },
  });
  let lastInit = null, lastTfdt = null, polls = 0, newSegs = 0;
  for (let i = 0; i < 6; i++) {
    const rr = await fetch('http://127.0.0.1:8124/relay?raw=1&url=' + encodeURIComponent(url + '&range=0-'));
    const buf = Buffer.from(await rr.arrayBuffer());
    polls++;
    const { init, media } = split(buf);
    if (!init.length || !media.length) { console.log(label, 'poll', i, 'no init/media', buf.length); continue; }
    if (!lastInit || !sameBytes(init, lastInit)) { dm.setInit(init); lastInit = init; }
    const tf = firstTfdt(media);
    if (tf !== null && tf === lastTfdt) { await new Promise(r => setTimeout(r, 1500)); continue; }
    lastTfdt = tf; newSegs++;
    dm.push(media);
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(label, { polls, newSegs, configs, samples, keys, firstPts, lastPts,
    durSec: firstPts != null ? ((lastPts - firstPts) / 1e6).toFixed(2) : null,
    bytes: sizes });
}

await run('V', j.videoUrl);
if (j.audioUrl) await run('A', j.audioUrl);
