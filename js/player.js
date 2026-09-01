'use strict';
// Player overlay: hls.js per gli stream HLS (method direct). Un solo player alla volta.
(function () {
  let hls = null;
  let session = 0;  // guardia anti-background: invalida fetch in corso alla chiusura

  let refreshTimer = null;  // timer rinnovo token ARK (~10 min, rinnova 30s prima della scadenza)

  // Opzioni hls.js: allineate alla finestra manifest 7nyaler (5 segmenti).
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

  function fmtTime(iso) {
    if (!iso) return '--:--';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }

  function loadEpg(channelKey) {
    const body = document.getElementById('playerEpg')?.querySelector('.epg-body');
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
    const box = document.getElementById('playerAlts');
    if (!box) return;
    Api.eventsCurrent(channelKey).then((d) => {
      if (!d || !d.ok || !d.events || !d.events.length) { box.innerHTML = ''; return; }
      let html = '';
      d.events.forEach((ev) => {
        if (!ev.channels || !ev.channels.length) return;
        const nome = [ev.home, ev.away].filter(Boolean).join(' - ') || ev.league || 'Evento';
        html += '<div class="alts-row"><span class="alts-ev">' + (ev.status === 'live' ? '🔴 ' : '') + nome + '</span>';
        html += ev.channels.map((c) => {
          const flag = c.country ? c.country.toUpperCase() : '';
          return '<button class="alts-chip" data-alts="' + c.key + '" data-title="' + encodeURIComponent(c.name || '') + '">' + flag + ' ' + (c.name || c.key) + '</button>';
        }).join('');
        html += '</div>';
      });
      box.innerHTML = html;
      box.querySelectorAll('[data-alts]').forEach((btn) => {
        btn.addEventListener('click', () => {
          open(btn.getAttribute('data-alts'), decodeURIComponent(btn.getAttribute('data-title') || ''));
        });
      });
    }).catch(() => { box.innerHTML = ''; });
  }

  function close() {
    session++;  // invalida eventuali fetch/retry in corso
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    const ov = document.getElementById('playerOverlay');
    if (ov) ov.remove();
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
    close();
    const mySession = ++session;
    const ov = document.createElement('div');
    ov.id = 'playerOverlay';
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="player-box">
        <div class="player-head"><b>${title || channelKey}</b>
          <button id="playerExternal" class="close" title="Apri in player esterno (copia URL)">📺</button>
          <button id="playerClose" class="close">✕</button>
        </div>
        <video id="playerVideo" controls autoplay playsinline></video>
        <div id="playerQWrap" class="player-qwrap" style="display:none;align-items:center;gap:8px;padding:6px 12px;font-size:13px;color:#8b949e">
          <label for="playerQuality">Qualità:</label>
          <select id="playerQuality" style="background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:4px 8px"></select>
        </div>
        <div id="playerStatus" class="player-status">Caricamento...</div>
        <div id="playerAlts" class="player-alts"></div>
        <div id="playerEpg" class="player-epg"><div class="epg-title">Guida programma</div><div class="epg-body">Caricamento...</div></div>
      </div>`;
    document.body.appendChild(ov);
    document.getElementById('playerClose').addEventListener('click', close);
    document.getElementById('playerExternal').addEventListener('click', () => {
      const src = hls && hls.url ? hls.url : null;
      Api.rawUrl(channelKey).then((r) => {
        const url = src || (r.ok ? r.url : null);
        if (!url) { status.textContent = 'URL non disponibile per questo canale'; return; }
        try { navigator.clipboard.writeText(url); } catch (e) {}
        status.textContent = 'URL copiato 📋 · ' + (url.length > 55 ? url.slice(0, 52) + '...' : url);
        // APK: custom scheme gestito da MainActivity (apre VLC/MX). Browser: nessun effetto.
        try { openExternal(url); } catch (e) {}
      });
    });
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    // FIX 23/08: se l'app va in background (es. player esterno aperto),
    // chiudi il player: al ritorno la lista e' pulita, niente overlay appeso.
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });

    const video = document.getElementById('playerVideo');
    const status = document.getElementById('playerStatus');
    // audio attivo per default
    video.muted = false;
    video.volume = 1.0;

    loadEpg(channelKey);
    loadAlts(channelKey);

    // Avvia il player con URL (eventualmente firmato) e pianifica il rinnovo
    // del token ARK ~30s prima della scadenza (visione continua).
    function playUrl(url, refreshIn, exp) {
      if (mySession !== session) return;
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
          video.play().catch(() => { /* autoplay bloccato: l'utente preme play */ });
          status.textContent = 'Streaming';
        });
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (data.fatal) { status.textContent = 'Errore stream: ' + data.type; hls.destroy(); hls = null; }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {});
        status.textContent = 'Streaming';
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
            if (t2.ok && t2.url) { status.textContent = 'Rinnovo firma...'; playUrl(t2.url, t2.refresh_in, t2.exp); }
          } catch (e) {
            status.textContent = 'Rinnovo firma fallito, riprovo tra 60s';
            if (mySession === session) refreshTimer = setTimeout(() => playUrl(url, refreshIn, exp), 60000);
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

  window.Player = { open, close };
})();
