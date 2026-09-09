// streamhub-token — Cloudflare Worker (module worker, source of truth)
// - GET /token?stream_id=N  -> { ok, url, exp, refresh_in, stream_id, edge }
//     v2: discovery dinamica edge (p6/p5/7nyaler/1nyaler) invece di EDGE fisso 7nyaler.
// - /presence  (POST heartbeat {id,channel}, GET ?channel=) via Durable Object PresenceDO
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PLAYER_URL = 'https://prohostmedia.top/embed/player?stream=1';
const PLAYER_REFERER = 'https://www.partite.cc/';
const PANEL_URL = 'https://panel.streamhostingcdn.top/api/auth/get-stream-token';
const PANEL_ORIGIN = 'https://prohostmedia.top';
const EDGES = [
  'https://p6.streamhostingcdn.top',
  'https://p5.streamhostingcdn.top',
  'https://7nyaler.streamhostingcdn.top',
  'https://1nyaler.streamhostingcdn.top',
];
const PRESENCE_TTL_MS = 90_000;
const PRESENCE_MAX = 500;

let proofCache = null;             // { value, exp }
const tokenCache = new Map();      // id -> { token, exp, refresh_in }
const inflight = new Map();        // id -> Promise
const edgeCache = new Map();       // id -> { edge, at } (15 min)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// Prova un edge: segue i redirect e ritorna l'origin finale + status.
async function probeEdge(edge, id, token, exp) {
  const u = edge + '/stream/' + id + '/index.m3u8?token=' + encodeURIComponent(token) + '&exp=' + exp;
  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, Referer: PLAYER_REFERER },
      redirect: 'follow',
    });
    let finalEdge = edge;
    try { finalEdge = new URL(res.url).origin; } catch {}
    return { edge: finalEdge, status: res.status };
  } catch (e) {
    return { edge, status: 0, error: String(e) };
  }
}

// Trova l'edge vivo per questo stream (primo che risponde 200 dopo i redirect).
// Cache 15 min per id. Se nessun edge risponde 200, fallback al primo (legacy).
async function findEdge(id, token, exp) {
  const now = Date.now();
  const cached = edgeCache.get(id);
  if (cached && now - cached.at < 15 * 60 * 1000) return cached.edge;
  const results = await Promise.all(EDGES.map((edge) => probeEdge(edge, id, token, exp)));
  const pick = results.find((r) => r.status === 200);
  const chosen = (pick && pick.edge) || EDGES[0];
  edgeCache.set(id, { edge: chosen, at: now });
  return chosen;
}

export class PresenceDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ids = new Map();
  }
  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    for (const [id, rec] of this.ids) {
      if (now - rec.lastSeen > PRESENCE_TTL_MS) this.ids.delete(id);
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || 'anon').slice(0, 64);
      const channel = String(body.channel || '').slice(0, 64);
      this.ids.set(id, { lastSeen: now, channel });
      if (this.ids.size > PRESENCE_MAX) {
        const oldest = [...this.ids.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        while (this.ids.size > PRESENCE_MAX) this.ids.delete(oldest.shift()[0]);
      }
      return json({ ok: true, online: this.ids.size });
    }
    const channel = url.searchParams.get('channel') || '';
    let count = this.ids.size;
    if (channel) {
      count = 0;
      for (const rec of this.ids.values()) if (rec.channel === channel) count++;
    }
    return json({ ok: true, online: count, total: this.ids.size, channel: channel || null });
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }
  if (url.pathname.startsWith('/presence')) {
    const id = env.PRESENCE.idFromName('global');
    const stub = env.PRESENCE.get(id);
    return stub.fetch(request);
  }
  if (url.pathname !== '/token') return json({ ok: false, error: 'not_found' }, 404);
  const id = String(url.searchParams.get('stream_id') || '');
  if (!/^\d+$/.test(id)) return json({ ok: false, error: 'bad_stream_id' }, 400);
  try {
    const t = await getToken(id);
    const edge = await findEdge(id, t.token, t.exp);
    const streamUrl = edge + '/stream/' + id + '/index.m3u8?token=' + encodeURIComponent(t.token) + '&exp=' + t.exp;
    return json({ ok: true, url: streamUrl, exp: t.exp, refresh_in: t.refresh_in, stream_id: id, edge });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
