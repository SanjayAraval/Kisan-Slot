'use strict';

// Offline write outbox, shared between every page (loaded as a plain
// <script>) and the service worker (loaded via importScripts) -- see
// sw.js's 'sync' handler. Written with no DOM/window-only APIs so the
// same file works unmodified in both contexts: only indexedDB, fetch,
// BroadcastChannel and navigator, all of which exist in a service
// worker's global scope too.
//
// Covers the offline-sync critical path CLAUDE.md calls out (register,
// book, queue) -- see idempotency.js on the server for the other half of
// this: every queued request carries an Idempotency-Key minted once, at
// enqueue time, and reused on every replay, so a request that actually
// reached the server before a flaky connection dropped the response
// never gets double-applied when retried.
(function (global) {
  const DB_NAME = 'kisan-outbox';
  const DB_VERSION = 1;
  const STORE = 'requests';
  const CHANNEL_NAME = 'kisan-outbox';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Runs `work(store)` inside one transaction of the given mode, resolving
  // with whatever `work` resolves to once the transaction actually
  // commits (not just once `work`'s own request finishes) -- `work` must
  // issue its IndexedDB request synchronously so the transaction stays
  // alive long enough for it to complete.
  function runTx(mode, work) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const store = tx.objectStore(STORE);
          let value;
          let failed = false;
          Promise.resolve(work(store)).then(
            (v) => {
              value = v;
            },
            (err) => {
              failed = true;
              reject(err);
            }
          );
          tx.oncomplete = () => {
            if (!failed) resolve(value);
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function put(entry) {
    return runTx('readwrite', (store) => requestToPromise(store.put(entry)));
  }

  function removeEntry(key) {
    return runTx('readwrite', (store) => requestToPromise(store.delete(key)));
  }

  function list() {
    return runTx('readonly', (store) => requestToPromise(store.getAll())).then((entries) =>
      entries.slice().sort((a, b) => a.queuedAt - b.queuedAt)
    );
  }

  function count() {
    return runTx('readonly', (store) => requestToPromise(store.count()));
  }

  // Cross-tab/SW notification -- every page open on this origin and the
  // SW's background-sync handler all share one outbox, so a change made
  // in any one of them (queue a request here, flush it there) has to be
  // visible everywhere a "N pending, will sync" badge is showing.
  let channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (err) {
    // Safari < 15.4 has no BroadcastChannel -- each context just relies
    // on its own enqueue/flush calls to notify their own listeners; a
    // badge in another tab will catch up next time it calls count()
    // itself (e.g. its own online/load flush) rather than live-updating.
  }
  const listeners = [];
  function notifyChanged() {
    listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        /* a listener's own bug shouldn't break the others */
      }
    });
    if (channel) channel.postMessage('changed');
  }
  if (channel) {
    channel.onmessage = () => {
      listeners.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          /* ditto */
        }
      });
    };
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function genKey() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // `label` is a short human-readable description ("Book a slot",
  // "Register farmer", "Gate check-in") for the pending-sync UI -- never
  // parsed, purely cosmetic.
  async function enqueue({ url, method, headers, body, label }) {
    const key = genKey();
    const entry = {
      key,
      url,
      method: method || 'POST',
      headers: Object.assign({}, headers, { 'Idempotency-Key': key }),
      body: body || null,
      queuedAt: Date.now(),
      label: label || url,
    };
    await put(entry);
    notifyChanged();
    requestBackgroundSync();
    return entry;
  }

  function requestBackgroundSync() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => (reg.sync ? reg.sync.register('kisan-outbox-flush') : null))
      .catch(() => {
        // Background Sync isn't supported here (Firefox, Safari) -- the
        // 'online'/'load' listeners below are the fallback for those.
      });
  }

  let flushing = false;
  // Replays queued requests oldest-first, one at a time, stopping at the
  // first one that can't be delivered -- keeps requests applied in the
  // order they were queued (matters e.g. for two bookings by the same
  // farmer on different dates) and avoids hammering a connection that's
  // still down. Single-flight: a flush already running just gets its
  // outcome reused rather than starting a second, overlapping pass.
  let inFlight = null;
  function flush() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const synced = [];
      try {
        const entries = await list();
        for (const entry of entries) {
          let res;
          try {
            res = await fetch(entry.url, { method: entry.method, headers: entry.headers, body: entry.body });
          } catch (err) {
            break; // still unreachable -- stop, leave this and the rest queued
          }
          // Any HTTP response -- 2xx or 4xx -- means the server actually
          // received and answered this request; even a 409/400 is a
          // real, deterministic outcome, not a delivery failure. Only a
          // network-level failure (caught above) leaves an entry queued.
          await removeEntry(entry.key);
          synced.push({ key: entry.key, httpStatus: res.status });
        }
      } finally {
        inFlight = null;
        notifyChanged();
      }
      return { synced, remaining: await count() };
    })();
    return inFlight;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      flush().catch(() => {});
    });
    window.addEventListener('load', () => {
      if (navigator.onLine) flush().catch(() => {});
    });
  }

  // Drop-in replacement for a POST via fetchJson/postJson on the
  // offline-sync critical path: tries the network first, and only falls
  // back to the outbox when actually offline or when the attempt itself
  // fails at the network level (a real HTTP response, even an error
  // status, is never queued -- that's a completed request, not a dropped
  // one). Callers branch on `queued` to show a "saved, will sync" state
  // instead of treating the action as failed or, worse, silently lost.
  async function fetchOrQueue(url, options, label) {
    const opts = options || {};
    if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
      try {
        const res = await fetch(url, opts);
        const body = await res.json().catch(() => ({}));
        return { queued: false, httpStatus: res.status, body };
      } catch (err) {
        // fetch() itself threw -- genuinely unreachable, not an HTTP
        // error status (those resolve normally above) -- fall through.
      }
    }
    const entry = await enqueue({ url, method: opts.method || 'POST', headers: opts.headers, body: opts.body, label });
    return { queued: true, key: entry.key };
  }

  global.KisanOutbox = { enqueue, remove: removeEntry, list, count, onChange, flush, fetchOrQueue };
})(typeof self !== 'undefined' ? self : this);
