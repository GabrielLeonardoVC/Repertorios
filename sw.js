// Service Worker do Repertório
// v9: anexos em IndexedDB + leitores de documentos + correções do PWA.
const CACHE = 'repertorio-v9';

const ARQUIVOS_LOCAIS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './libs/jszip.min.js'
];

const BIBLIOTECAS = [
  'https://unpkg.com/lucide@latest',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://raw.githubusercontent.com/Alpaq92/JSDoc/refs/heads/main/src/docToText.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap'
];

const HOSTS_CACHEAVEIS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'raw.githubusercontent.com'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ARQUIVOS_LOCAIS);
    await Promise.all(BIBLIOTECAS.map(async url => {
      try { await cache.add(new Request(url, { mode: 'no-cors' })); } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const mesmaOrigem = url.origin === self.location.origin;
  const hostCacheavel = HOSTS_CACHEAVEIS.includes(url.hostname);

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const resp = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', resp.clone());
        return resp;
      } catch (_) {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  if (mesmaOrigem || hostCacheavel) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const guardado = await cache.match(req);
      const buscar = fetch(req).then(resp => {
        if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
        return resp;
      }).catch(() => guardado);
      return guardado || buscar;
    })());
  }
});
