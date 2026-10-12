// dump IOS player response structure for a live video
const vid = process.argv[2] || '1-LpQekNa9g';
const IOS_KEY = 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc';
const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + IOS_KEY + '&prettyPrint=false', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)' },
  body: JSON.stringify({
    context: { client: { clientName: 'IOS', clientVersion: '21.02.3', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18_3_2', hl: 'en', gl: 'US' } },
    videoId: vid, contentCheckOk: true, racyCheckOk: true,
  }),
});
const j = await r.json();
console.log('top keys:', Object.keys(j).join(', '));
const sd = j.streamingData || {};
console.log('streamingData keys:', Object.keys(sd).join(', '));
for (const k of Object.keys(sd)) {
  if (Array.isArray(sd[k])) {
    console.log(k, 'count:', sd[k].length);
    for (const f of sd[k].slice(0, 3))
      console.log('  itag', f.itag, f.mimeType, f.width + 'x' + f.height, f.fps, 'hasSig:', !!f.signatureCipher, 'hasUrl:', !!f.url, f.qualityLabel || '');
  } else console.log(k, '=', String(sd[k]).slice(0, 150));
}
console.log('playability:', JSON.stringify(j.playabilityStatus).slice(0, 200));
