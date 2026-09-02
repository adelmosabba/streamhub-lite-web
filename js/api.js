'use strict';
// Client API "lite": legge index.json dal beacon (Gist) invece di API server.
// Interfaccia compatibile con il frontend v2 (Api.events/channels/sports/days/epg/token).
const BEACON_URL = 'https://gist.githubusercontent.com/adelmosabba/de801ecad18027c1cc8ef1d551d00d5e/raw/beacon.json';
const CACHE_TTL_MS = 4 * 3600 * 1000;

// ---- Token ARK (streamhostingcdn.top) ----
// tokens.json e' pubblicato dal keeper GitHub Actions sul branch "tokens".
// Il client legge SOLO il file statico (CORS ok su raw.githubusercontent).
const TOKENS_URL = 'https://raw.githubusercontent.com/adelmosabba/streamhub-lite-web/tokens/tokens.json';
const ARK_RE = /streamhostingcdn\.top\/stream\/(\d+)\//;
const _arkCache = new Map();      // channel -> { url, exp, refresh_in }
const _tokensState = { data: null, loadedAt: 0 };

async function loadArkTokens(force) {
  const now = Date.now();
  if (_tokensState.data && !force && now - _tokensState.loadedAt < 120000) return _tokensState.data;
  try {
    const r = await fetch(TOKENS_URL + '?ts=' + now, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _tokensState.data = await r.json();
    _tokensState.loadedAt = now;
  } catch (e) { /* usa cache vecchia se presente */ }
  return _tokensState.data;
}


// Durata media stimata per sport (minuti) per calcolare fine evento e stato live lato client.
const SPORT_DUR_MIN = {
  calcio:125, basket:135, tennis:150, motori:120, volley:105, rugby:110,
  atletica:150, nuoto:150, golf:240, ciclismo:240, boxe:120, hockey:120,
  baseball:180, darts:120, football:190, pallamano:105, futsal:105, floorball:105
};
function estDurationMin(sport) { return SPORT_DUR_MIN[sport] || 120; }

// Stato evento calcolato CLIENT-side (il server aggiorna 1 volta/giorno).
// live  = adesso dentro [start, start+durata)
// past  = adesso >= start+durata
// upcoming = adesso < start
function clientStatus(e, nowMs) {
  const st = new Date(e.start_time).getTime();
  if (isNaN(st)) return 'upcoming';
  const dur = (e.duration_min || estDurationMin(e.sport)) * 60000;
  if (nowMs >= st + dur) return 'finished';
  if (nowMs >= st) return 'live';
  return 'upcoming';
}

const _state = { idx: null, loadedAt: 0 };

async function loadIndex(force) {
  if (_state.idx && !force && Date.now() - _state.loadedAt < CACHE_TTL_MS) return _state.idx;
  let indexUrl = localStorage.getItem('shl.indexUrl') || '';
  try {
    const b = await (await fetch(BEACON_URL + '?ts=' + Date.now(), { cache: 'no-cache' })).json();
    if (b && b.index) { indexUrl = b.index; localStorage.setItem('shl.indexUrl', indexUrl); }
  } catch (e) { /* fallback su cache locale */ }
  if (!indexUrl) throw new Error('beacon irraggiungibile');
  const res = await fetch(indexUrl + (indexUrl.includes('?') ? '&' : '?') + 'ts=' + Date.now(), { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' index');
  _state.idx = await res.json();
  _state.loadedAt = Date.now();
  return _state.idx;
}

function localDateStr(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const Api = {
  async events(params) {
    const idx = await loadIndex();
    const p = params || {};
    const nowMs = Date.now();
    let list = (idx.events || []).map(e => {
      const status = clientStatus(e, nowMs);
      const st = new Date(e.start_time).getTime();
      const dur = (e.duration_min || estDurationMin(e.sport)) * 60000;
      return { ...e, status, end_time: (isNaN(st) ? null : new Date(st + dur).toISOString()) };
    });
    if (p.date) list = list.filter(e => localDateStr(e.start_time) === p.date);
    // since/fino: finestra date (per unire i live di ieri nella tab OGGI)
    if (p.since) list = list.filter(e => localDateStr(e.start_time) >= p.since);
    if (p.fino) list = list.filter(e => localDateStr(e.start_time) <= p.fino);
    if (p.hidePast !== false) list = list.filter(e => e.status !== 'finished');
    if (p.sport) list = list.filter(e => (e.sport || '') === p.sport);
    if (p.search) {
      const q = p.search.toLowerCase();
      list = list.filter(e => [e.home, e.away, e.league].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (p.has_stream === '1') list = list.filter(e => e.channel_keys && e.channel_keys.length);
    list = list.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    if (p.limit) list = list.slice(0, Number(p.limit));
    return { ok: true, events: list };
  },
  async channels(params) {
    const idx = await loadIndex();
    let list = idx.channels || [];
    const p = params || {};
    if (p.country) list = list.filter(c => c.country === p.country);
    if (p.sport) list = list.filter(c => (c.sport || '') === p.sport);
    if (p.search) {
      const q = p.search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q));
    }
    return { ok: true, channels: list };
  },
  async sports() {
    const idx = await loadIndex();
    const map = {};
    for (const e of idx.events || []) {
      const s = e.sport || 'altro';
      map[s] = (map[s] || 0) + 1;
    }
    const sports = Object.keys(map).sort().map(s => ({ sport: s, count: map[s] }));
    return { ok: true, sports };
  },
  async days() { return { ok: true, days: [] }; },
  async epg(params) {
    const idx = await loadIndex();
    const raw = (idx.epg && idx.epg[params && params.channel]) || [];
    const now = Date.now();
    const programs = raw.map(p => {
      const st = new Date(p.start_time || p.start).getTime();
      const en = new Date(p.end_time || p.end).getTime();
      let live_flag = '';
      if (!isNaN(st) && !isNaN(en)) {
        if (st <= now && en > now) live_flag = 'live';
        else if (en <= now) live_flag = 'replay';
      }
      return {
        title: p.title || '',
        start_time: p.start_time || p.start,
        end_time: p.end_time || p.end,
        live_flag
      };
    }).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    return { ok: true, programs };
  },
  async epgNow(channel) {
    try {
      const d = await Api.epg({ channel });
      const now = new Date();
      const cur = (d.programs || []).find(p => {
        const s = new Date(p.start_time).getTime(), e = new Date(p.end_time).getTime();
        return !isNaN(s) && !isNaN(e) && s <= now.getTime() && e > now.getTime();
      });
      const next = (d.programs || []).filter(p => new Date(p.start_time) > now).slice(0, 3);
      return { ok: true, now: cur || null, next };
    } catch (e) { return { ok: false }; }
  },
  async eventsCurrent(channel) {
    try {
      const idx = await loadIndex();
      const chanMap = {};
      for (const c of (idx.channels || [])) chanMap[c.key] = c;
      const list = (idx.events || [])
        .filter(e => (e.channel_keys || []).includes(channel))
        .map(e => ({
          ...e,
          channels: (e.channel_keys || []).map(k => chanMap[k] || { key: k, name: k, country: '' })
        }));
      return { ok: true, events: list };
    } catch (e) { return { ok: true, events: [] }; }
  },
  async rawUrl(channel) {
    const idx = await loadIndex();
    const c = (idx.channels || []).find(x => x.key === channel);
    if (!c) return { ok: false, error: 'canale non trovato' };
    if ((c.url || '').match(ARK_RE)) return Api.token(channel); // ark: serve URL firmato anche per player esterno
    return { ok: true, url: c.plutoUrl || c.url };
  },
  async token(channel) {
    const idx = await loadIndex();
    const c = (idx.channels || []).find(x => x.key === channel);
    if (!c) return { ok: false, error: 'canale non trovato' };
    // Canali ARK (streamhostingcdn): URL firmato con token dal keeper.
    const arkId = (c.url || '').match(ARK_RE);
    if (arkId) {
      const nowS = Math.floor(Date.now() / 1000);
      const hit = _arkCache.get(channel);
      if (hit && hit.exp > nowS + 90) {
        return { ok: true, method: 'direct', url: hit.url, name: c.name, refresh_in: hit.refresh_in, exp: hit.exp };
      }
      const st = await loadArkTokens();
      const rec = st && st.tokens && st.tokens[arkId[1]];
      if (rec && rec.token && rec.exp) {
        const url = c.url + '?token=' + encodeURIComponent(rec.token) + '&exp=' + encodeURIComponent(rec.exp);
        _arkCache.set(channel, { url, exp: Number(rec.exp), refresh_in: Number(rec.refresh_in) || 300 });
        return { ok: true, method: 'direct', url, name: c.name, refresh_in: Number(rec.refresh_in) || 300, exp: Number(rec.exp) };
      }
      return { ok: false, error: 'token non disponibile (keeper)', url: c.url };
    }
    if (c.method === 'pluto') {
      try {
        const r = await fetch(c.plutoUrl || c.url, { redirect: 'follow', mode: 'cors' });
        let u = (r && r.url) || c.url;
        u = u
          .replace(/%7BTARGETOPT%7D/g, '1')
          .replace(/%7BPSID%7D/g, 'abc123')
          .replace(/%7BUS_PRIVACY%7D/g, '1Y-')
          .replace(/%7BAPP_DOMAIN%7D/g, 'web')
          .replace(/%7BAPP_NAME%7D/g, 'web')
          .replace(/\{TARGETOPT\}/g, '1')
          .replace(/\{PSID\}/g, 'abc123')
          .replace(/\{US_PRIVACY\}/g, '1Y-')
          .replace(/\{APP_DOMAIN\}/g, 'web')
          .replace(/\{APP_NAME\}/g, 'web');
        return { ok: true, method: 'direct', url: u, name: c.name };
      } catch (e) {
        // FIX 23/08: fetch CORS bloccato (jmp2.uk senza ACAO) -> NON bloccare:
        // restituisci URL raw con template sostituiti, method native -> il player
        // usa il media element nativo (non soggetto a CORS) e lo stream gira.
        const u = (c.plutoUrl || c.url)
          .replace(/%7BTARGETOPT%7D/g, '1')
          .replace(/%7BPSID%7D/g, 'abc123')
          .replace(/%7BUS_PRIVACY%7D/g, '1Y-')
          .replace(/%7BAPP_DOMAIN%7D/g, 'web')
          .replace(/%7BAPP_NAME%7D/g, 'web')
          .replace(/\{TARGETOPT\}/g, '1')
          .replace(/\{PSID\}/g, 'abc123')
          .replace(/\{US_PRIVACY\}/g, '1Y-')
          .replace(/\{APP_DOMAIN\}/g, 'web')
          .replace(/\{APP_NAME\}/g, 'web');
        return { ok: false, needExternal: true, url: u, name: c.name };
      }
    }
    return { ok: true, method: 'direct', url: c.url, name: c.name };
  },
};
