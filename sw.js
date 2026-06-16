/**
 * 🆕 [V4.1.0] UX-G — Akailao Service Worker
 * 策略：Network-first（總是嘗試拿最新版），失敗才回 cache。
 * 新版部署後 => updatefound 事件 => 前端 Toast 通知老師重整。
 */

const CACHE_NAME = 'akailao-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request)
          .then(cached => cached || caches.match('/Akailao/') || Response.error())
      )
  );
});
