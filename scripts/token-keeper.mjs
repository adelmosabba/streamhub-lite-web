#!/usr/bin/env node
// token-keeper.mjs — StreamHub LITE
// Rinnova i token ARK (7nyaler.streamhostingcdn.top) per i canali dell'index
// e pubblica tokens.json (mappa stream_id -> {token, exp, refresh_in}).
// Uso: node scripts/token-keeper.mjs tokens.json   (ARK_MAX=n per test parziale)
// - Legge beacon -> index.json (gist) -> estrae ID ARK da URL /stream/<id>/index.m3u8
// - Legge tokens.json esistente (cache): salta gli ID con token ancora valido
// - parent_proof: dalla pagina player prohostmedia (scade ~6h, salvato in tokens.json)
// - POST al pannello con pausa 2.5s (evita rate-limit 429)
// - Su 429 riusa il token valido; altrimenti retry dopo 30s
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BEACON_URL = 'https://gist.githubusercontent.com/adelmosabba/de801ecad18027c1cc8ef1d551d00d5e/raw/beacon.json';
const PLAYER_URL = 'https://prohostmedia.top/embed/player?stream=1';
const PLAYER_REFERER = 'https://www.partite.cc/';
const PANEL_URL = 'https://panel.streamhostingcdn.top/api/auth/get-stream-token';
const PANEL_ORIGIN = 'https://prohostmedia.top';
const OUT_FILE = process.argv[2] || 'tokens.json';
const PAUSE_MS = process.env.PAUSE_MS ? Number(process.env.PAUSE_MS) : 2500;
const MAX = process.env.ARK_MAX ? Number(process.env.ARK_MAX) : Infinity;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeJwtExp(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = part.length % 4 ? 4 - (part.length % 4) : 0;
    return JSON.parse(Buffer.from(part + '='.repeat(pad), 'base64').toString('utf8')).exp || 0;
  } catch { return 0; }
}

async function getIndex() {
  const b = await (await fetch(BEACON_URL + '?ts=' + Date.now(), { cache: 'no-store' })).json();
  const idx = await (await fetch(b.index, { cache: 'no-store' })).json();
  const ark = [];
  for (const c of (idx.channels || [])) {
    const m = (c.url || '').match(/streamhostingcdn\.top\/stream\/(\d+)\//);
    if (m) ark.push({ key: c.key, id: m[1], url: c.url });
  }
  return ark;
}

async function getProof(state) {
  const now = Math.floor(Date.now() / 1000);
  if (state.proof && state.proof.exp && state.proof.exp > now + 300) return state.proof.value;
  const r = await fetch(PLAYER_URL, { headers: { 'User-Agent': UA, 'Referer': PLAYER_REFERER } });
  if (!r.ok) throw new Error('player HTTP ' + r.status);
  const html = await r.text();
  const m = html.match(/"parent_proof":"([^"]+)"/);
  if (!m || !m[1]) throw new Error('no parent_proof in player page');
  state.proof = { value: m[1], exp: decodeJwtExp(m[1]) };
  return m[1];
}

async function fetchToken(id, proof) {
  const r = await fetch(PANEL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + proof,
      'Origin': PANEL_ORIGIN,
      'User-Agent': UA
    },
    body: JSON.stringify({ stream_id: String(id) })
  });
  if (r.status === 429) return { rateLimited: true };
  if (!r.ok) throw new Error('panel HTTP ' + r.status + ' for ' + id);
  const d = await r.json();
  if (!d.token || !d.exp) throw new Error('panel bad body for ' + id);
  return { token: d.token, exp: Number(d.exp), refresh_in: Math.max(Number(d.refresh_in) || 300, 5) };
}

async function main() {
  const arkAll = await getIndex();
  const ark = arkAll.slice(0, MAX);
  console.log('ARK channels:', ark.length + '/' + arkAll.length);
  let state = { proof: null, tokens: {}, updated_at: null };
  if (fs.existsSync(OUT_FILE)) {
    try { state = { proof: null, tokens: {}, updated_at: null, ...JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) }; } catch (e) { console.warn('cache non leggibile, riparto da zero'); }
  }
  const now = Math.floor(Date.now() / 1000);
  let refreshed = 0, skipped = 0, reused = 0; const failed = [];
  for (const ch of ark) {
    const cur = state.tokens[ch.id];
    if (cur && cur.exp && cur.exp > now + 120) { skipped++; continue; }
    try {
      const proof = await getProof(state);
      let t = await fetchToken(ch.id, proof);
      if (t.rateLimited) {
        if (cur && cur.exp > now) { reused++; state.tokens[ch.id] = cur; continue; }
        console.log('429 su ' + ch.id + ' - attendo 30s e riprovo');
        await sleep(30000);
        t = await fetchToken(ch.id, proof);
        if (t.rateLimited) { failed.push(ch.id); continue; }
      }
      state.tokens[ch.id] = { ...t, at: now };
      refreshed++;
    } catch (e) {
      console.error('ERR ' + ch.id + ': ' + e.message);
      failed.push(ch.id);
    }
    await sleep(PAUSE_MS);
  }
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, JSON.stringify(state, null, 2));
  console.log('done: refreshed=' + refreshed + ' skipped=' + skipped + ' reused=' + reused + ' failed=' + failed.length + (failed.length ? ' [' + failed.join(',') + ']' : ''));
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
