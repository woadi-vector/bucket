-- Phase 4: what each verdict cost, and who spent it.
--
-- Two jobs. It is the evidence behind the tiering efficiency claim ("a transaction Nano
-- agrees with never touches Ultra"), and it is the ledger the budget guard reads before
-- allowing another paid call.
--
-- Apply locally:  npx wrangler d1 execute bucket-db --local --config wrangler.jsonc --file=migrations/0002_model_usage.sql
-- Apply remote:   npx wrangler d1 migrations apply bucket-db --remote

CREATE TABLE IF NOT EXISTS model_usage (
  id                TEXT    PRIMARY KEY,
  session_id        TEXT    NOT NULL,
  -- Which transaction or pending item this verdict was about, when known.
  subject_id        TEXT,
  tier              TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  -- Micro-dollars as an integer. Money in floats accumulates error, and this column is
  -- summed to decide whether to spend more.
  cost_micros       INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  -- 1 when the engine fell back rather than getting a real answer.
  degraded          INTEGER NOT NULL DEFAULT 0,
  -- 1 when the model agreed with the user's own tag, 0 when it contested it.
  agreed            INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_session ON model_usage (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_created ON model_usage (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_tier    ON model_usage (tier, created_at);
