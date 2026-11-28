const CACHE_NAME = 'dastyare-man-final-v107-mina-learning-365d';
const PHOTO_CODEC_CACHE = 'mina-photo-codecs-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== PHOTO_CODEC_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    const payload = { type: 'APP_VERSION', version: CACHE_NAME };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
    else if (event.source) event.source.postMessage(payload);
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = event.request.url || '';
  const isPhotoCodec = requestUrl.includes('cdn.jsdelivr.net/npm/heic2any@');
  const targetCache = isPhotoCodec ? PHOTO_CODEC_CACHE : CACHE_NAME;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((networkResponse) => {
        if (networkResponse && (networkResponse.status === 200 || (requestUrl.includes('f2e329e3-fe60-4a00-9d5e-1b2f236dd46a.png') && networkResponse.type === 'opaque'))) {
          const responseClone = networkResponse.clone();
          event.waitUntil(
            caches.open(targetCache)
              .then((cache) => cache.put(event.request, responseClone))
              .catch(() => {})
          );
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (!isPhotoCodec) return caches.match('./index.html');
        throw new Error('Photo codec is not cached yet');
      })
  );
});
