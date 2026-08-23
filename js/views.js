'use strict';
// View render (puro, niente stato). Una funzione per vista.
// Utils: formato orario nel fuso locale del browser (non UTC grezzo)
function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(iso) {
  if (!iso) return 'sconosciuto';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'sconosciuto';
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((d0 - t0) / 86400000);
  if (diff === 0) return 'Oggi';
  if (diff === 1) return 'Domani';
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' });
}
// Label data esatta per le tab (giorno settimana + gg/mm)
function fmtDayTab(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}

const SPORT_ICONS = {
  calcio: '⚽', basket: '🏀', tennis: '🎾', motori: '🏎️', volley: '🏐',
  atletica: '🏃', nuoto: '🏊', rugby: '🏉', golf: '⛳', ciclismo: '🚴',
  boxe: '🥊', hockey: '🏒', baseball: '⚾', darts: '🎯', football: '🏈', pallamano: '🤾', futsal: '⚽', floorball: '🏑'
};
const SPORT_ORDER = ['calcio','basket','tennis','motori','volley','atletica','nuoto','rugby','golf','ciclismo','boxe','hockey','baseball','darts','football','pallamano','futsal','floorball'];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sportIcon(s) { return SPORT_ICONS[s] || '🏅'; }

function sortSports(a, b) {
  const ia = SPORT_ORDER.indexOf(a), ib = SPORT_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b);
}

function cardHtml(e) {
  const t = fmtTime(e.start_time);
  const live = e.status === 'live';
  const badge = live
    ? '<span class="badge live">LIVE</span>'
    : (e.has_stream ? '<span class="badge">📺</span>' : '<span class="badge nostream">no stream</span>');
  const keys = (e.channel_keys && e.channel_keys.length) ? e.channel_keys : [];
  const names = (e.channels && e.channels.length) ? e.channels : [];
  const playKey = keys.length ? keys[0] : '';
  const playAttr = playKey ? `data-play="${esc(playKey)}" data-title="${encodeURIComponent((e.home||'') + ' vs ' + (e.away||''))}"` : '';
  const title = encodeURIComponent((e.home || '') + ' vs ' + (e.away || ''));
  const chips = keys.length
    ? '<div class="ch-chip-row">' + keys.map((k, i) => {
        const nm = names[i] || k;
        return `<button class="ch-chip" data-play="${esc(k)}" data-title="${title}" title="${esc(nm)}">${i === 0 ? '▶ ' : ''}${esc(nm)}</button>`;
      }).join('') + '</div>'
    : '';
  return `<div class="card${live ? ' card-live' : ''}" ${playAttr}>
    <div class="time">${t}</div>
    <div class="info">
      <div class="teams">${esc(e.home || '')} <span style="color:#8b93b0">vs</span> ${esc(e.away || '')}</div>
      <div class="meta">${badge}</div>
      ${chips}
    </div>
  </div>`;
}

function dayTabsHtml(days, activeDay) {
  // Tab fisse IERI/OGGI/DOMANI (niente LIVE, niente navigazione infinita).
  let html = '<div class="day-tabs">';
  for (const d of days || []) {
    const act = d.date === activeDay ? ' active' : '';
    html += `<button class="day-tab${act}" data-day="${esc(d.date)}">${esc(d.label)}</button>`;
  }
  html += '</div>';
  return html;
}

function sportAccordionHtml(events) {
  if (!events.length) return '<div class="empty">Nessun evento</div>';
  // Sezione LIVE ORA in cima (stato calcolato client-side), poi sport -> league -> eventi.
  const live = events.filter(e => e.status === 'live').sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const rest = events.filter(e => e.status !== 'live');
  const sports = {};
  for (const e of rest) {
    const s = e.sport || 'altro';
    if (!sports[s]) sports[s] = {};
    const l = e.league || '—';
    if (!sports[s][l]) sports[s][l] = [];
    sports[s][l].push(e);
  }
  const sportKeys = Object.keys(sports).sort(sortSports);
  let html = '';
  if (live.length) {
    html += '<div class="live-now"><div class="live-now-title"><span class="dot"></span> LIVE ORA <span class="cnt">' + live.length + '</span></div>';
    for (const e of live) html += cardHtml(e);
    html += '</div>';
  }
  for (const sport of sportKeys) {
    const leagues = sports[sport];
    const totalSport = Object.values(leagues).reduce((n, arr) => n + arr.length, 0);
    html += `<details class="sport-group" open><summary><span class="sport-ico">${sportIcon(sport)}</span> ${esc(sport)} <span class="cnt">${totalSport}</span></summary>`;
    const leagueKeys = Object.keys(leagues).sort((a, b) => leagues[b].length - leagues[a].length || a.localeCompare(b));
    for (const league of leagueKeys) {
      const list = leagues[league].sort((a, b) => (b.status === 'live' ? 1 : 0) - (a.status === 'live' ? 1 : 0) || new Date(a.start_time) - new Date(b.start_time));
      html += `<div class="league-title">${esc(league)} <span class="cnt">${list.length}</span></div>`;
      for (const e of list) html += cardHtml(e);
    }
    html += '</details>';
  }
  return html;
}

// Griglia EPG: canali in colonna (righe), timeline oraria in alto, programmi come blocchi.
// Costanti di layout (px): larghezza colonna canali + 24h * 60px/h. Allineate al CSS.
const EPG_CHAN_W = 210;
const EPG_HOUR_PX = 100;
const EPG_DAY_PX = EPG_HOUR_PX * 24;

// Intervallo di un programma sovrapposto al giorno [dayStart, dayEnd) (ms), clampato.
function epgOverlap(p, dayStart, dayEnd) {
  const s = new Date(p.start_time).getTime();
  const e = new Date(p.end_time).getTime();
  if (isNaN(s) || isNaN(e)) return null;
  const a = Math.max(s, dayStart);
  const b = Math.min(e, dayEnd);
  if (b <= a) return null;
  return { left: (a - dayStart) / 86400000 * EPG_DAY_PX, width: (b - a) / 86400000 * EPG_DAY_PX };
}

function epgGroupTitle(country, count) {
  return `<div class="epg-group">${esc((country || '?').toUpperCase())} <span class="cnt">${count}</span></div>`;
}

function epgGridHtml(channels, programsByChannel, winStartMs, opts) {
  const o = opts || {};
  const nowLeftPx = o.nowLeftPx != null ? o.nowLeftPx : 0;
  if (!channels.length) return '<div class="empty">Nessun programma EPG nella finestra</div>';

  const DAY = 86400000;
  const winEnd = winStartMs + 3 * DAY;
  const winW = 3 * EPG_DAY_PX;

  // Header timeline: 3 segmenti giorno (IERI/OGGI/DOMANI) con 24 ore ciascuno
  const DAY_LABELS = ['IERI', 'OGGI', 'DOMANI'];
  let hours = '<div class="epg-head"><div class="epg-corner">Orario</div><div class="epg-hours">';
  for (let d = 0; d < 3; d++) {
    const ds = new Date(winStartMs + d * DAY);
    const dd = String(ds.getDate()).padStart(2, '0') + '/' + String(ds.getMonth() + 1).padStart(2, '0');
    hours += `<div class="epg-dayseg"><span>${DAY_LABELS[d]}</span><i>${dd}</i></div>`;
    for (let h = 0; h < 24; h++) {
      hours += `<div class="epg-hour"><span>${String(h).padStart(2, '0')}:00</span><i class="epg-tick30"></i></div>`;
    }
  }
  hours += '</div></div>';

  // Raggruppa canali per paese (ordine: paese, poi nome)
  const byCountry = {};
  for (const c of channels) {
    const k = c.country || '?';
    if (!byCountry[k]) byCountry[k] = [];
    byCountry[k].push(c);
  }
  const countries = Object.keys(byCountry).sort();

  let body = hours;
  for (const country of countries) {
    const list = byCountry[country];
    body += epgGroupTitle(country, list.length);
    for (const c of list) {
      const progs = (programsByChannel[c.key] || []);
      let blocks = '';
      for (const p of progs) {
        const ov = epgOverlap(p, winStartMs, winEnd);
        if (!ov) continue;
        const flag = p.live_flag === 'live'
          ? '<span class="epg-live">LIVE</span>'
          : (p.live_flag === 'replay' ? '<span class="epg-replay">R</span>' : '');
        const range = fmtTime(p.start_time) + '–' + fmtTime(p.end_time);
        blocks += `<div class="epg-prog" style="left:${ov.left.toFixed(1)}px;width:${ov.width.toFixed(1)}px" data-play="${esc(c.key)}" data-title="${encodeURIComponent(p.title || c.name)}" title="${esc(range + ' · ' + p.title + ' · ' + c.name)}">
          ${flag}<div class="epg-prog-title">${esc(p.title || '')}</div>
          <div class="epg-prog-time">${range}</div>
        </div>`;
      }
      if (!blocks) continue;
      body += `<div class="epg-row">
        <div class="epg-chan" title="${esc(c.name)}">${esc(c.name)}</div>
        <div class="epg-track">${blocks}</div>
      </div>`;
    }
  }

  if (body === hours) return '<div class="empty">Nessun programma EPG nella finestra</div>';

  return `<div class="epg-scroll">
    <div class="epg-grid epg-has-now" style="--now-left:${nowLeftPx.toFixed(1)}px;--win-w:${winW}px">
      ${body}
      <div class="epg-nowline"></div>
    </div>
  </div>`;
}

const Views = {
  dayTabsHtml,
  events(events) {
    // Lista del giorno selezionato: sport collassati (le tab stanno sopra, in app.js).
    if (!events || !events.length) return '<div class="empty">Nessun evento</div>';
    return sportAccordionHtml(events);
  },
  channels(channels) {
    channels = (channels || []).filter(c => c.enabled !== 0);
    if (!channels.length) return '<div class="empty">Nessun canale</div>';
    const byCountry = {};
    for (const c of channels) {
      const k = c.country || '?';
      if (!byCountry[k]) byCountry[k] = [];
      byCountry[k].push(c);
    }
    let html = '';
    for (const [country, list] of Object.entries(byCountry)) {
      html += `<details class="sport-group" open><summary><span class="sport-ico">📺</span> ${country.toUpperCase()} <span class="cnt">${list.length}</span></summary><div class="grid">`;
      for (const c of list) {
        html += `<div class="ch-card" data-play="${esc(c.key)}" data-title="${encodeURIComponent(c.name)}">
          <div class="name">${esc(c.name)}</div>
          <div class="country">${esc(c.country)} · ${esc(c.sport || '')}${c.epg_id ? ' · EPG' : ''}</div>
          <div class="meta" style="font-size:12px;color:#8b93b0">▶ avvia player</div>
        </div>`;
      }
      html += '</div></details>';
    }
    return html;
  },
  epg(programs) {
    if (!programs.length) return '<div class="empty">Nessun programma EPG</div>';
    let html = '';
    for (const p of programs) {
      const t = fmtTime(p.start_time);
      const flag = p.live_flag === 'replay' ? '<span class="replay">(replica)</span>' : '';
      html += `<div class="epg-row">
        <div class="time">${t}</div>
        <div class="info"><div>${esc(p.title)} ${flag}</div>
        <div class="meta" style="font-size:12px;color:#8b93b0">${esc(p.channel_name || p.channel_key)}</div></div>
      </div>`;
    }
    return html;
  },
  epgGrid: epgGridHtml,
};
