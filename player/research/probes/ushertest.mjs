const query = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {\n' +
  '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }\n' +
  '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }\n' +
  '}';
const r = await fetch('https://gql.twitch.tv/gql', {
  method: 'POST',
  headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
  body: JSON.stringify({ operationName: 'PlaybackAccessToken_Template', query, variables: { isLive: true, login: 'lofigirl', isVod: false, vodID: '', playerType: 'embed' } }),
});
const j = await r.json();
const pat = j.data.streamPlaybackAccessToken;
const qs = new URLSearchParams({ sig: pat.signature, token: pat.value, allow_source: 'true', allow_spectre: 'true', allow_audio_only: 'true', fast_bread: 'true', p: '123' });
for (const origin of ['http://localhost:8123', 'https://teslurk.com']) {
  const res = await fetch('https://usher.ttvnw.net/api/channel/hls/lofigirl.m3u8?' + qs, { headers: { Origin: origin } });
  const t = await res.text();
  console.log('===', origin, res.status);
  for (const [k, v] of res.headers) console.log('  ', k + ':', v);
  console.log('   head:', t.slice(0, 70).replace(/\n/g, ' '));
}
