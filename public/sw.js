'use strict';

importScripts('/offline-queue.js');

// Bump these (either one) whenever SHELL_URLS/CDN_SHELL_URLS changes --
// activate() below deletes any cache whose name doesn't match, so an old
// version's stale entries never linger past a deploy.
const SHELL_CACHE = 'kisan-shell-v2';
const RUNTIME_CACHE = 'kisan-runtime-v2';

// Every page under public/, plus the local assets each one loads -- the
// "app shell" CLAUDE.md's offline-first non-negotiable calls for.
// farmer.html, queue.html and board.html are the ones actually named
// there, but caching the rest costs nothing and keeps every entry point
// (most often login.html -- see manifest.json's start_url) working
// offline too. No '/' entry: express.static serves no index.html here,
// so the bare root 404s the same with or without this worker.
const SHELL_URLS = [
  '/login.html',
  '/farmer.html',
  '/farmer_registration.html',
  '/queue.html',
  '/board.html',
  '/dashboard.html',
  '/declaration.html',
  '/theme.css',
  '/validation.js',
  '/offline-queue.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/vendor/qrcode.min.js',
];

// Third-party scripts the shell pages load from a CDN instead of
// bundling (see CLAUDE.md's stack note -- no build step). Precached
// best-effort with mode:'no-cors': these hosts are cross-origin and this
// worker only ever needs to replay the bytes back to a <script> tag,
// never read them, so an opaque response is fine. A miss here isn't
// fatal either -- the runtime cache-on-fetch handler below still catches
// it the first time it's fetched online. Font Awesome and qrcodejs used
// to be listed here too; both are now local (see SHELL_URLS' own
// /vendor/qrcode.min.js and farmer.html's inline SVG tab icons) --
// offline-first no longer depends on cdnjs.cloudflare.com at all.
const CDN_SHELL_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/html5-qrcode@2/html5-qrcode.min.js',
  'https://cdn.tailwindcss.com/',
];

// Hosts it's safe to opportunistically cache-on-fetch -- lets requests
// for CDN assets not listed above get cached the first time they're
// actually used, without turning this into a general cross-origin cache.
const RUNTIME_CACHE_HOSTS = ['unpkg.com', 'cdn.tailwindcss.com'];

// A real (default, CORS-mode) fetch, not forced no-cors -- required for
// react.production.min.js/react-dom.production.min.js specifically,
// which farmer.html/login.html/etc. load with a `crossorigin` attribute
// (so React gets readable stack traces): a `<script crossorigin>` tag
// refuses to execute an opaque no-cors response, even one cached for
// the exact same URL, so serving one back from here would silently
// break every page that loads React. unpkg.com sends
// Access-Control-Allow-Origin: *, so this succeeds for everything this
// app actually loads from it; falls back to no-cors for the one host
// that doesn't (cdn.tailwindcss.com), which is fine there since nothing
// loads it with `crossorigin` either.
async function fetchCdnAsset(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return fetch(request, { mode: 'no-cors' });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Every one of these is a real local file (see the file list
      // above) -- if any 404s, addAll rejects and installation fails
      // loudly, which is the point: a typo here should never ship as a
      // silently-incomplete offline shell.
      await cache.addAll(SHELL_URLS);

      await Promise.all(
        CDN_SHELL_URLS.map(async (url) => {
          try {
            await cache.put(url, await fetchCdnAsset(url));
          } catch (err) {
            // Offline on first install, or this one CDN host is down --
            // not fatal (see the comment on CDN_SHELL_URLS above).
          }
        })
      );

      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL_CACHE && n !== RUNTIME_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

function isShellRequest(url) {
  return url.origin === self.location.origin && SHELL_URLS.includes(url.pathname);
}

function isRuntimeCacheable(url) {
  return RUNTIME_CACHE_HOSTS.includes(url.host);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Anything but a GET -- every POST included -- is left completely
  // alone here; offline-queue.js's fetchOrQueue is what makes those
  // resilient, at the call site, not this worker.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isShellRequest(url)) {
    // Cache-first: these change only on a deploy (a new SW version),
    // never per request, so there's no reason to hit the network first
    // just to get the same bytes back.
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          cache.put(request, res.clone());
          return res;
        } catch (err) {
          // Only reachable if this exact shell URL somehow wasn't
          // precached above AND the network is down.
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  if (isRuntimeCacheable(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetchCdnAsset(request);
          cache.put(request, res.clone());
          return res;
        } catch (err) {
          return new Response('', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  // Everything else -- every /api/* call included -- is left
  // unintercepted: always goes straight to the network, so nothing here
  // can ever serve stale live data (queue positions, booking status,
  // ...) in place of a real, current answer.
});

// Replays the offline outbox once the browser signals connectivity is
// back, even with no page open to catch the 'online' event itself (see
// offline-queue.js, which registers this tag from enqueue()). Background
// Sync is Chrome/Edge-only; Firefox/Safari fall back to whichever page
// is next opened catching up via offline-queue.js's own 'load' listener.
self.addEventListener('sync', (event) => {
  if (event.tag === 'kisan-outbox-flush') {
    event.waitUntil(self.KisanOutbox.flush());
  }
});
