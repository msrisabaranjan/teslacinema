// check which candidate videoIds are currently live via watch page
const ids = ['1-LpQekNa9g', 'rFZHOHl-L8A', 'JD-kMIpDfnY', 'IPg9DRpm9xQ', 'blAFxjhg62k', '7NOSDKb0HlU', 'E2vONfzoyRI', '5yx6BWlEVcY'];
for (const id of ids) {
  const r = await fetch('https://www.youtube.com/watch?v=' + id, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  const html = await r.text();
  const live = /"isLiveNow":true/.test(html);
  const hls = (html.match(/"hlsManifestUrl":"([^"]+)"/) || [])[1];
  console.log(id, 'HTTP', r.status, 'isLiveNow:', live, 'pageHls:', hls ? 'yes' : 'no',
    (html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/) || [])[1] || '');
  if (live && hls) { console.log('  HLS:', hls.slice(0, 130)); break; }
}
