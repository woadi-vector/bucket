# Bucket for PayPal

**Your shopping agent can buy. Bucket decides whether it should.**

Agentic checkout removes the moment where you feel a purchase. Bucket puts that moment back,
only where it belongs. You sort your money into buckets and decide once, calmly, which are for
needs and which are for wants. A shopping agent then buys on your behalf through PayPal, and every
purchase it makes is held to the call you made: needs go straight through, and a want over its
bucket's threshold waits as a **live PayPal authorization** until you keep it or let it go. Let it
go, and the hold is voided at PayPal and the money is yours again.

**Try it:** <https://bucket-paypal.jason-wold.workers.dev> (no login, sandbox money)

**Public ledger of every hold:** <https://bucket-paypal.jason-wold.workers.dev/ledger>

> This is the `paypal` branch, the PayPal AI Hackathon entry. The `main` branch is a separate
> entry (Nebius x NVIDIA) built on the same engine with a different subject.

---

## What happens when the agent shops

Type "trail running shoes" and a price ceiling. In about ten seconds:

1. **Search.** Channel3 returns real listings under your ceiling, from many retailers.
2. **Choose.** Nemotron Super picks one product and files it into one of your buckets. It is
   never told which buckets are needs, so it cannot route a purchase around a pause. It may
   decline when nothing listed is what you asked for.
3. **Second check.** A separate model (Nemotron Nano, temperature 0) is asked one narrow
   question: is this product the thing that was requested? Its "no" overrules the agent.
4. **Screen.** If the bucket is a need, the purchase is checked against your own history: does
   this actually read like a need for you? A doubt turns it into a hold.
5. **Rule.** Code, not a model, decides: a need passes; a want at or over its bucket's threshold
   is held; a doubted need is held.
6. **PayPal.** The order is placed from your saved PayPal wallet with `intent: AUTHORIZE`, so the
   money is reserved, not taken. A pass is captured immediately. A hold waits in the PayPal tab
   with its authorization id and a countdown.

Then you decide. **Keep it** captures the authorization. **Let it go** voids it. Do nothing and
the clock voids it when the window closes (24 hours in the product, 5 minutes in this demo).

On a live run the agent once picked an oat milk strainer bag for "oat milk", reasoning that it is
"for making oat milk". The second check overruled it and nothing reached PayPal. That is the
design: a model will sometimes be wrong, so no model's answer is the last word on money.

---

## How PayPal is used

All money movement uses PayPal's REST APIs in the **sandbox**. Server code calls them with
`fetch`; nothing PayPal-related runs in the browser.

| Step | PayPal API | What it does in Bucket |
| --- | --- | --- |
| Save the wallet (once) | `POST /v3/vault/setup-tokens`, buyer approval, `POST /v3/vault/payment-tokens` | The buyer's PayPal wallet is saved so the agent can pay without a popup per purchase |
| Agent buys | `POST /v2/checkout/orders` with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` | PayPal completes the order and places a hold in one call, with no buyer present |
| Bucket on the record | `purchase_units[0].custom_id` | The bucket id is stored on PayPal's own order record and checked on the way back |
| Keep it | `POST /v2/payments/authorizations/{id}/capture` | Takes the held money |
| Let it go, or time runs out | `POST /v2/payments/authorizations/{id}/void` | Releases the held money |
| Reconcile | `GET /v2/payments/authorizations/{id}` | After a failed call, records what PayPal says actually happened |

Every money-moving call sends a `PayPal-Request-Id` derived from the hold and the action
(`<hold>:authorize`, `<hold>:capture`, `<hold>:void`), so a retry repeats the original request
instead of moving money twice. The hold window is capped inside PayPal's 3-day honor period.

Bucket's policy is also available to any agent, not only its own:

```bash
curl -X POST https://bucket-paypal.jason-wold.workers.dev/api/policy/check \
  -H "content-type: application/json" \
  -d '{"bucketTag":"want","amountCents":8999}'
# {"decision":"hold","reason":"A want over $40.00. Holding it to sleep on."}
```

Code: [`src/lib/server/paypal.ts`](src/lib/server/paypal.ts) (the client),
[`src/lib/server/payments.ts`](src/lib/server/payments.ts) (the only module that moves money),
[`src/lib/server/holds.ts`](src/lib/server/holds.ts) (the ledger).

---

## How AI is used

All models are NVIDIA Nemotron, served by **Nebius Token Factory**.

| Role | Model | Input | Output |
| --- | --- | --- | --- |
| Shopping agent | `nvidia/nemotron-3-super-120b-a12b` | Your request, the listings with category and seller, your bucket names | One product and one bucket, or a decline |
| Second check | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | The request and the chosen product | Is this the requested item: yes or no |
| Screen (need buckets) | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, escalating to `nvidia/Nemotron-3-Ultra-550b-a55b` when contested | The purchase and your spending history | Need or want, with a reason and a question |

**What no model can do.** Model outputs are a product number, a bucket id, a yes or no, and a
need-or-want word. Code turns those into a decision and into PayPal calls. No model holds a tool
that captures or voids, none can create a bucket or change its tag, and a model's opinion can add
a hold but never remove one. A check in the test suite fails the build if anything from the AI
engine appears in the payments module's import graph.

**Product search:** [Channel3](https://trychannel3.com) (`POST /v1/search`), with your price
ceiling passed as a filter.

---

## Check it without trusting us

- **The ledger** at [`/ledger`](https://bucket-paypal.jason-wold.workers.dev/ledger) lists every
  hold the demo has placed, with PayPal's authorization id, the bucket, and the outcome
  (captured, released by the person, released by the clock). Released holds stay on the list.
  The same data is JSON at `/api/ledger`. Rows carry no visitor identifier.
- **Declines show their work.** When the agent buys nothing, the card lists every listing it
  looked at, with price, seller and category, so you can judge the decline yourself.
- **The tests are the claims.** Each thing the demo video says about money is a check:

```bash
npm run check:payments   # 38 checks: holds, keep, let go, races, expiry, reconciliation, the AI boundary
npm run check:shop       # 40 checks: agent, second check, screen, rule, declines, injected catalog text
```

Both run against fakes that answer with the shapes the real services returned. To run the same
code against the real sandbox: `npm run probe:paypal` and `npm run probe:shop`.

---

## Run it yourself

Needs Node 20+, a PayPal sandbox app, a Nebius Token Factory key and a Channel3 key.

```bash
git clone -b paypal https://github.com/woadi-vector/bucket.git
cd bucket
npm install
cp .dev.vars.example .dev.vars   # then fill in the values it lists
npm run check:payments           # no keys needed
npm run check:shop               # no keys needed
npm run dev                      # http://localhost:8080
```

**PayPal sandbox setup.** In developer.paypal.com (Sandbox), create an app and turn on **Save
payment methods** before anything requests a token. PayPal reuses a token for hours and its
permissions are fixed when it is issued, so a token issued before the feature was on never gains
it. Then save a sandbox buyer's wallet once and put its payment token id in
`PAYPAL_DEMO_VAULT_ID`. The full story, including how this cost a morning, is in
[`docs/paypal-findings.md`](docs/paypal-findings.md).

Deploying to Cloudflare Workers: [`docs/deploy-paypal.md`](docs/deploy-paypal.md).

---

## Stack

TanStack Start and React on Cloudflare Workers, with D1 for buckets and holds. PayPal Orders v2,
Payments v2 and Vault v3 (sandbox). NVIDIA Nemotron on Nebius Token Factory. Channel3 product
search.

## Team

Jason Wold (build) and Melissa Stone (concept; Bucket is her idea, and the pain-of-paying framing
from Prelec and Loewenstein, 1998, that explains why it works).

## License

MIT. See [LICENSE](LICENSE).
