/**
 * Service worker: makes the converter work offline.
 *
 * The app is a few dozen kilobytes of static files with no API calls, so the
 * whole thing is precached on install. Navigations fall back to the cached
 * shell; everything else is stale-while-revalidate, which keeps the app
 * instant while still picking up a new deploy on the next visit.
 *
 * Bump CACHE when the file list changes — the old cache is deleted on activate.
 */

const CACHE = 'image-converter-v4';

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'css/styles.css',
  'js/app.js',
  'js/worker.js',
  'js/lib/batch.js',
  'js/lib/bytes.js',
  'js/lib/convert.js',
  'js/lib/documents.js',
  'js/lib/dpi.js',
  'js/lib/encode.js',
  'js/lib/formats.js',
  'js/lib/geometry.js',
  'js/lib/intake.js',
  'js/lib/naming.js',
  'js/lib/pipeline.js',
  'js/lib/pool.js',
  'js/lib/render.js',
  'js/lib/settings.js',
  'js/lib/zip.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Resolve against the registration scope so the worker keeps working when
    // the site is served from a subpath, as it is on GitHub Pages.
    const requests = PRECACHE.map(
      (path) => new Request(new URL(path, self.registration.scope), { cache: 'reload' }),
    );
    // One missing file must not fail the whole install.
    await Promise.allSettled(requests.map((request) => cache.add(request)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  const response = cached || (await network);
  if (response) return response;

  throw new Error('Offline and not cached');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match(new URL('index.html', self.registration.scope)))
          || (await cache.match(new URL('./', self.registration.scope)))
          || Response.error()
        );
      }
    })());
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
