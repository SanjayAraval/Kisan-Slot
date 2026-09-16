'use strict';

// Opt-in request deduplication for the POST endpoints on the offline-sync
// critical path (register, book, gate scan/serve -- see CLAUDE.md's
// "offline-first" non-negotiable and the client-side outbox in
// public/offline-queue.js). A request queued while offline is replayed
// once the device reconnects, sometimes more than once if the reply to
// an earlier replay never made it back (a flaky connection can drop the
// response after the server already applied it) -- without this, a
// retried booking could double-book a slot and a retried gate scan could
// re-run a check-in. The client sends the same Idempotency-Key on every
// replay of one queued request; if that (key, route) pair already
// produced a response, this returns the stored response verbatim instead
// of re-running the handler.
//
// Entirely opt-in: a request with no Idempotency-Key header is untouched,
// so this adds no risk to any caller that doesn't use it.
//
// Call `idempotentReplay` first, immediately after whatever authorization
// check gates the route (so a stale/guessed key can only ever replay a
// response the caller was already entitled to see) -- if it returns true,
// the response has already been sent and the route handler must not run.
// Otherwise call `recordIdempotentResponse` right after, before any
// business logic, so whatever response the handler eventually sends gets
// captured.
//
// Known gap: two replays of the very same key landing at the exact same
// instant could both miss the initial SELECT and both run the handler --
// the outbox this exists for flushes single-flight (see offline-queue.js
// flush()), so concurrent replays of one key aren't expected in practice,
// but this isn't fully closed against them.
async function idempotentReplay(pool, req, res) {
  const key = req.get('Idempotency-Key');
  if (!key) return false;

  const route = `${req.method} ${req.originalUrl}`;
  const result = await pool.query(
    'SELECT route, response_status, response_body FROM idempotency_keys WHERE key = $1',
    [key]
  );
  const row = result.rows[0];
  if (!row) return false;

  if (row.route !== route) {
    res.status(422).json({ status: 'BAD_REQUEST', message: 'Idempotency-Key was already used for a different request' });
    return true;
  }

  res.set('Idempotency-Replayed', 'true');
  res.status(row.response_status).json(row.response_body);
  return true;
}

function recordIdempotentResponse(pool, req, res) {
  const key = req.get('Idempotency-Key');
  if (!key) return;

  const route = `${req.method} ${req.originalUrl}`;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.json = originalJson;
    // Never record a 5xx -- that means the handler itself failed, not
    // that it produced a real, replayable outcome, so the client should
    // be free to just try again from scratch.
    if (res.statusCode < 500) {
      pool
        .query(
          `INSERT INTO idempotency_keys (key, route, response_status, response_body)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (key) DO NOTHING`,
          [key, route, res.statusCode, JSON.stringify(body)]
        )
        .catch((err) => console.error('failed to record idempotency key', err));
    }
    return originalJson(body);
  };
}

module.exports = { idempotentReplay, recordIdempotentResponse };
