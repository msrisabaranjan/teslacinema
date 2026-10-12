// inspect sparams/sig on live format URLs + audio format fields
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
for (const f of j.streamingData.adaptiveFormats) {
  const u = new URL(f.url);
  if (f.mimeType.startsWith('video')) {
    console.log('v itag', f.itag, f.width + 'x' + f.height, f.mimeType.replace('video/mp4; codecs=', ''), 'fps', f.fps, 'bitrate', f.bitrate);
  }
}
const f = j.streamingData.adaptiveFormats[0];
const u = new URL(f.url);
console.log('sparams =', u.searchParams.get('sparams'));
console.log('ip param =', u.searchParams.get('ip'));
console.log('host =', u.hostname);
const af = j.streamingData.adaptiveFormats.filter(f => f.mimeType.startsWith('audio/mp4'))[0];
console.log('audio itag', af.itag, af.mimeType, 'channels', af.audioChannels, 'bitrate', af.bitrate);
// does dropping the ip param still work? (if ip not signed)
const u2 = new URL(f.url);
u2.searchParams.delete('ip');
const rr = await fetch(u2.toString() + '&range=0-');
console.log('url without ip param: HTTP', rr.status, 'len', (await rr.arrayBuffer()).byteLength);
