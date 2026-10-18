# Deploying the PayPal build

The PayPal entry is the `paypal` branch, deployed as its own Worker (`bucket-paypal`) with its
own database (`bucket-paypal-db`). The Nebius entry stays on `main` as the Worker `bucket`.
Deploying one never touches the other, as long as each is deployed from its own branch.

**Do not merge `paypal` into `main` before Dec 15, 2026.** Both entries are judged Dec 1 to 15,
and a merge would point the Nebius deployment at this branch's Worker name and database.

All commands run from the repo folder on the `paypal` branch. Check first:

```bash
git branch
```

_Check:_ the star is on `paypal`.

---

## 1. Create the database (once)

```bash
npx wrangler d1 create bucket-paypal-db
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing
`REPLACE_WITH_PAYPAL_D1_DATABASE_ID` (done Oct 18: `61017189-9e4e-4704-8003-ffb0516776e0`). The id is not a secret; commit it.

_Check:_ the `database_id` line in `wrangler.jsonc` shows a uuid.

## 2. Create the tables

```bash
npm run db:migrate:remote
```

_Check:_ five migrations report ✅, ending with `0005_paypal_holds.sql`. Then:

```bash
npm run db:tables
```

Expect `holds` in the list alongside `sessions`, `transactions`, `model_usage`, `exchanges`.

Use the npm scripts, never a bare `wrangler d1 migrations apply`: see the warning in
[deploy.md](deploy.md), step 3. The scripts on this branch already point at `bucket-paypal-db`.

## 3. Set the secrets

The first deploy creates the Worker, so run the build and deploy once before setting secrets if
`secret put` complains that the Worker does not exist.

```bash
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put PAYPAL_DEMO_VAULT_ID
npx wrangler secret put NEBIUS_API_KEY
npx wrangler secret put CHANNEL3_API_KEY
```

Use the sandbox app whose "Save payment methods" was on before its first token
(`bucket-sandbox-3`); see [paypal-findings.md](paypal-findings.md). `PAYPAL_DEMO_VAULT_ID` is the
saved sandbox wallet's payment token.

_Check:_ `npx wrangler secret list` shows all five names.

## 4. Deploy

```bash
npm run build
npx wrangler deploy
```

_Check:_ it prints a `https://bucket-paypal.<your-subdomain>.workers.dev` URL, not
`https://bucket.…`. If it says `bucket`, you are on the wrong branch: stop.

## 5. Verify

```bash
curl https://bucket-paypal.<your-subdomain>.workers.dev/api/ledger
```

_Check:_ `{"holds":[],"generatedAt":"…"}` on a fresh database.

```bash
curl -X POST https://bucket-paypal.<your-subdomain>.workers.dev/api/policy/check -H "content-type: application/json" -d "{\"bucketTag\":\"want\",\"amountCents\":8999}"
```

_Check:_ `{"decision":"hold","reason":"A want over $40.00. Holding it to sleep on."}`

---

## The clock

`HOLD_WINDOW_MINUTES` in `wrangler.jsonc` is 5 for the demo, so a judge can watch a hold expire.
The product value is 1440 (24 hours). Change it without a code edit:

```bash
npx wrangler deploy --var HOLD_WINDOW_MINUTES:1440
```

Expired holds are voided whenever the holds are read: the ledger, the tray, any decision. There is
no scheduled job to forget about. A person who tries to keep a want after its window gets
`expired`, and the hold is voided by the clock instead.
