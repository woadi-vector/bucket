-- Bucket schema, Phase 2.
--
-- Apply locally:  npx wrangler d1 migrations apply bucket-db --local
-- Apply remote:   npx wrangler d1 migrations apply bucket-db --remote

-- One row per visitor, keyed by the opaque `bucket_sid` cookie. `state` is the full
-- serialized BucketState; the app reads this back verbatim on load.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  state      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Append-only mirror of confirmed purchases.
--
-- The session blob above is what the UI reads; this table exists to be *queried* --
-- Phase 4 logs which model produced which verdict against these rows, and the evaluation
-- set needs intent and readiness_tag to be first-class columns rather than buried in JSON.
CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT    NOT NULL,
  amount        REAL    NOT NULL,
  label         TEXT    NOT NULL,
  bucket_id     TEXT    NOT NULL,
  intent        TEXT    NOT NULL CHECK (intent IN ('want', 'need')),
  readiness_tag TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_session
  ON transactions (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_updated
  ON sessions (updated_at);
