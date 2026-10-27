// CineStream — Pluto TV manifest proxy.
//
// Why this exists: Pluto's channel API and stitcher playlists pin
// `Access-Control-Allow-Origin` to pluto.tv, so a browser on another origin
// cannot read them. The media segments themselves (siloh-ns1.plutotv.net) are
// already `*`, so only the small JSON/playlist hops go through here.
//
// Routing (path style keeps every relative URI inside the proxy namespace):
//   https://<worker>/p/<host>/<path>?<query>  ->  https://<host>/<path>?<query>
//
// Deploy:
//   npm i -g wrangler
//   wrangler deploy
//
// Then put the printed URL in live.html:
//   <script>window.CINESTREAM_PLUTO_PROXY = 'https://<worker>.workers.dev';</script>

const HOSTS = /^([a-z0-9-]+\.)*(pluto\.tv|plutotv\.net)$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
};

const PASS = ['content-type', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified'];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!url.pathname.startsWith('/p/')) {
      return new Response('cinestream pluto proxy\nuse /p/<host>/<path>', {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const rest = url.pathname.slice(3) + url.search;
    const cut = rest.indexOf('/');
    if (cut < 1) {
      return new Response('bad target', { status: 400, headers: CORS });
    }

    const host = rest.slice(0, cut);
    if (!HOSTS.test(host)) {
      return new Response('host not allowed', { status: 403, headers: CORS });
    }

    const target = `https://${host}${rest.slice(cut)}`;
    const headers = new Headers({ referer: 'https://pluto.tv/' });
    for (const name of ['range', 'accept', 'user-agent']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        redirect: 'follow'
      });
    } catch (error) {
      return new Response(`upstream error: ${error.message}`, { status: 502, headers: CORS });
    }

    const out = new Headers(CORS);
    for (const name of PASS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }

    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
};
