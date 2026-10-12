// robust probe of YouTube live googlevideo range protocol
const vid = process.argv[2] || '1-LpQekNa9g';
const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc&prettyPrint=false', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Origin: 'https://www.youtube.com',
    'X-YouTube-Client-Name': '5', 'X-YouTube-Client-Version': '21.02.3',
    'User-Agent': 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  },
  body: JSON.stringify({
    context: { client: { clientName: 'IOS', clientVersion: '21.02.3', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18_3_2', hl: 'en', gl: 'US' } },
    videoId: vid, contentCheckOk: true, racyCheckOk: true,
  }),
});
const j = await r.json();
const vf = (j.streamingData.adaptiveFormats || []).filter(f => f.mimeType.startsWith('video/mp4') && f.height === 360)[0]
  || (j.streamingData.adaptiveFormats || []).filter(f => f.mimeType.startsWith('video/mp4'))[0];
const url = vf.url;
console.log('using itag', vf.itag, vf.width + 'x' + vf.height);
function boxes(buf) {
  const out = []; let off = 0;
  while (off + 8 <= buf.length && out.length < 12) {
    const sz = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (!/^[\x20-\x7e]{4}$/.test(type) || sz < 8 || off + sz > buf.length) break;
    out.push(type + '(' + sz + ')');
    off += sz;
  }
  return out;
}
async function get(label, u) {
  try {
    const rr = await fetch(u);
    const buf = Buffer.from(await rr.arrayBuffer());
    const h = {};
    for (const [k, v] of rr.headers) if (/head-time|segment|walltime|content-range|accept/i.test(k)) h[k] = v;
    console.log(label, 'HTTP', rr.status, 'len', buf.length, JSON.stringify(h), 'boxes:', boxes(buf).join(' '));
    return buf;
  } catch (e) { console.log(label, 'ERR', e.cause?.code || e.message); return null; }
}
const a = await get('A range=0-:', url + '&range=0-');
const b = await get('B range=0- (again):', url + '&range=0-');
if (a && b) console.log('A==B identical?', a.length === b.length && a.subarray(0, 128).equals(b.subarray(0, 128)));
await get('C sq=100:', url + '&sq=100');
await get('D sq=101:', url + '&sq=101');
await get('E range=1900000-:', url + '&range=1900000-');
// wait 6s, then open-ended again — new segment?
await new Promise(res => setTimeout(res, 6000));
const c = await get('C range=0- (after 6s):', url + '&range=0-');
if (a && c) console.log('A==C identical?', a.length === c.length && a.subarray(0, 128).equals(c.subarray(0, 128)));
