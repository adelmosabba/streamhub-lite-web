'use strict';

// ===== Config =====
const BEACON_URL = 'https://gist.githubusercontent.com/adelmosabba/de801ecad18027c1cc8ef1d551d00d5e/raw/beacon.json';
const CACHE_KEY = 'shl:index';
const CACHE_BEACON_KEY = 'shl:beacon';
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4h

// ===== Stato =====
let channels = [];
let events = [];
let filtered = [];
let activeTab = 'channels';

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const listEl = $('channelList');
const searchEl = $('search');
const countryEl = $('countryFilter');
const sportEl = $('sportFilter');
const tabCh = $('tabChannels');
const tabEv = $('tabEvents');
const eventsList = $('eventsList');
const overlay = $('playerOverlay');
const video = $('video');
const playerTitle = $('playerTitle');
const playerMsg = $('playerMsg');

// ===== Utils =====
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDay(iso) {
  const d = new Date(iso);
  const now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return 'OGGI';
  const tom = new Date(now); tom.setDate(tom.getDate() + 1);
  if (same(d, tom)) return 'DOMANI';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

// ===== Cache helpers =====
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CACHE_TTL) return null;
    return obj.data;
  } catch (e) { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
}

// ===== Beacon =====
async function loadIndex() {
  statusEl.textContent = 'lettura beacon…';
  let beacon;
  try {
    beacon = await (await fetch(BEACON_URL)).json();
    cacheSet(CACHE_BEACON_KEY, beacon);
  } catch (e) {
    beacon = cacheGet(CACHE_BEACON_KEY);
    statusEl.textContent = 'beacon offline, uso cache';
  }
  if (!beacon || !beacon.index) throw new Error('beacon non valido');

  let index;
  try {
    index = await (await fetch(beacon.index)).json();
    cacheSet(CACHE_KEY, index);
  } catch (e) {
    index = cacheGet(CACHE_KEY);
    statusEl.textContent = 'indice offline, uso cache';
  }
  if (!index || !index.channels) throw new Error('indice non valido');
  channels = index.channels;
  events = index.events || [];
  statusEl.textContent = 'v' + (beacon.v || index.version || '?') + ' · ' + channels.length + ' canali · ' + events.length + ' eventi';
  buildFilters();
  render();
  renderEvents();
}

// ===== Filtri =====
function buildFilters() {
  const countries = [...new Set(channels.map(c => c.country).filter(Boolean))].sort();
  // Escludi il generico "sport" (95 canali) dal filtro: mostra solo sport reali con contatore
  const sports = [...new Set(channels.map(c => c.sport).filter(Boolean))]
    .filter(s => s !== 'sport')
    .sort();
  countryEl.innerHTML = '<option value="">Tutti i paesi</option>' +
    countries.map(c => {
      const n = channels.filter(x => x.country === c).length;
      return `<option value="${esc(c)}">${esc(c.toUpperCase())} (${n})</option>`;
    }).join('');
  sportEl.innerHTML = '<option value="">Tutti gli sport</option>' +
    sports.map(s => {
      const n = channels.filter(x => x.sport === s).length;
      return `<option value="${esc(s)}">${esc(s)} (${n})</option>`;
    }).join('');
}

function render() {
  const q = searchEl.value.toLowerCase();
  const c = countryEl.value;
  const s = sportEl.value;
  filtered = channels.filter(ch =>
    (!q || ch.name.toLowerCase().includes(q)) &&
    (!c || ch.country === c) &&
    (!s || ch.sport === s)
  );
  if (!filtered.length) {
    const extra = s ? ' (i canali generici non hanno uno sport specifico)' : '';
    listEl.innerHTML = `<li style="cursor:default;color:#8b949e">Nessun canale trovato${extra}</li>`;
    return;
  }
  listEl.innerHTML = filtered.map(ch => `
    <li onclick="playChannel('${esc(ch.key)}')">
      <div>
        <div class="channel-name">${esc(ch.name)}</div>
        <div class="channel-meta">${esc((ch.country||'').toUpperCase())} · ${esc(ch.sport||'')}</div>
      </div>
      <span class="badge ${esc(ch.method)}">${esc(ch.method)}</span>
    </li>
  `).join('');
}

searchEl.addEventListener('input', render);
countryEl.addEventListener('change', render);
sportEl.addEventListener('change', render);

// ===== Eventi =====
function renderEvents() {
  if (!events.length) {
    eventsList.innerHTML = '<li style="cursor:default;color:#8b949e">Nessun evento oggi/domani</li>';
    return;
  }
  const sorted = [...events].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const groups = {};
  for (const e of sorted) { (groups[e.sport] = groups[e.sport] || []).push(e); }
  let html = '';
  for (const [sport, evs] of Object.entries(groups)) {
    html += `<li class="event-group-title">${esc(sport)} · ${evs.length}</li>`;
    for (const e of evs) {
      const t = new Date(e.start_time);
      const time = t.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      const day = fmtDay(e.start_time);
      const live = isEventLive(e) ? '<span class="event-live">LIVE</span>' : '';
      html += `<li class="event-item" onclick="openEvent('${esc(sport)}')">
        <div class="event-time">${day}<br>${time}${live}</div>
        <div>
          <div class="channel-name">${esc(e.home)}${e.away ? ' — ' + esc(e.away) : ''}</div>
          <div class="event-league">${esc(e.league || '')}</div>
        </div>
      </li>`;
    }
  }
  eventsList.innerHTML = html;
}

function setTab(tab) {
  activeTab = tab;
  tabCh.classList.toggle('active', tab === 'channels');
  tabEv.classList.toggle('active', tab === 'events');
  listEl.classList.toggle('hidden', tab !== 'channels');
  eventsList.classList.toggle('hidden', tab !== 'events');
}

function openEvent(sport) {
  // Filtra i canali per sport: se il filtro sport esiste lo imposta, altrimenti avvisa
  if (sportEl.querySelector(`option[value="${CSS.escape(sport)}"]`)) {
    sportEl.value = sport;
  } else {
    sportEl.value = '';
    searchEl.value = '';
  }
  setTab('channels');
  render();
  // Se non ci sono canali con quel tag, messaggio esplicito
  if (!filtered.length) {
    listEl.innerHTML = `<li style="cursor:default;color:#8b949e">Nessun canale dedicato per «${esc(sport)}».<br>Cerca nella lista completa dei canali.</li>`;
  }
}

tabCh.addEventListener('click', () => setTab('channels'));
tabEv.addEventListener('click', () => setTab('events'));


// ===== LIVE client-side =====
const SPORT_DURATION_MS = {
  calcio: 2*3600e3, tennis: 3*3600e3, basket: 2.5*3600e3, football: 3.5*3600e3,
  baseball: 3.5*3600e3, pallamano: 2*3600e3, golf: 5*3600e3, motori: 3*3600e3
};
function isEventLive(e) {
  if (e.status === 'live') return true;
  const start = e.start_time ? new Date(e.start_time).getTime() : null;
  if (!start) return false;
  const end = e.end_time ? new Date(e.end_time).getTime() : start + (SPORT_DURATION_MS[e.sport] || 2*3600e3);
  const now = Date.now();
  return now >= start && now <= end;
}

// ===== Pluto fix =====
function fixPlutoUrl(rawUrl) {
  const rnd = Math.random().toString(36).slice(2, 10);
  return rawUrl
    .replace(/%7BTARGETOPT%7D|\{TARGETOPT\}/g, '1')
    .replace(/%7BPSID%7D|\{PSID\}/g, rnd)
    .replace(/%7BADVERTISINGID%7D|\{ADVERTISINGID\}/g, rnd)
    .replace(/%7BUS_PRIVACY%7D|\{US_PRIVACY\}/g, '1Y-')
    .replace(/%7BAPP_DOMAIN%7D|\{APP_DOMAIN\}/g, 'web')
    .replace(/%7BAPP_NAME%7D|\{APP_NAME\}/g, 'web');
}

// ===== Player =====
async function playChannel(key) {
  const ch = channels.find(c => c.key === key);
  if (!ch) return;
  overlay.classList.remove('hidden');
  playerTitle.textContent = ch.name;
  playerMsg.textContent = '';
  stopPlayback();

  let url = ch.url;
  try {
    if (ch.method === 'pluto') {
      playerMsg.textContent = 'risoluzione Pluto…';
      const resp = await fetch(ch.url);
      url = fixPlutoUrl(resp.url);
    }
    playerMsg.textContent = '';
    startHls(url, ch);
  } catch (err) {
    showError(ch, err);
  }
}

function startHls(url, ch) {
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
    hls.on(Hls.Events.ERROR, (evt, data) => {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.destroy();
          showError(ch, new Error('network:' + data.details));
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          hls.destroy();
          showError(ch, new Error(data.type + ':' + data.details));
        }
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    window._hls = hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    showError(ch, new Error('HLS non supportato'));
  }
  // Autoplay: se il browser blocca l'audio, invita al tap
  const p = video.play();
  if (p) p.catch(() => { playerMsg.textContent = '▶ Tocca play per avviare'; });
}

function stopPlayback() {
  if (window._hls) { window._hls.destroy(); window._hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function showError(ch, err) {
  console.error('play error', err);
  const msg = String(err && err.message || '');
  let testo;
  if (/network|fatal network|timeout|loadManifest/i.test(msg)) {
    testo = '🌐 Errore di rete: impossibile raggiungere la sorgente.';
  } else if (/CORS|Access-Control/i.test(msg)) {
    testo = '🚫 La sorgente blocca il browser (CORS). Prova un altro canale o il Cast.';
  } else {
    testo = '🔒 Errore di riproduzione.';
  }
  const hint = ch.countryHint ? ` (VPN suggerita: ${ch.countryHint.toUpperCase()})` : '';
  playerMsg.textContent = testo + hint + ' Attiva una VPN se sei in un paese bloccato, poi riprova.';
}

// ===== Cast (placeholder, da integrare con SDK) =====
$('castBtn').addEventListener('click', () => {
  playerMsg.textContent = 'Cast in arrivo nella prossima versione (SDK Chromecast/AirPlay).';
  setTimeout(() => { playerMsg.textContent = ''; }, 3000);
});

$('closePlayer').addEventListener('click', () => {
  stopPlayback();
  overlay.classList.add('hidden');
});

// ===== Refresh live ogni minuto (client-side) =====
setInterval(() => { if (activeTab === 'events' && events.length) renderEvents(); }, 60 * 1000);

// ===== Init =====
loadIndex().catch(err => {
  statusEl.textContent = 'errore: ' + err.message;
  listEl.innerHTML = `<li style="cursor:default;color:#f85149">Impossibile caricare il catalogo.<br>Controlla connessione o beacon.</li>`;
});
