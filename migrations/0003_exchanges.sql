-- Phase 5: the clarification exchanges themselves.
--
-- This table exists to make one claim checkable by someone who does not trust us: that asking
-- a question before reclassifying a purchase reduces wrong challenges. That number is only
-- believable if the misses ship alongside the hits, so every contested purchase is recorded
-- here whether or not the explanation held, and whether or not the person bothered to answer.
--
-- A row is written the moment Bucket contests a tag. It is updated if and when the person
-- explains themselves. A row that never gets an explanation is not a failure to record — it
-- is the denominator: a challenge the person walked away from rather than argued with.
--
-- `model_usage` is the sibling table and answers a different question: what each call cost.
-- This one is about what was said.
--
-- Apply locally:  npx wrangler d1 execute bucket-db --local --config wrangler.jsonc --file=migrations/0003_exchanges.sql
-- Apply remote:   npx wrangler d1 migrations apply bucket-db --remote

CREATE TABLE IF NOT EXISTS exchanges (
  id                   TEXT    PRIMARY KEY,
  session_id           TEXT    NOT NULL,

  -- The purchase as the person entered it. Amount in whole currency units, matching
  -- `transactions.amount`.
  amount               REAL    NOT NULL,
  label                TEXT    NOT NULL,
  bucket_name          TEXT,
  readiness_tag        TEXT,

  -- What the person called it. The thing being contested.
  user_intent          TEXT    NOT NULL,

  -- The screening pass. `screening_verdict` always differs from `user_intent`, because an
  -- agreement is not an exchange and is not recorded here.
  screening_verdict    TEXT    NOT NULL,
  screening_confidence REAL    NOT NULL,
  screening_reasoning  TEXT,
  question             TEXT,

  -- The second pass. Null until the person answers; null forever if they never do.
  explanation          TEXT,
  final_verdict        TEXT,
  final_confidence     REAL,
  final_reasoning      TEXT,
  -- 1 when the explanation moved Bucket back to the person's own tag, 0 when it held its
  -- position. Derived from the verdict, never from the model's own claim about itself.
  explanation_accepted INTEGER,

  -- 1 when a fallback answered rather than a model: no key, budget guard, ceiling reached, or
  -- provider failure. These rows must be excluded from any accuracy claim, which is why the
  -- flag is stored rather than inferred later.
  degraded             INTEGER NOT NULL DEFAULT 0,

  created_at           INTEGER NOT NULL,
  answered_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_exchanges_created  ON exchanges (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_session  ON exchanges (session_id, created_at DESC);
-- The query behind the headline rate: of the challenges that were answered, how many held.
CREATE INDEX IF NOT EXISTS idx_exchanges_answered ON exchanges (explanation_accepted, degraded);
