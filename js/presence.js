'use strict';
// Presence: heartbeat leggero verso il Durable Object del worker Cloudflare.
// Conta gli utenti "online sul sito" (pagina visibile). Il worker tiene lo stato
// e rimuove da solo chi sparisce (TTL ~90s). Nessun dato personale: solo un id
// anonimo in localStorage. Il badge mostra "● N online" aggiornato ogni 15s.
(function () {
  const WORKER = 'https://streamhub-token.adelmosabbatini.workers.dev';
  const HEARTBEAT_MS = 30000;   // ogni 30s manda un ping
  const REFRESH_MS = 15000;     // refresh badge
  const MIN_INTERVAL_MS = 8000; // anti-spam sul POST

  let clientId = null;
  try {
    clientId = localStorage.getItem('evh_pid');
    if (!clientId) {
      clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('evh_pid', clientId);
    }
  } catch (e) {
    clientId = 'c' + Math.random().toString(36).slice(2, 10);
  }

  let channel = null;      // canale in riproduzione (per conteggio futuro per-canale)
  let hbTimer = null;
  let badgeTimer = null;
  let lastSent = 0;
  const badgeEls = [];

  function send() {
    const now = Date.now();
    if (now - lastSent < MIN_INTERVAL_MS) return;
    lastSent = now;
    fetch(WORKER + '/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, channel: channel }),
      cache: 'no-store'
    }).catch(() => { /* offline/worker giu: il badge resta nascosto, nessun crash */ });
  }

  function refreshBadge() {
    fetch(WORKER + '/presence', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        const n = (d && typeof d.online === 'number') ? d.online : null;
        badgeEls.forEach(function (el) {
          if (!el) return;
          if (n === null || n < 1) { el.style.display = 'none'; return; }
          el.style.display = 'inline-flex';
          el.textContent = '● ' + n + (n === 1 ? ' online' : ' online');
        });
      })
      .catch(function () { /* ignora: prossimo refresh */ });
  }

  function start(hbChannel) {
    if (hbChannel) channel = hbChannel;
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(send, HEARTBEAT_MS);
    send();
  }

  function stop() {
    channel = null;
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    send(); // ultimo ping con channel null: il DO ti scade dopo ~90s
  }

  function registerBadge(el) {
    if (el && badgeEls.indexOf(el) === -1) badgeEls.push(el);
    refreshBadge();
    if (!badgeTimer) badgeTimer = setInterval(refreshBadge, REFRESH_MS);
  }

  function init() {
    const el = document.getElementById('onlineBadge');
    if (el) registerBadge(el);
    start(null);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else start(null);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Presence = { start: start, stop: stop, registerBadge: registerBadge };
})();
