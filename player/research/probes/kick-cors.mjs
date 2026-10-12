/* Kick (AWS IVS) CORS probe: master/media/segment with and without Origin */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const play = fs.readFileSync('C:/Users/ds/AppData/Local/Temp/opencode/kick-play.txt', 'utf8').trim();
console.log('master:', play.slice(0, 120));

function curl(url, origin) {
  const args = ['-s', '-D', '-', '-A', UA, url];
  if (origin) args.push('-H', 'Origin: ' + origin);
  const raw = execFileSync('curl.exe', args, { maxBuffer: 1 << 24 }).toString();
  const sep = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  const head = raw.slice(0, sep), body = raw.slice(sep);
  const status = (head.match(/HTTP\/[\d.]+ (\d+)/) || [])[1];
  const acao = (head.match(/access-control-allow-origin: (.+)/i) || [])[1];
  return { status, acao, body };
}

const ORIGIN = 'http://127.0.0.1:8123';
for (const label of ['no-origin', 'with-origin']) {
  const o = label === 'with-origin' ? ORIGIN : null;
  const m = curl(play, o);
  console.log(`master ${label}: ${m.status} acao=${m.acao}`);
  if (m.status !== '200') { console.log('  body:', m.body.slice(0, 200)); continue; }
  // first variant URI
  const lines = m.body.split('\n').map(l => l.trim()).filter(Boolean);
  const variant = lines.find(l => !l.startsWith('#'));
  if (!variant) { console.log('  no variant', m.body.slice(0, 300)); continue; }
  const vurl = new URL(variant, play).href;
  const v = curl(vurl, o);
  console.log(`  media ${label}: ${v.status} acao=${v.acao}`);
  const vlines = v.body.split('\n').map(l => l.trim()).filter(Boolean);
  const seg = vlines.find(l => !l.startsWith('#'));
  if (!seg) { console.log('  no seg', v.body.slice(0, 300)); continue; }
  const surl = new URL(seg, vurl).href;
  const s = curl(surl, o);
  console.log(`  seg   ${label}: ${s.status} acao=${s.acao} bytes=${s.body.length}`);
  console.log('  segUrl:', surl.slice(0, 110));
}
