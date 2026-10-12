/* probe Kick channel endpoints via curl (TLS fingerprint) and report live status */
import { execFileSync } from 'node:child_process';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const slugs = ['adinross', 'rossfry', 's1lva', 'ispybender', 'w3irdscience', 'trainwreck', 'caseoh_', 'stake', 'mossgoyard', 'justahtan', 'amouranth', 'shroud', 'xqc', 'necros','theotermccartney','buddha','solidaritygaming','dnf4life','lirik','timthetato'];
for (const s of slugs) {
  let raw;
  try {
    raw = execFileSync('curl.exe', ['-s', '-A', UA, 'https://kick.com/api/v2/channels/' + s], { maxBuffer: 1 << 24 }).toString();
  } catch (e) { console.log(s, 'curl fail'); continue; }
  let j;
  try { j = JSON.parse(raw); } catch { console.log(s, 'non-json', raw.slice(0, 60)); continue; }
  const ls = j.livestream;
  if (ls && ls.playback_url) {
    console.log(s, 'LIVE', ls.viewer_count, ls.playback_url);
    process.stdout.write('SAVED ' + s + '\n');
    const fs = await import('node:fs');
    fs.writeFileSync('C:/Users/ds/AppData/Local/Temp/opencode/kick-live.json', JSON.stringify({ slug: s, id: j.id, play: ls.playback_url }));
    break;
  } else {
    console.log(s, j.message !== undefined ? 'blocked(msg)' : 'offline');
  }
}
