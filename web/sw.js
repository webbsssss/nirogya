/**
 * Nirogya service worker.
 *
 * The demo-critical requirement is narrow and worth stating precisely: after one
 * successful load, the ASHA app must open and score patients with the phone in
 * airplane mode. That needs the shell and the model weights precached, and it
 * needs API traffic kept OUT of the cache.
 *
 * Strategy:
 *   app shell + weights  -> cache-first (instant, works offline)
 *   /api/*               -> network-only; api.js owns its own IndexedDB caching
 *                           so it can tell the user data is stale and when from.
 *
 * Caching /api/ responses here would be the classic mistake: the dashboard would
 * silently serve yesterday's counts with no staleness marker, and a judge asking
 * "is this live?" would get a confidently wrong answer.
 */

// Bumped whenever a precached file changes. The activate handler deletes every
// cache whose key is not this one, so a bump is what actually retires the old
// shell — without it, a phone that loaded the previous build keeps serving it.
const VERSION = 'nirogya-v2';

// EVERY file the app needs to boot. Not "the important ones": if one module in
// the import graph is missing here, the app still works offline by luck — the
// fetch handler below caches it on the first successful online load — but it
// breaks if the worker installs and the tab closes before that module is
// requested. Offline capability should not depend on load order.
//
// js/capability.js was missing from this list until it was noticed, and it is
// imported by js/app.js. tests/shell_test.mjs now walks the import graph and the
// index.html <script>/<link> tags and fails if anything is absent, because a
// human reading two lists side by side is exactly how this drifts.
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/risk.js',
  './js/api.js',
  './js/db.js',
  './js/voice.js',
  './js/capability.js',
  './js/sw-register.js',
  './data/model_weights.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll() rejects the whole batch if any single request 404s, which would
    // leave the app with no offline capability at all. Add individually so one
    // missing icon cannot cost us the entire precache.
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] precache miss', url, e); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Never cache the API. Freshness and staleness reporting belong to api.js.
  if (url.pathname.startsWith('/api/')) return;

  ev.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) {
      // Refresh in the background so the next load is current, but answer now.
      ev.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh.ok) await cache.put(req, fresh.clone());
        } catch {}
      })());
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
      return res;
    } catch (e) {
      // Navigation offline with nothing cached for that exact URL: fall back to
      // the shell so hash routes still resolve.
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
