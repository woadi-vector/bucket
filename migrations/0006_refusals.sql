-- PayPal entry: purchases the agent held back before any money moved.
--
-- The holds table records what reached PayPal. This one records what did not: the agent looked
-- at the listings and declined, or the agent picked something and the second check overruled
-- it. Neither creates a PayPal order, so without this table those refusals would leave no
-- trace, and a refusal nobody can count is a refusal nobody can check.
--
-- Rows are public on the ledger, like holds, and carry no visitor identifier.

CREATE TABLE IF NOT EXISTS refusals (
  id             TEXT    PRIMARY KEY,
  -- declined: the agent found nothing that is what was asked for.
  -- overruled: the agent picked a product and the second check said it is not the item.
  kind           TEXT    NOT NULL CHECK (kind IN ('declined', 'overruled')),
  request        TEXT    NOT NULL,
  max_cents      INTEGER,
  -- The product the agent picked, for an overrule. Null for a decline.
  product_title  TEXT,
  price_cents    INTEGER,
  merchant       TEXT,
  category       TEXT,
  -- The model's stated reason, clipped. The agent's for a decline, the checker's for an overrule.
  reason         TEXT    NOT NULL,
  -- How many listings were in front of the agent when it said no.
  considered     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refusals_created ON refusals (created_at DESC);
