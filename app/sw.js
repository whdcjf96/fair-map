/* 오프라인 지원 — 전시장 네트워크가 끊겨도 앱과 배치도가 뜨도록 캐시한다.
   앱 파일을 고칠 때는 CACHE 버전을 올려야 새 파일이 반영된다. */
const CACHE = 'fairmap-v20';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'data/busan2026.json',
  'data/map.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 캐시 우선 — 현장에서는 속도와 오프라인 동작이 최신성보다 중요하다.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // 뒤에서 조용히 갱신해 다음 방문 때 최신 파일을 쓰게 한다.
        fetch(e.request)
          .then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res)); })
          .catch(() => {});
        return hit;
      }
      return fetch(e.request).then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
