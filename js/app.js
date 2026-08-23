'use strict';
// Controller: stato + binding. Carica eventi/canali/EPG e renderizza.
const state = { view: 'events', search: '', sport: '', activeDay: '', epgCache: {}, epgChannels: null, epgTimer: null };

const appEl = document.getElementById('app');
const sportFilter = document.getElementById('sportFilter');

function debounce(fn, ms) {
  let t;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- EPG grid: helper date (fuso locale, stringa YYYY-MM-DD) ---
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function tzOffsetMin() { return -new Date().getTimezoneOffset(); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Popola il filtro sport dall'API (sport reali nel DB)
async function loadSportOptions() {
  try {
    const data = await Api.sports();
    const cur = state.sport;
    sportFilter.innerHTML = '<option value="">Tutti gli sport</option>';
    for (const s of data.sports) {
      const opt = document.createElement('option');
      opt.value = s.sport;
      opt.textContent = s.sport + ' (' + s.count + ')';
      sportFilter.appendChild(opt);
    }
    if (cur) sportFilter.value = cur;
  } catch (e) { /* il filtro resta statico */ }
}

// Vista eventi: tab fisse IERI/OGGI/DOMANI + lista del giorno attivo.
async function loadEventsView() {
  const tz = tzOffsetMin();
  const today = todayStr();
  const y = addDays(today, -1);
  const tm = addDays(today, 1);
  if (!state.activeDay || (state.activeDay !== y && state.activeDay !== today && state.activeDay !== tm)) {
    state.activeDay = today;
  }

  const params = { date: state.activeDay, limit: 4000, tz };
  if (state.search) params.search = state.search;
  params.has_stream = '1'; // sempre solo eventi con stream
  if (state.sport) params.sport = state.sport;

  const data = await Api.events(params);
  const tabs = Views.dayTabsHtml([
    { date: y, label: 'IERI ' + new Date(y + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' }) },
    { date: today, label: 'OGGI ' + new Date(today + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' }) },
    { date: tm, label: 'DOMANI ' + new Date(tm + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' }) },
  ], state.activeDay);
  appEl.innerHTML = tabs + Views.events(data.events);
  bindDayTabs();
}

function bindDayTabs() {
  appEl.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.activeDay === btn.dataset.day) return;
      state.activeDay = btn.dataset.day;
      refresh();
    });
  });
}

async function loadChannels() {
  const data = await Api.channels({});
  appEl.innerHTML = Views.channels(data.channels);
}

// --- EPG grid ---
// Carica l'EPG di ogni canale UNA volta per sessione (cache), con batching.
async function ensureEpgCache(channels) {
  const todo = channels.filter(c => !(c.key in state.epgCache));
  if (!todo.length) return;
  const CONC = 8;
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    await Promise.all(batch.map(async (c) => {
      try {
        const d = await Api.epg({ channel: c.key });
        state.epgCache[c.key] = d.programs || [];
      } catch (e) {
        state.epgCache[c.key] = [];
      }
    }));
  }
}

function epgToolbarHtml() {
  return `<div class="epg-toolbar">
    <span class="epg-label">EPG · finestra continua IERI — OGGI — DOMANI</span>
    <button class="epg-nav" id="epgNowBtn">● Ora</button>
  </div>`;
}

function renderEpgGrid() {
  // Finestra continua: ieri 00:00 -> domani 23:59 (3 giorni, sempre)
  const DAY = 86400000;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const winStart = startToday - DAY;
  const winEnd = winStart + 3 * DAY;

  // Solo canali con almeno un programma nella finestra
  const channels = (state.epgChannels || []).filter(c => {
    const progs = state.epgCache[c.key] || [];
    return progs.some(p => {
      const s = new Date(p.start_time).getTime();
      const e = new Date(p.end_time).getTime();
      return !isNaN(s) && !isNaN(e) && s < winEnd && e > winStart;
    });
  }).sort((a, b) => (a.country || '').localeCompare(b.country || '') || a.name.localeCompare(b.name));

  const nowLeftPx = Math.max(0, Math.min(3 * 2400, (Date.now() - winStart) / (3 * DAY) * (3 * 2400)));

  appEl.innerHTML = epgToolbarHtml() + Views.epgGrid(channels, state.epgCache, winStart, { nowLeftPx });
  bindEpgControls();
}

function bindEpgControls() {
  const btn = document.getElementById('epgNowBtn');
  if (btn) btn.addEventListener('click', () => {
    const sc = document.querySelector('.epg-scroll');
    const grid = document.querySelector('.epg-grid');
    if (!sc || !grid) return;
    const chanW = parseFloat(getComputedStyle(grid).getPropertyValue('--chan-w')) || 210;
    const left = parseFloat(grid.style.getPropertyValue('--now-left')) + chanW - 120;
    sc.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  });
  startNowTimer();
}

// Linea ORA: aggiorna solo la CSS var (niente rerender), ogni 60s se giorno = oggi
function startNowTimer() {
  if (state.epgTimer) clearInterval(state.epgTimer);
  state.epgTimer = setInterval(() => {
    if (state.view !== 'epg') return;
    const grid = document.querySelector('.epg-grid.epg-has-now');
    if (!grid) return;
    const DAY = 86400000;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const winStart = startToday - DAY;
    const px = Math.max(0, Math.min(3 * 2400, (Date.now() - winStart) / (3 * DAY) * (3 * 2400)));
    grid.style.setProperty('--now-left', px.toFixed(1) + 'px');
  }, 60000);
}

async function loadEpg() {
  try {
    if (!state.epgChannels) {
      const d = await Api.channels({});
      state.epgChannels = d.channels || [];
    }
    appEl.innerHTML = '<div class="empty">Caricamento EPG...</div>';
    await ensureEpgCache(state.epgChannels);
    renderEpgGrid();
  } catch (e) {
    appEl.innerHTML = '<div class="empty">Errore EPG: ' + e.message + '</div>';
  }
}

const LOADERS = { events: loadEventsView, channels: loadChannels, epg: loadEpg };

async function refresh() {
  // Non svuotare la lista: overlay trasparente con spinner sopra il contenuto
  // esistente; la sostituzione avviene solo quando i nuovi dati arrivano.
  const hasContent = appEl.innerHTML.trim().length > 0 && !appEl.querySelector('.empty');
  if (hasContent) appEl.classList.add('is-loading');
  try {
    await LOADERS[state.view]();
  } catch (e) {
    appEl.innerHTML = '<div class="empty">Errore: ' + e.message + '</div>';
  } finally {
    appEl.classList.remove('is-loading');
  }
}

document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    refresh();
  });
});

document.getElementById('search').addEventListener('input', debounce(e => {
  state.search = e.target.value.trim();
  if (state.view === 'events') refresh();
}, 400));


sportFilter.addEventListener('change', e => {
  state.sport = e.target.value;
  if (state.view === 'events') refresh();
});

loadSportOptions();
refresh();
