# StreamHub Lite Web

Client web per StreamHub Lite: lista canali e riproduzione direct via hls.js.

## Uso
Apri `index.html` da un host statico qualsiasi. L'app legge il beacon dal Gist e carica il catalogo.

## Sviluppo
- `app.js` — logica client (bootstrap beacon, filtri, player)
- `vendor/hls.min.js` — hls.js vendored (nessuna dipendenza esterna)
