-- Phase 6: what Bucket looked up before it reconsidered.
--
-- The exchange log exists so the accuracy claim can be checked without trusting us. Once a
-- live search can feed the second pass, the log is incomplete without it: a reader needs to
-- know whether Bucket decided on the person's word alone or on the person's word plus a
-- finding, and they need to see the query to judge whether it was a fair one to run.
--
-- Nullable throughout, because no lookup is the normal case: no key configured, nothing worth
-- searching for, the provider down, or the result empty. Those are deliberately not
-- distinguished here — see src/engine/evidence.ts for why an outage must not be readable as a
-- finding.
--
-- Apply locally:  npx wrangler d1 execute bucket-db --local --config wrangler.jsonc --file=migrations/0004_exchange_evidence.sql
-- Apply remote:   npx wrangler d1 migrations apply bucket-db --remote

ALTER TABLE exchanges ADD COLUMN evidence_provider TEXT;
ALTER TABLE exchanges ADD COLUMN evidence_query    TEXT;
ALTER TABLE exchanges ADD COLUMN evidence_results  INTEGER;
