// Service worker: makes the app installable and lets the shell load offline.
// Network-first for the app's own files, never touches media or add-on traffic.
const CACHE = 'salotto-__BUILD__';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/version.js', 'js/addons.js', 'js/addon-runtime.js', 'js/player.js', 'js/cast.js', 'js/nav.js', 'js/focus.js', 'js/storage.js', 'js/epg.js', 'js/avsync.js', 'js/subtitles.js', 'js/zoom.js', 'js/whisper.js', 'js/whisper-worker.js', 'js/hls-audio.js', 'js/remote-host.js', 'js/vendor/qrcode.js',
  'remote/', 'remote/index.html', 'remote/manifest.webmanifest', 'remote.html', 'js/remote.js', 'css/remote.css',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'salotto-addon-data').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/proxy') || req.headers.has('range')) return;
  e.respondWith(
    // no-cache: always revalidate with the server, so a new release shows up at once
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
