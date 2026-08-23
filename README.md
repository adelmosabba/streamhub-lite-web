# EventHub Lite (client)

Web app statica per EventHub Lite. Legge i dati da un indice statico su Gist
(beacon -> index.json). Nessun server, nessun backend.

## Struttura
- index.html — UI (tab Eventi/Canali/EPG)
- css/style.css — tema
- js/api.js — adattatore dati: beacon -> index.json (interfaccia stile v2)
- js/app.js, js/player.js, js/views.js — frontend v2 adattato
- vendor/hls.min.js — player HLS offline

## Deploy
Push su main -> GitHub Pages (https://adelmosabba.github.io/streamhub-lite-web/)
