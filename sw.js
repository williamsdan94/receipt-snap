/* Receipt Snap — offline cache.
   Two caches:
   - the app shell (small files), versioned: bump SHELL on every publish so phones update.
   - the reading engine (big files in ./vendor/, about 7 MB), saved the first time a
     receipt is scanned, then reused. It keeps its own name so app updates don't
     re-download it. Bump OCR only if the files in vendor/ change. */
var SHELL = 'receipts-v1-2';
var OCR = 'receipts-ocr-v1';
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './parse.js',
  './styles.css',
  './manifest.webmanifest',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './vendor/tesseract.min.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Delete any old caches we don't use any more, then take over open pages.
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL && key !== OCR) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Big reading-engine files: use the saved copy if we have one, otherwise download once and save it.
var BIG = /\/vendor\/(worker\.min\.js|tesseract-core[\w-]*\.wasm\.js|eng\.traineddata\.gz)$/;

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (BIG.test(url.pathname)) {
    event.respondWith(
      caches.open(OCR).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  // Everything else: network first (so a new publish shows up), cache when offline.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(SHELL).then(function (cache) {
          cache.put(req, copy);
        });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
