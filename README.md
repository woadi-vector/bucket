# Bucket

**Every other budgeting app is a bookkeeper. Bucket interrupts the decision before the money
moves — and then argues with you about it.**

You tag a purchase a want or a need. Bucket reads that tag against your own spending history
and, when it disagrees, says so:

> You've now labeled three expensive tech/office items (standing desk, mechanical keyboard,
> headphones) as "needs" from your Dining Out bucket, all decided on the spot. The only actual
> dining expense (ramen) you correctly called a want. This pattern suggests you're rationalizing
> upgrades as necessities.
>
> — `nvidia/Nemotron-3-Ultra-550b-a55b`, on a real purchase in this app

It then **offers** to pull the purchase back so you can sleep on it. You can always say no.
Bucket advises; it does not enforce, and it does not predict.

---

## How NVIDIA Nemotron models are used

Two tiers, both served by **Nebius Token Factory**, and the split is the point.

| tier         | model                                   | when it runs                     |
| ------------ | --------------------------------------- | -------------------------------- |
| screening    | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | every tagged purchase            |
| adjudication | `nvidia/Nemotron-3-Ultra-550b-a55b`     | only when Nano contests your tag |

**Nano screens everything.** It is asked one question: does this person's own label hold up
against how they have labelled their own spending before?

**Ultra adjudicates only the contested calls.** When Nano disagrees with you, the 550B model is
asked the _same_ question independently — not "a smaller model objected, what do you think?",
which would invite deference and make scoring the two tiers against each other meaningless.

Measured from this app's own ledger, one contested purchase:

| tier  | prompt | completion | cost    | latency |
| ----- | ------ | ---------- | ------- | ------- |
| nano  | 363    | 269        | 64 µ$   | 2160 ms |
| ultra | 363    | 425        | 1576 µ$ | 2528 ms |

Ultra costs **24.6x** a Nano call for 1.25x the tokens. Stated precisely: the saving comes from
price per token, not from the cheap tier doing less work.

**Neither call ever blocks you.** Both tiers are seconds-scale, so the verdict is fired without
being awaited and attaches whenever it lands. The interception screen stays the half-second beat
it was designed to be.

## Where Token Factory fits

Everything reaches Token Factory's OpenAI-compatible API at
`https://api.tokenfactory.nebius.com/v1` through a single adapter,
[`src/engine/token-factory-adapter.ts`](src/engine/token-factory-adapter.ts). Swapping providers
means writing one adapter and touching nothing else.

The API key is a Cloudflare Workers secret, read server-side only. A committed check,
[`scripts/check-no-secret-in-bundle.mjs`](scripts/check-no-secret-in-bundle.mjs), scans the built
client output for both the key's value and its name and fails the build path if either appears.

**We probed the API before building on it, and four widely-repeated assumptions were wrong.**
Model ids are namespaced `nvidia/` and the commonly-cited `Llama-3_1-Nemotron-Ultra-253B-v1`
does not exist. The `reasoning_content` quirk does not reproduce. Tool calls work fine. And the
real hazard is `max_tokens`: set it too low and the API returns **HTTP 200 with an empty content
string**, which reads like a bad prompt rather than a truncation.

All of it, with raw numbers and the measurements that corrected our own first conclusions:
**[docs/token-factory-findings.md](docs/token-factory-findings.md)**. Re-runnable via
`node scripts/probe-token-factory.mjs`.

## The verdict engine is a separate thing from the app

[`src/engine/`](src/engine/) is standalone. It imports nothing from React, the components, or the
routes; history is passed in rather than read from storage; callers supply a transport adapter but
never choose a model. The boundary is enforced by `no-restricted-imports` in `eslint.config.js`,
not by convention.

The test is whether it runs with the rest of the app deleted:

```bash
npx esbuild src/engine/index.ts --bundle --platform=neutral --format=esm --outfile=engine.mjs
```

It bundles to ~11 KB with zero external imports. That is what lets the evaluation harness score
the engine against fixtures without standing up the app — and it is why the decision layer could
live somewhere other than this UI.

## Running it

Requires Node 20+.

```bash
npm install
cp .dev.vars.example .dev.vars    # then set NEBIUS_API_KEY
npm run dev                       # http://localhost:8080
```

`.dev.vars` is gitignored. Without a key the app still runs — the engine degrades to agreeing
with you rather than failing.

> **Note:** `.dev.vars` is a Wrangler file, and `npm run dev` is a plain Node Vite server with no
> Workers runtime, so it does not read that file on its own. A dev-only Vite plugin in
> `vite.config.ts` loads it into `process.env`. It deliberately does not go through `define` or
> `import.meta.env`, either of which would inline the secret into the client bundle.

### Designing without a key

Without a key the engine falls back to a stub that agrees with you and reports zero confidence.
That is deliberate — a stub that invented disagreement would be indistinguishable from a working
model on screen — but it also means the screens that matter most are unreachable.

Scenario markers are the exception. Put one in a purchase's label or note and the stub is forced:

| Marker    | Effect                                                             |
| --------- | ------------------------------------------------------------------ |
| `#want`   | Answers "want", whatever you tagged it                             |
| `#need`   | Answers "need", whatever you tagged it                             |
| `#low`    | With a forced verdict, confidence 0.25                             |
| `#high`   | With a forced verdict, confidence 0.95                             |
| `#accept` | In an explanation: the stub accepts it and comes round to your tag |

```
Headphones #want          tagged need → contested at 0.7, with a question
Headphones #want #low     the same, hedged
Groceries #need #high     tagged need → agreed at 0.95
```

Then answer the question. A plain answer is held; add `#accept` and it lands.

The marker stays visible in the label on screen, and the reasoning text begins `STUB SCENARIO` and
names the marker that caused it, so a forced answer can never be mistaken for a real one in a demo.
Nothing escalates off a forced disagreement either — `judgeTransaction` short-circuits when the
screening tier is `stub`, so the expensive tier is never reached and no spend is possible. Markers
do nothing once a real adapter is configured.

### The exchange log

Every purchase the model contested is recorded: the tag, the verdict, the question, the
person's answer, and whether that answer changed the verdict. `/exchanges?key=...` shows them
newest first, with the counts behind the only claim here worth checking, which is how often a
challenge survived contact with the person's reasoning.

Nothing is filtered. The challenges that collapsed as soon as someone explained themselves sit
beside the ones that held, because a rate you can only see the good half of is not evidence.
Rows where a fallback answered rather than a model are flagged `degraded` and excluded from
both rates rather than quietly improving them.

The page needs `EXCHANGES_KEY` set (see `.dev.vars.example`). Unset means closed, so the log
cannot be published by forgetting to configure something. The rest of the app has no login
on purpose; this page holds what people typed about their own spending, so it cannot.

### Checking the engine

```bash
npm run check:engine
```

Bundles `src/engine` on its own and runs `judgeTransaction` against fake adapters: the global
spend ceiling, escalation, and failing closed. It never calls Token Factory and needs no key.
`fetch` is replaced with one that throws, so a stray network call fails the run instead of
spending. One `[engine] ceiling check threw` error line in the output is expected.

```bash
npm run check:exchanges
```

Checks the arithmetic behind `/exchanges`: which rows are excluded from the rates, what the
denominator is, that a degraded second pass taints the whole exchange, that a reconsideration
arriving without its challenge id is still recorded, and that the log stays closed when
`EXCHANGES_KEY` is unset. Runs against the in-memory store, so it covers the semantics and not
the SQL; the SQL aggregate applies the same rules and is exercised against Miniflare below.
Two `EXCHANGES_KEY is not set` warnings in the output are expected.

### Against the real Workers runtime

`npm run dev` has no D1 binding and no Workers `env` — state falls back to an in-memory store. To
exercise the real thing locally (no Cloudflare account needed, Miniflare simulates D1):

```bash
npm run build
npm run db:migrate      # applies migrations to the local D1
npx wrangler dev --local
```

The `db:*` scripts all pass `--config wrangler.jsonc` deliberately: after a build, wrangler
otherwise follows `.wrangler/deploy/config.json` to the generated config and silently applies no
migrations at all.

### Deploying

See **[docs/deploy.md](docs/deploy.md)**.

## How it is built

TanStack Start + React 19 + Vite 7 + Tailwind 4, deployed to Cloudflare Workers via Nitro.
Per-visitor state persists in D1, keyed by an opaque `HttpOnly` cookie — **no login**, because a
judge should be able to open the URL and use it. Refresh and your data is there; a private window
gets a fresh seeded app.

| path                     | what it is                                                   |
| ------------------------ | ------------------------------------------------------------ |
| `src/engine/`            | the verdict engine — standalone, no app imports              |
| `src/lib/bucket/`        | store: pure reducer, provider, persistence, server functions |
| `src/lib/server/`        | session cookie, D1 store, spend ledger and budget guard      |
| `src/components/bucket/` | the product surfaces, including the retraction moment        |
| `migrations/`            | D1 schema                                                    |
| `docs/`                  | Token Factory findings, deploy runbook                       |

**Spend is capped.** The demo URL has no login, so anyone can trigger paid inference. A ledger in
D1 records every call with its tokens and cost. Before each Token Factory call the engine checks a
**global ceiling** on total verdicts, tokens and estimated dollars across all sessions — configured
as Wrangler vars (`GLOBAL_VERDICT_LIMIT`, `GLOBAL_TOKEN_LIMIT`, `GLOBAL_USD_LIMIT`), so it can be
changed without a code edit. Once any limit is reached, the model is no longer called and the app
serves a cached verdict clearly marked as such, while staying fully usable. It fails closed: if the
ledger cannot be read, it serves the cached verdict rather than risk unmetered spend. Per-session
caps sit alongside it. See [docs/deploy.md](docs/deploy.md#budget) and
[`src/lib/server/budget.ts`](src/lib/server/budget.ts).

## License

MIT — see [LICENSE](LICENSE).
