const query = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {\n' +
  '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }\n' +
  '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }\n' +
  '}';
const r = await fetch('https://gql.twitch.tv/gql', {
  method: 'POST',
  headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
  body: JSON.stringify({ operationName: 'PlaybackAccessToken_Template', query, variables: { isLive: true, login: 'lofigirl', isVod: false, vodID: '', playerType: 'embed' } }),
});
const t = await r.text();
console.log('status', r.status);
console.log(t.slice(0, 500));
