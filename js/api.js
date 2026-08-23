'use strict';
// Client API "lite": legge index.json dal beacon (Gist) invece di API server.
// Interfaccia compatibile con il frontend v2 (Api.events/channels/sports/days/epg/token).
const BEACON_URL = 'https://gist.githubusercontent.com/adelmosabba/de801ecad18027c1cc8ef1d551d00d5e/raw/beacon.json';
const CACHE_TTL_MS = 4 * 3600 * 1000;

const _state = { idx: null, loadedAt: 0 };

async function loadIndex(force) {
  if (_state.idx && !force && Date.now() - _state.loadedAt < CACHE_TTL_MS) return _state.idx;
  let indexUrl = localStorage.getItem('shl.indexUrl') || '';
  try {
    const b = await (await fetch(BEACON_URL, { cache: 'no-cache' })).json();
    if (b && b.index) { indexUrl = b.index; localStorage.setItem('shl.indexUrl', indexUrl); }
  } catch (e) { /* fallback su cache locale */ }
  if (!indexUrl) throw new Error('beacon irraggiungibile');
  const res = await fetch(indexUrl, { cache: 'no-cache' });
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
    let list = idx.events || [];
    const p = params || {};
    if (p.date) list = list.filter(e => localDateStr(e.start_time) === p.date);
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
      const list = (idx.events || []).filter(e => (e.channel_keys || []).includes(channel));
      return { ok: true, events: list };
    } catch (e) { return { ok: true, events: [] }; }
  },
  async token(channel) {
    const idx = await loadIndex();
    const c = (idx.channels || []).find(x => x.key === channel);
    if (!c) return { ok: false, error: 'canale non trovato' };
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
        return { ok: false, error: 'Pluto richiede risoluzione server (non disponibile in lite)' };
      }
    }
    return { ok: true, method: 'direct', url: c.url, name: c.name };
  },
};
