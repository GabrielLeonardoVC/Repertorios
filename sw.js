// Service Worker do Repertório — permite instalar o app e usá-lo offline.
// Ao publicar uma nova versão, mude o número abaixo (v7 -> v8) para forçar a atualização.
const CACHE = 'repertorio-v7';

// Tudo que o app precisa para abrir sem internet (bibliotecas ficam na pasta lib/)
const ARQUIVOS_LOCAIS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './lib/lucide.min.js',
  './lib/Sortable.min.js',
  './lib/jszip.min.js',
  './lib/odf-reader.js',
  './lib/mammoth.browser.min.js',
  './lib/docToText.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js'
];

// Fontes do Google: opcionais (sem elas o app usa a fonte padrão do aparelho)
const HOSTS_OPCIONAIS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Um arquivo por vez: se algum falhar, os outros continuam sendo guardados
    await Promise.all(ARQUIVOS_LOCAIS.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function paginaOffline() {
  return (await caches.match('./index.html', { ignoreSearch: true })) ||
         (await caches.match('./', { ignoreSearch: true })) ||
         new Response('Sem conexão e o app ainda não foi guardado no aparelho.', {
           status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
         });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const mesmaOrigem = url.origin === self.location.origin;
  const opcional = HOSTS_OPCIONAIS.includes(url.hostname);
  if (!mesmaOrigem && !opcional) return; // YouTube, WhatsApp, mapas etc. passam direto

  // Abrir o app: internet primeiro (versão mais nova); sem internet ou lenta, usa a guardada
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const resp = await fetch(req, { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp && resp.ok) {
          const cache = await caches.open(CACHE);
          cache.put('./index.html', resp.clone());
        }
        return resp;
      } catch (e) {
        return paginaOffline();
      }
    })());
    return;
  }

  // Demais arquivos: usa o guardado e atualiza em segundo plano
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(req, { ignoreSearch: mesmaOrigem });
    const rede = fetch(req).then(resp => {
      if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
      return resp;
    }).catch(() => null);
    if (guardado) { event.waitUntil(rede); return guardado; }
    const resp = await rede;
    return resp || new Response('', { status: 504 });
  })());
});
