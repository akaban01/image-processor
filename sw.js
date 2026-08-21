/**
 * Service worker: makes the converter work offline.
 *
 * The app itself is a few dozen kilobytes of static files with no API calls, so
 * all of it is precached on install and served from the network with the cache
 * as the fallback.
 *
 * `vendor/` is deliberately not in that list. The matting runtime and its
 * weights are about 25 MB, and precaching them would make every visitor pay for
 * a feature most never use. They are fetched the first time someone ticks
 * "Replace the background", and the same network-first handler caches them on
 * the way past — so the second time works offline like everything else. Offline still works; online always gets the deploy
 * that is actually live.
 *
 * It used to be stale-while-revalidate, which is faster but hands back one
 * version behind. A navigation is network-first, so a deploy could pair the
 * new index.html with the previous app.js — which looks like a control the
 * markup declares and the script never fills in, on exactly one page load per
 * deploy. Cheap to lose a cached-response head start; expensive to debug.
 *
 * Bump CACHE when the file list changes — the old cache is deleted on activate.
 */

const CACHE = 'image-converter-v9';

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'css/styles.css',
  'js/app.js',
  'js/worker.js',
  'js/segment-worker.js',
  'js/lib/base64.js',
  'js/lib/batch.js',
  'js/lib/bytes.js',
  'js/lib/convert.js',
  'js/lib/documents.js',
  'js/lib/dpi.js',
  'js/lib/encode.js',
  'js/lib/formats.js',
  'js/lib/framing.js',
  'js/lib/geometry.js',
  'js/lib/intake.js',
  'js/lib/matte.js',
  'js/lib/segmenter.js',
  'js/lib/tensor.js',
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

async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Offline and not cached');
  }
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

  event.respondWith(networkFirst(request));
});
