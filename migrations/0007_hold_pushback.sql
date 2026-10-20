-- PayPal entry: the reasons Bucket gave for holding a want.
--
-- Every want now gets pushback from the person's own records (it would overdraw the bucket, or
-- something like it was bought, let go or is already on hold). The reasons are stored with the
-- hold so the PayPal tab and the public ledger show why it is waiting, as worded at the time.
-- A JSON array of strings; NULL for holds placed before this column existed.

ALTER TABLE holds ADD COLUMN pushback TEXT;
