-- Phase 7: the disagreements Bucket decided not to mention.
--
-- Until now a row existed here only when Bucket contested a tag out loud, which quietly made
-- this table a record of the app at its most talkative. Two kinds of silence were invisible:
--
--   overruled  The cheap tier contested the person's tag, the expensive tier was asked the
--              same question and sided with the person, and the argument was dropped before
--              it reached them. This one rests on two models disagreeing, so it is the only
--              restraint in the app that does not depend on a model's opinion of itself.
--
--   unsure     The contest survived adjudication but the confidence behind it was under the
--              floor in src/engine/restraint.ts, so Bucket kept it to itself.
--
-- Recording these is the point rather than a detail. "Bucket disagreed with you 14 times and
-- mentioned 5 of them" is a claim about restraint, and the only reason to believe it is a
-- table that still holds the other 9. A filtered log would prove nothing, so nothing here
-- selects for the flattering rows: `withheld_reason` is null when Bucket spoke, set when it
-- did not, and no query needs to guess which it was.
--
-- `screening_*` keeps its meaning. On an overruled row it holds the cheap tier's contest, and
-- `overruled_*` holds the answer that beat it, which is why the two sit in separate columns
-- rather than one being overwritten by the other.
--
-- Apply locally:  npx wrangler d1 execute bucket-db --local --config wrangler.jsonc --file=migrations/0005_exchange_restraint.sql
-- Apply remote:   npx wrangler d1 execute bucket-db --remote --config wrangler.jsonc --file=migrations/0005_exchange_restraint.sql

-- 'overruled' or 'unsure'. Null means Bucket said it out loud.
ALTER TABLE exchanges ADD COLUMN withheld_reason     TEXT;

-- The expensive tier's answer when it overruled the cheap one. Null on every other row,
-- including an 'unsure' one, where nothing beat the contest and it was simply not stated.
ALTER TABLE exchanges ADD COLUMN overruled_verdict   TEXT;
ALTER TABLE exchanges ADD COLUMN overruled_reasoning TEXT;

-- The headline split: of the contests Bucket raised, how many it actually mentioned, and of
-- the ones it swallowed, which kind of silence each was. Partial so the index stays the size
-- of the withheld rows rather than the whole table.
CREATE INDEX IF NOT EXISTS idx_exchanges_withheld
  ON exchanges (withheld_reason, degraded)
  WHERE withheld_reason IS NOT NULL;
