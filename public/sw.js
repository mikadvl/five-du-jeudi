// Service worker : app installable, coquille hors ligne, notifications push.
const CACHE = 'five-v8';
const SHELL = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/js/theme.js',
  '/js/lineup.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/fonts/geist-sans-latin-400-normal.woff2',
  '/fonts/geist-sans-latin-600-normal.woff2',
  '/fonts/bricolage-grotesque-latin-800-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Réseau d'abord pour la page, cache en secours
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  // Code de l'app (js, css, manifest) : réseau d'abord, pour que les mises à jour arrivent tout de suite
  if (/\.(js|css|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }
  // Polices et icônes : cache d'abord (elles ne changent pas)
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
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

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Five', body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Five', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag,
      renotify: !!data.tag,
      data: { url: data.url || '/#/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin)) {
          w.navigate(target).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
