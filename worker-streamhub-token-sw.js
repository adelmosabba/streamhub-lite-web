// streamhub-token — Cloudflare Worker
// Firma gli stream ARK (7nyaler.streamhostingcdn.top) per StreamHub LITE.
// Endpoint: GET /token?stream_id=N -> { ok:true, url, exp, refresh_in }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PLAYER_URL = 'https://prohostmedia.top/embed/player?stream=1';
const PLAYER_REFERER = 'https://www.partite.cc/';
const PANEL_URL = 'https://panel.streamhostingcdn.top/api/auth/get-stream-token';
const PANEL_ORIGIN = 'https://prohostmedia.top';
const EDGE = 'https://7nyaler.streamhostingcdn.top';

let proofCache = null;             // { value, exp }
const tokenCache = new Map();      // id -> { token, exp, refresh_in }
const inflight = new Map();        // id -> Promise

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-store',
    },
  });
}

function decodeJwtExp(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = part.length % 4 ? 4 - (part.length % 4) : 0;
    return JSON.parse(atob(part + '='.repeat(pad))).exp || 0;
  } catch {
    return 0;
  }
}

async function getProof() {
  const now = Math.floor(Date.now() / 1000);
  if (proofCache && proofCache.exp > now + 300) return proofCache.value;
  const res = await fetch(PLAYER_URL, { headers: { 'User-Agent': UA, Referer: PLAYER_REFERER } });
  if (!res.ok) throw new Error('player HTTP ' + res.status);
  const html = await res.text();
  const m = html.match(/"parent_proof":"([^"]+)"/);
  if (!m || !m[1]) throw new Error('no parent_proof in player page');
  proofCache = { value: m[1], exp: decodeJwtExp(m[1]) };
  if (!proofCache.exp) throw new Error('bad parent_proof exp');
  return proofCache.value;
}

async function fetchToken(id) {
  const proof = await getProof();
  const res = await fetch(PANEL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + proof,
      Origin: PANEL_ORIGIN,
      'User-Agent': UA,
    },
    body: JSON.stringify({ stream_id: String(id) }),
  });
  if (res.status === 429) throw new Error('PANEL_RATELIMIT');
  if (!res.ok) throw new Error('panel HTTP ' + res.status);
  const data = await res.json();
  if (!data.token || !data.exp) throw new Error('panel bad body');
  return { token: data.token, exp: Number(data.exp), refresh_in: Math.max(Number(data.refresh_in) || 300, 5) };
}

async function getToken(id) {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(id);
  if (cached && cached.exp > now + 60) return cached;
  if (inflight.has(id)) return inflight.get(id);
  const task = (async () => {
    try {
      const t = await fetchToken(id);
      tokenCache.set(id, t);
      if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value);
      return t;
    } catch (e) {
      const old = tokenCache.get(id);
      if (old && old.exp > now && e.message === 'PANEL_RATELIMIT') return old;
      throw e;
    }
  })();
  inflight.set(id, task);
  try { return await task; } finally { inflight.delete(id); }
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }
    if (url.pathname !== '/token') return json({ ok: false, error: 'not_found' }, 404);
    const id = String(url.searchParams.get('stream_id') || '');
    if (!/^\d+$/.test(id)) return json({ ok: false, error: 'bad_stream_id' }, 400);
    try {
      const t = await getToken(id);
      const streamUrl = EDGE + '/stream/' + id + '/index.m3u8?token=' + encodeURIComponent(t.token) + '&exp=' + t.exp;
      return json({ ok: true, url: streamUrl, exp: t.exp, refresh_in: t.refresh_in, stream_id: id });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
}
