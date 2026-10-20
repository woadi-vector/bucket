# PayPal AI Hackathon changelog

The hackathon accepts existing projects that make meaningful progress during the submission
period (from Oct 1, 2026, 9:15am PT). Bucket existed before: a budgeting app where you tag
purchases want or need and wants over a threshold wait a day, built in May 2026 and extended for
the Nebius x NVIDIA hackathon (`main` branch).

Everything below was built during the PayPal submission period, on the `paypal` branch. The
commit history is the record; this file summarizes it.

## Before Oct 18: spike and spec

- **Oct 13.** Entry specified: Bucket as the brake on a shopping agent, built on PayPal's
  authorize and capture model.
- **Oct 18, morning.** PayPal sandbox spike, run by hand: a saved PayPal wallet funds an
  `AUTHORIZE` order with no buyer present; hold, void, capture and the `custom_id` bucket stamp
  all verified. Found and documented the token-scope trap (`docs/paypal-findings.md`).

## Oct 18: the build

- **Payments module.** PayPal REST client (Orders v2, Payments v2, Vault v3), the `holds` ledger,
  and the only module that moves money: place a hold, keep it, let it go, sweep expired holds.
  Idempotency keys per hold and action; reconciliation from PayPal's record after a failed call.
  38 checks, plus a live sandbox probe.
- **Separate Worker.** `bucket-paypal` with its own D1 database, so the Nebius deployment is never
  touched.
- **Public endpoints.** `/api/ledger` (every hold, with PayPal's ids) and `/api/policy/check` (the
  capture-or-hold rule, callable by any agent).
- **Bucket tags.** Each bucket is a need or a want, set when it is created.
- **Shopping agent.** Channel3 search, Nemotron Super choosing a product and a bucket without
  seeing which buckets are needs, the existing screen for need buckets, a deterministic rule, and
  the PayPal hold.
- **Interface.** Send your agent shopping; a PayPal tab with live holds, authorization ids,
  countdowns, keep and let go; the need-or-want choice on new buckets; the public `/ledger` page.

## Oct 18: fixes from live runs

Each found by running the real services, not by the tests:

- The agent bought an oat-milk-named skin care kit as groceries. Categories were being dropped.
- Then it declined good running shoes. The decline rule was too strict.
- Then the real cause: Channel3 returns category paths as objects, and every model had been
  reading "[object Object]". Fixed, and the test fake now uses the live shape.
- With readable categories, Nano still picked the kit. The agent moved to Nemotron Super and must
  state whether its pick fits.
- On the deployed build, Super bought an oat milk strainer bag ("for making oat milk"). Added a
  second model that checks the pairing and can overrule the agent.
- Small wants were labeled "a need" on the ledger; Savings was offered to the agent as a bucket to
  buy from. Both fixed.

## Oct 18, evening: the ledger as a working table

- **Refusals recorded.** A decline or an overrule never creates a PayPal order, so it used to
  leave no trace. A `refusals` table (migration 0006) now records each one with the request, the
  product the second check refused, and the model's stated reason.
- **Ledger rebuilt with AG Grid and AG Charts.** Holds and refusals in one sortable, filterable,
  searchable grid, with a CSV export and a pinned total row. A bar chart of dollars by outcome is
  drawn from the grid's filtered rows. Both libraries load on `/ledger` only.
- **25 ledger checks** (`npm run check:ledger`) on how rows, totals and chart sums are computed.

## Oct 19: pushback on every want, and where released money goes

From the call with Melissa (the idea is hers).

- **Every want gets a stated reason when one exists.** Bucket checks the person's own records:
  would the purchase overdraw its bucket, counting money already on hold; was something like it
  bought, let go, or left waiting in the last 45 days. Any reason holds the want, however small,
  and the reasons are stored with the hold (migration 0007) and shown in the shop card, the PayPal
  tab and the public ledger. No model is involved: a reason has to be a fact the person can check.
- **Released money: stays in its bucket, or set aside in Savings.** PayPal releases the hold
  either way. A setting in the PayPal tab decides where the amount lands in the app; each hold is
  counted once, including holds the clock releases while the app is open.
- 12 new shop checks and 4 new ledger checks.
- **Restraint carried over from the Nebius build.** A model's doubt about a need now holds the
  purchase only when the model is confident (the same floors as `src/engine/restraint.ts` on
  `main`); a weaker doubt is logged in the exchange log and the purchase goes through. The
  factual pushback on wants is unchanged: a checkable fact is always worth saying.
