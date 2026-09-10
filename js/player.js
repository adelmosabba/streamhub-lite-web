'use strict';
// Player INLINE (non piu' overlay): hls.js per gli stream HLS (method direct).
// Il box viene inserito NEL FLUSSO della pagina, subito sotto la card/riga
// cliccata. Non viene distrutto dai re-render della lista: app.js chiama
// Player.reattach() dopo ogni render e ri-aggancia lo STESSO <video> (hls resta
// attaccato -> lo stream NON si interrompe).
// Niente visibilitychange->close(): il player vive anche in background/PiP
// (era la causa di "cambio scheda = stream fermo" e "overlay sparito al ritorno").
// Un solo player alla volta.
(function () {
  let hls = null;
  let session = 0;          // guardia: invalida fetch/retry in corso alla chiusura
  let refreshTimer = null;  // rinnovo token ARK (~10 min, rinnova 30s prima)

  let box = null;           // nodo .player-inline (contiene il <video> vivo)
  let videoEl = null;
  let curKey = '';
  let curTitle = '';
  let curMode = 'card';     // card | grid | dock
  let wasPlaying = false;   // serve a riprendere il play al ritorno visibile

  // Opzioni hls.js: allineate alla finestra manifest del CDN (5 segmenti).
  const HLS_OPTS = {
    liveDurationInfinity: true,
    manifestLoadingMaxRetry: 5,
    manifestLoadingRetryDelay: 1000,
    manifestLoadingMaxRetryTimeout: 15000,
    levelLoadingMaxRetry: 5,
    levelLoadingRetryDelay: 1000,
    fragLoadingMaxRetry: 5,
    fragLoadingRetryDelay: 1000,
    fragLoadingMaxRetryTimeout: 20000,
    maxBufferLength: 30,
    backBufferLength: 15,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 5,
    lowLatencyMode: false,
    manifestLoadingTimeOut: 15000,
    fragLoadingTimeOut: 15000,
    abrBandWidthFactor: 0.5,
    abrBandWidthUpFactor: 0.5,
    abrEwmaDefaultEstimate: 500000,
    abrMaxWithRealBitrate: true
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtTime(iso) {
    if (!iso) return '--:--';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }

  // --- posizionamento inline ---------------------------------------------

  function cssEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

  // Ritrova l'elemento della card cliccata nel DOM corrente (dopo i re-render).
  function anchorOf(key, title) {
    try {
      const enc = encodeURIComponent(title || '');
      let el = null;
      if (title) el = document.querySelector('[data-play="' + cssEsc(key) + '"][data-title="' + cssEsc(enc) + '"]');
      if (!el) el = document.querySelector('[data-play="' + cssEsc(key) + '"]');
      return el;
    } catch (e) { return null; }
  }

  function dock(node) {
    const sc = document.querySelector('.epg-scroll');
    if (sc && sc.parentNode) { sc.parentNode.insertBefore(node, sc); return; }
    const main = document.getElementById('app');
    if (main) main.insertBefore(node, main.firstChild);
    else document.body.appendChild(node);
  }

  // Aggancia il box sotto la card cliccata (o lo docka in cima se non esiste).
  function attach(node, key, title) {
    const el = anchorOf(key, title);
    const card = el && el.closest('.card');
    const ch = el && el.closest('.ch-card');
    const prog = el && el.closest('.epg-prog');

    // gia' al posto giusto? non toccare il DOM (nessun glitch sul video)
    if (card && card.nextElementSibling === node) return 'card';
    if (ch && ch.nextElementSibling === node) return 'grid';
    if (node.parentNode) node.parentNode.removeChild(node);

    let mode = 'card';
    if (card) { node.className = 'player-inline'; card.insertAdjacentElement('afterend', node); }
    else if (ch) { node.className = 'player-inline is-grid'; ch.insertAdjacentElement('afterend', node); mode = 'grid'; }
    else if (prog) { mode = 'dock'; }
    else if (el) { node.className = 'player-inline'; el.insertAdjacentElement('afterend', node); }
    else { mode = 'dock'; }

    if (mode === 'dock') {
      node.className = 'player-inline is-dock';
      const h = document.querySelector('header');
      node.style.top = ((h ? h.offsetHeight : 0) + 8) + 'px';
      dock(node);
    } else {
      node.style.top = '';
    }
    return mode;
  }

  // Richiamata da app.js DOPO ogni render della vista: rimette il player al suo
  // posto senza ricrearlo (lo stream continua).
  function reattach() {
    if (!box || !curKey) return;
    if (document.body.contains(box)) {
      if (curMode === 'dock' && !anchorOf(curKey, curTitle)) return;
      const el = anchorOf(curKey, curTitle);
      const host = el && (el.closest('.card') || el.closest('.ch-card') || el.closest('.epg-prog'));
      if (host && host.nextElementSibling === box) return;
      if (!host && curMode === 'dock') return;
    }
    curMode = attach(box, curKey, curTitle);
  }

  // --- contenuti accessori ------------------------------------------------

  function loadEpg(channelKey) {
    const body = document.getElementById('playerEpg') && document.getElementById('playerEpg').querySelector('.epg-body');
    if (!body) return;
    Api.epgNow(channelKey).then((e) => {
      if (!e || !e.ok || (!e.now && (!e.next || !e.next.length))) { body.textContent = 'Nessuna guida disponibile'; return; }
      let html = '';
      if (e.now) html += '<div class="epg-now"><b>Ora:</b> ' + fmtTime(e.now.start_time) + ' - ' + fmtTime(e.now.end_time) + ' · ' + (e.now.title || '') + '</div>';
      if (e.next && e.next.length) {
        html += '<div class="epg-next"><b>Successivi:</b></div>';
        e.next.forEach((n) => { html += '<div class="epg-item">' + fmtTime(n.start_time) + ' · ' + (n.title || '') + '</div>'; });
      }
      body.innerHTML = html;
    }).catch(() => { body.textContent = 'Nessuna guida disponibile'; });
  }

  function loadAlts(channelKey) {
    const el = document.getElementById('playerAlts');
    if (!el) return;
    Api.eventsCurrent(channelKey).then((d) => {
      if (!d || !d.ok || !d.events || !d.events.length) { el.innerHTML = ''; return; }
      let html = '';
      d.events.forEach((ev) => {
        if (!ev.channels || !ev.channels.length) return;
        const nome = [ev.home, ev.away].filter(Boolean).join(' - ') || ev.league || 'Evento';
        html += '<div class="alts-row"><span class="alts-ev">' + (ev.status === 'live' ? '🔴 ' : '') + esc(nome) + '</span>';
        html += ev.channels.map((c) => {
          const flag = c.country ? c.country.toUpperCase() : '';
          return '<button class="alts-chip" data-alts="' + esc(c.key) + '" data-title="' + encodeURIComponent(c.name || '') + '">' + esc(flag) + ' ' + esc(c.name || c.key) + '</button>';
        }).join('');
        html += '</div>';
      });
      el.innerHTML = html;
      el.querySelectorAll('[data-alts]').forEach((btn) => {
        btn.addEventListener('click', () => {
          open(btn.getAttribute('data-alts'), decodeURIComponent(btn.getAttribute('data-title') || ''));
        });
      });
    }).catch(() => { el.innerHTML = ''; });
  }

  function close() {
    if (window.Presence) Presence.stop();   // canale chiuso: esci dal conteggio per-canale
    session++;  // invalida eventuali fetch/retry in corso
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    videoEl = null;
    wasPlaying = false;
    curKey = '';
    curTitle = '';
    if (box) { if (box.parentNode) box.parentNode.removeChild(box); box = null; }
    const old = document.getElementById('playerOverlay');   // compat: eventuale overlay vecchio in cache
    if (old) old.remove();
  }

  // APK: usa il bridge nativo se presente (niente redirect custom-scheme).
  // Browser: fallback custom scheme (nessun effetto) + URL gia copiato.
  function openExternal(url) {
    try {
      if (window.StreamHubBridge && window.StreamHubBridge.openExternal) {
        window.StreamHubBridge.openExternal(url);
        return true;
      }
    } catch (e) {}
    try { window.location.href = "streamhub://open?url=" + encodeURIComponent(url); } catch (e) {}
    return false;
  }

  function open(channelKey, title) {
    if (box) close();          // un solo player alla volta
    const mySession = ++session;

    curKey = channelKey;
    curTitle = title || channelKey;

    box = document.createElement('div');
    box.id = 'playerCard';
    box.className = 'player-inline';
    box.innerHTML = '<div class="player-head"><b>' + esc(curTitle) + '</b>' +
      '<span class="player-head-btns">' +
      '<button id="playerExternal" class="close" title="Apri in player esterno (copia URL)">📺</button>' +
      '<button id="playerClose" class="close" title="Chiudi player">✕</button>' +
      '</span></div>' +
      '<video id="playerVideo" controls playsinline></video>' +
      '<div id="playerQWrap" class="player-qwrap" style="display:none;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:#8b949e">' +
      '<label for="playerQuality">Qualità:</label>' +
      '<select id="playerQuality" style="background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:4px 8px"></select>' +
      '</div>' +
      '<div id="playerStatus" class="player-status">Caricamento...</div>' +
      '<div id="playerAlts" class="player-alts"></div>' +
      '<div id="playerEpg" class="player-epg"><div class="epg-title">Guida programma</div><div class="epg-body">Caricamento...</div></div>';

    curMode = attach(box, curKey, curTitle);

    const status = document.getElementById('playerStatus');
    document.getElementById('playerClose').addEventListener('click', close);
    document.getElementById('playerExternal').addEventListener('click', () => {
      const src = hls && hls.url ? hls.url : null;
      Api.rawUrl(channelKey).then((r) => {
        const url = src || (r.ok ? r.url : null);
        if (!url) { status.textContent = 'URL non disponibile per questo canale'; return; }
        try { navigator.clipboard.writeText(url); } catch (e) {}
        status.textContent = 'URL copiato 📋 · ' + (url.length > 55 ? url.slice(0, 52) + '...' : url);
        try { openExternal(url); } catch (e) {}
      });
    });

    const video = document.getElementById('playerVideo');
    videoEl = video;
    // Avvio SEMPRE esplicito (play() dopo MANIFEST_PARSED). Con l'attributo
    // autoplay il browser ripartiva da solo quando hls.js ricreava la
    // MediaSource per il rinnovo della firma -> audio dal telefono in pausa.
    video.autoplay = false;
    // audio attivo per default
    video.muted = false;
    video.volume = 1.0;
    video.addEventListener('play', () => { wasPlaying = true; });
    video.addEventListener('pause', () => { wasPlaying = false; });

    loadEpg(channelKey);
    loadAlts(channelKey);
    if (window.Presence) Presence.start(channelKey);   // canale in riproduzione: segnala a presence

    // Avvia il player con URL (eventualmente firmato) e pianifica il rinnovo
    // del token ARK ~30s prima della scadenza (visione continua).
    function playUrl(url, refreshIn, exp, isRefresh) {
      if (mySession !== session) return;
      // Stato REALE dell'elemento PRIMA di distruggere hls.
      // Se stiamo rinnovando la firma e il video NON stava suonando (pausa
      // dell'utente, oppure riproduzione remota/cast: l'elemento locale resta
      // in pausa), il nuovo hls NON deve ripartire da solo. Era il bug:
      // "dopo ~8 minuti riparte l'audio dal telefono mentre guardo sul TV".
      const keepPaused = !!isRefresh && (video.paused || video.ended);
      if (keepPaused) { try { video.autoplay = false; } catch (e) {} }
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      if (window.Hls && Hls.isSupported()) {
        const arkExp = Number(exp) || 0;
        const opts = Object.assign({}, HLS_OPTS);
        if (arkExp) {
          // Il CDN emette i segmenti con '&exp=' VUOTO: dal nostro dominio
          // (github.io) verrebbero 403. Riscriviamo l'exp dei segmenti col
          // valore pieno preso dal token (il manifest invece resta solo ?token=).
          opts.fetchSetup = (ctx, init) => {
            if (ctx && ctx.url && ctx.url.indexOf('&exp=') !== -1 && !ctx.url.match(/&exp=[^&]/)) {
              ctx.url = ctx.url.replace('&exp=', '&exp=' + arkExp);
            }
            return init;
          };
        }
        hls = new Hls(opts);
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // forza la prima traccia audio (evita TS multi-programma video-only)
          try { if (hls.audioTracks && hls.audioTracks.length) hls.audioTrack = hls.audioTracks[0].id; } catch (e) {}
          const qWrap = document.getElementById('playerQWrap');
          const qSel = document.getElementById('playerQuality');
          if (qSel) {
            qSel.innerHTML = '<option value="-1">Auto</option>';
            if (hls.levels && hls.levels.length > 1) {
              hls.levels.forEach((lv, i) => {
                const h = lv.height ? lv.height + 'p' : ('~' + Math.round((lv.bitrate || 0) / 1000) + 'kbps');
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = h;
                qSel.appendChild(opt);
              });
              if (qWrap) qWrap.style.display = 'flex';
            }
            qSel.onchange = () => {
              const v = parseInt(qSel.value, 10);
              hls.currentLevel = v; // -1 = auto
              status.textContent = v === -1 ? 'Streaming (auto)' : 'Streaming (' + qSel.options[qSel.selectedIndex].text + ')';
            };
          }
          video.muted = false; video.volume = 1.0;
          // Rinnovo firma: NON forzare il play se l'utente era in pausa.
          if (!keepPaused) video.play().catch(() => { /* autoplay bloccato: l'utente preme play */ });
          status.textContent = keepPaused ? 'Streaming (in pausa)' : 'Streaming';
        });
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (data.fatal) { status.textContent = 'Errore stream: ' + data.type; hls.destroy(); hls = null; }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        if (!keepPaused) video.play().catch(() => {});
        status.textContent = keepPaused ? 'Streaming (in pausa)' : 'Streaming';
      } else {
        status.textContent = 'HLS non supportato da questo browser';
        return;
      }
      if (refreshIn > 0) {
        const delayMs = Math.max((refreshIn - 30) * 1000, 15000);
        refreshTimer = setTimeout(async () => {
          if (mySession !== session) return;
          try {
            const t2 = await Api.token(channelKey);
            if (mySession !== session) return;
            if (t2.ok && t2.url) { status.textContent = 'Rinnovo firma...'; playUrl(t2.url, t2.refresh_in, t2.exp, true); }
          } catch (e) {
            status.textContent = 'Rinnovo firma fallito, riprovo tra 60s';
            if (mySession === session) refreshTimer = setTimeout(() => playUrl(url, refreshIn, exp, true), 60000);
          }
        }, delayMs);
      }
    }

    function startStream(attempt) {
      Api.token(channelKey).then((t) => {
        if (mySession !== session) return;  // chiuso nel frattempo: NON avviare
        if (!t.ok) {
          if (t.needExternal) {
            // Canali Pluto: CORS blocca il fetch e Android non ha HLS nativo ->
            // il player non puo integrarlo. Pulsante per il player esterno.
            status.textContent = 'Questo canale richiede il player esterno (CORS)';
            const btn = document.createElement('button');
            btn.textContent = '📺 Apri in player esterno';
            btn.style.cssText = 'margin-top:8px;background:#238636;color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px;';
            btn.onclick = () => {
              try { navigator.clipboard.writeText(t.url); } catch (e) {}
              try { openExternal(t.url); } catch (e) {}
              status.textContent = 'Apertura player esterno... (URL copiato 📋)';
            };
            status.appendChild(btn);
            return;
          }
          if (attempt < 1) { status.textContent = 'Errore, riprovo...'; setTimeout(() => { if (mySession === session) startStream(attempt + 1); }, 2000); return; }
          status.textContent = 'Errore: ' + (t.error || 'token'); return;
        }
        if (mySession !== session) return;  // ri-verifica prima di attaccare hls
        status.textContent = 'Avvio stream...';
        playUrl(t.url, t.refresh_in, t.exp);
      }).catch((err) => { status.textContent = 'Errore: ' + err.message; });
    }
    startStream(0);
  }

  // Delegazione click: qualsiasi elemento [data-play]
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-play]');
    if (!el) return;
    const key = el.getAttribute('data-play');
    const title = decodeURIComponent(el.getAttribute('data-title') || '');
    open(key, title);
  });

  // Al ritorno in primo piano NON chiudiamo nulla (a differenza di prima):
  // se lo stream era in play, lo riprendiamo. Il PiP e l'audio in background
  // restano vivi perche' nessun handler li interrompe.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (videoEl) wasPlaying = !videoEl.paused; return; }
    if (videoEl && wasPlaying) { try { videoEl.play().catch(() => {}); } catch (e) {} }
  });

  window.addEventListener('resize', () => { if (box && curMode === 'dock') reattach(); });

  window.Player = { open, close, reattach, isOpen: () => !!box, current: () => curKey };
})();
