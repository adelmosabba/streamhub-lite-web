'use strict';

// ===== Config =====
const BEACON_URL = 'https://gist.githubusercontent.com/adelmosabba/de801ecad18027c1cc8ef1d551d00d5e/raw/beacon.json';
const CACHE_KEY = 'shl:index';
const CACHE_BEACON_KEY = 'shl:beacon';
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4h

// ===== Stato =====
let channels = [];
let filtered = [];

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const listEl = $('channelList');
const searchEl = $('search');
const countryEl = $('countryFilter');
const sportEl = $('sportFilter');
const overlay = $('playerOverlay');
const video = $('video');
const playerTitle = $('playerTitle');
const playerMsg = $('playerMsg');

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
  statusEl.textContent = 'v' + (beacon.v || index.version || '?') + ' · ' + channels.length + ' canali';
  buildFilters();
  render();
}

// ===== Filtri =====
function buildFilters() {
  const countries = [...new Set(channels.map(c => c.country).filter(Boolean))].sort();
  const sports = [...new Set(channels.map(c => c.sport).filter(Boolean))].sort();
  countryEl.innerHTML = '<option value="">Tutti i paesi</option>' +
    countries.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('');
  sportEl.innerHTML = '<option value="">Tutti gli sport</option>' +
    sports.map(s => `<option value="${s}">${s}</option>`).join('');
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
    listEl.innerHTML = '<li style="cursor:default;color:#8b949e">Nessun canale trovato</li>';
    return;
  }
  listEl.innerHTML = filtered.map(ch => `
    <li onclick="playChannel('${ch.key}')">
      <div>
        <div class="channel-name">${ch.name}</div>
        <div class="channel-meta">${(ch.country||'').toUpperCase()} · ${ch.sport||''}</div>
      </div>
      <span class="badge ${ch.method}">${ch.method}</span>
    </li>
  `).join('');
}

searchEl.addEventListener('input', render);
countryEl.addEventListener('change', render);
sportEl.addEventListener('change', render);

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
    const hls = new Hls({ enableWorker: true });
    hls.on(Hls.Events.ERROR, (evt, data) => {
      if (data.fatal) {
        hls.destroy();
        showError(ch, new Error(data.type + ':' + data.details));
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
}

function stopPlayback() {
  if (window._hls) { window._hls.destroy(); window._hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function showError(ch, err) {
  console.error('play error', err);
  const hint = ch.countryHint ? ` (suggerita: ${ch.countryHint.toUpperCase()})` : '';
  playerMsg.textContent = `🔒 Errore di riproduzione. Attiva una VPN${hint} e riprova, oppure riprova tra poco.`;
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

// ===== Init =====
loadIndex().catch(err => {
  statusEl.textContent = 'errore: ' + err.message;
  listEl.innerHTML = `<li style="cursor:default;color:#f85149">Impossibile caricare il catalogo.<br>Controlla connessione o beacon.</li>`;
});
