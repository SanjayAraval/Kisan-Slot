-- Backs src/idempotency.js: lets a POST on the offline-sync critical path
-- (register, book, gate scan/serve) be safely replayed after a farmer or
-- gate officer's device reconnects, without re-running the handler and
-- double-booking a slot or double-checking-in a lot. `key` is the
-- client-generated Idempotency-Key (a UUID minted once per queued
-- request, reused on every replay of that same request -- see
-- public/offline-queue.js); `route` guards against one key being reused
-- against a different endpoint.
--
-- No expiry/cleanup job yet -- rows are small and this table only grows
-- as fast as offline-queued writes happen, which for a per-centre gate
-- queue is not fast. A nightly purge of rows past some retention window
-- (mirroring reallocationJob.js's nightly cadence) would be the natural
-- place to add one if this ever needs it.
CREATE TABLE idempotency_keys (
    key             TEXT PRIMARY KEY,
    route           TEXT NOT NULL,
    response_status SMALLINT NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
