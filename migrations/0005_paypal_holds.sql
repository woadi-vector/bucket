-- PayPal entry: holds placed through PayPal and what became of each one.
--
-- A hold is a live PayPal authorization: the buyer's money is reserved but not taken. Bucket
-- then does one of two things with it, and nothing else. It captures (the person kept the
-- purchase, or it was a need) or it voids (the person let it go, or the hold ran out). This
-- table is the ledger of those decisions, and it is meant to be published: every row carries
-- the PayPal authorization id, so anyone can check a row against PayPal's own record rather
-- than trusting ours.
--
-- Rows are never deleted and a voided hold is never hidden. The let-go is the point of the
-- product, so the voids are the rows most worth showing.
--
-- This migration lives on the `paypal` branch only. The PayPal build deploys as its own Worker
-- with its own database, so the Nebius deployment never sees these tables.
--
-- Apply locally:  npx wrangler d1 execute bucket-db --local --config wrangler.jsonc --file=migrations/0005_paypal_holds.sql
-- Apply remote:   npx wrangler d1 migrations apply <paypal database> --remote

CREATE TABLE IF NOT EXISTS holds (
  id               TEXT    PRIMARY KEY,
  session_id       TEXT    NOT NULL,

  -- The bucket the purchase was filed into, and that bucket's tag at the moment of purchase.
  -- The tag is copied rather than joined so a later edit to the bucket cannot rewrite why an
  -- old purchase was held.
  bucket_id        TEXT    NOT NULL,
  bucket_tag       TEXT    NOT NULL CHECK (bucket_tag IN ('need', 'want')),

  label            TEXT    NOT NULL,
  merchant         TEXT,
  -- Integer minor units (cents). Never a float: this column is compared against PayPal's.
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  currency         TEXT    NOT NULL DEFAULT 'USD',

  -- PayPal's identifiers. `authorization_id` is the one capture and void act on.
  order_id         TEXT    NOT NULL,
  authorization_id TEXT    NOT NULL UNIQUE,

  -- What the screen decided before any person was involved: pass straight to capture, or hold.
  verdict          TEXT    NOT NULL CHECK (verdict IN ('pass', 'hold')),

  -- held: money reserved, waiting on a person or the clock.
  -- deciding: a capture or void is in flight. Exists so two decisions racing on one hold
  --   produce exactly one PayPal call: whichever claims the row first wins.
  -- captured / voided: final.
  state            TEXT    NOT NULL
                   CHECK (state IN ('held', 'deciding', 'captured', 'voided')),

  -- Who moved it out of `held`. Never a model: the screen only ever produces `verdict` above.
  decided_by       TEXT    CHECK (decided_by IN ('user', 'policy', 'clock')),
  capture_id       TEXT,
  -- The last PayPal error seen on this hold, kept so a failed capture is visible, not silent.
  last_error       TEXT,

  created_at       INTEGER NOT NULL,
  -- When the clock voids it. Always inside PayPal's 3-day honor period.
  deadline_at      INTEGER NOT NULL,
  decided_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_holds_created  ON holds (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_holds_session  ON holds (session_id, created_at DESC);
-- The scheduled sweep: held rows whose deadline has passed.
CREATE INDEX IF NOT EXISTS idx_holds_due      ON holds (state, deadline_at);
