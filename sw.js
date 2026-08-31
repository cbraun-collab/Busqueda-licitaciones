const CACHE = 'explorador-licitaciones-v1';
const ARCHIVOS = ['./index.html', './manifest.json'];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ARCHIVOS); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

// Network-first: siempre intenta traer la versión más reciente; solo cae al
// cache si no hay conexión. Evita quedarse pegado en una versión vieja de la app.
self.addEventListener('fetch', function(e){
  e.respondWith(
    fetch(e.request).then(function(resp){
      const copia = resp.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, copia); });
      return resp;
    }).catch(function(){ return caches.match(e.request); })
  );
});
