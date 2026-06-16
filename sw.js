/**
 * 🆕 [V4.1.1] Akailao Service Worker — prompt-to-refresh 模式
 *
 * 關鍵設計：
 * ① BUILD_VERSION 由 deploy.yml sed 在每次 CI build 後注入（git short hash + 時間戳）
 *    → sw.js 每次 byte 都不同 → 瀏覽器一定偵測到更新 → updatefound 正確 fire
 * ② install 不自動 skipWaiting（prompt-to-refresh）
 *    → 新 SW 進 waiting → 前端 toast「有新版本」→ 使用者點「重整」→
 *    → SKIP_WAITING postMessage → activate → SW_ACTIVATED postMessage → reload
 * ③ activate 時清舊 CACHE_NAME → 避免多版本 cache 共存
 * ④ fetch: HTML navigate 走 network-first，確保總是拿最新 index.html
 */

const BUILD_VERSION = "__BUILD_VERSION__";
const CACHE_NAME = `akailao-${BUILD_VERSION}`;

self.addEventListener('install', () => {
  // 不呼叫 skipWaiting() — 讓使用者決定何時重整，避免打斷正在進行的課堂
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // 通知所有 client：新版 SW 已啟動（雙線偵測的線 B）
        return self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
          clients.forEach(client =>
            client.postMessage({ type: 'SW_ACTIVATED', version: BUILD_VERSION })
          );
        });
      })
  );
});

// 接收前端 SKIP_WAITING 指令（prompt-to-refresh：使用者點「重整」才切換）
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // HTML navigate：network-first（永遠拿最新 index.html，防 chunk 不匹配）
  if (event.request.mode === 'navigate') {
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
          caches.match(event.request).then(cached => cached || Response.error())
        )
    );
  }
});
