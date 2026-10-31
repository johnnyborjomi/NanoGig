/*
 * Offline shell for the installed app: network-first for the page, cache-first for hashed assets.
 * `2.1.0-642ea9b-production` is replaced at build time (vite.config.ts) so every deploy ships a different sw.js;
 * the browser then installs the new worker, which WAITS until the page asks it to take over
 * (the "Update ready" bar posts SKIP_WAITING), so a running gig is never reloaded underneath you.
 */
const BUILD = '2.1.0-642ea9b-production';
const CACHE = 'nanogig-' + BUILD;
/** The page and the build's assets (filled in at build time), so the app opens offline after its first visit. */
const PRECACHE = ['./' ];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => undefined)))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
