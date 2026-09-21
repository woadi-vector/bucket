# Verdict engine

Decides whether a person's own `want` / `need` label on a purchase holds up against their own
spending history, and says why.

This module is deliberately standalone. Bucket's UI is one consumer of it, not the only place it
can live — the decision layer is the part a bank or credit union would care about, and that future
costs nothing to protect now and a rewrite later.

## Contract

```ts
import { judgeTransaction } from "@/engine";

const verdict = await judgeTransaction(
  {
    purchase: { amount: 240, label: "Headphones", intent: "need", readinessTag: "impulse" },
    history: [/* prior purchases, passed in by the caller */],
  },
  { adapter }, // omit to use the stub
);
// → { agrees, verdict, confidence, reasoning, telemetry? }
```

`judgeTransaction` is the only entry point, and its signature does not change between the Phase 1
stub and the real Phase 3 model call.

## Rules this module keeps

- **No app, no React.** It imports nothing from `src/components/`, `src/routes/`, `src/lib/`, or any
  React package. Enforced by `no-restricted-imports` in `eslint.config.js`, scoped to `src/engine/**`.
- **No storage access.** History is passed in. That is what lets the evaluation harness score the
  engine against fixtures without standing up the app.
- **Callers do not pick the model.** They supply an adapter, which is transport plus credentials.
  Model selection, prompting, tiering and parsing all happen in here.
- **It never throws.** A provider outage or an unparseable answer degrades to agreeing with the
  user, flagged as `telemetry.degraded`. Bucket advises; silence means no argument to make.
- **It spends only with permission.** An optional `checkCeiling()` hook is asked before every model
  call. The engine cannot see the spend ledger, so the caller answers; when the ceiling is reached
  the engine makes no call and returns a verdict marked `cached: true` that agrees with the user.
  If the hook throws, the engine fails closed and does the same.

`agrees` is derived by comparing the verdict to the user's own tag, never read from the model's
response — it drives escalation, and a model asked to restate a boolean it could compute will
eventually contradict itself.

## Verifying the boundary

The test is whether the engine runs with the rest of the application deleted:

```bash
npx esbuild src/engine/index.ts --bundle --platform=neutral --format=esm --outfile=engine.mjs
```

It should bundle with no external imports. As of Phase 1 it produces ~7 KB and pulls in nothing.

## Files

| file              | role                                                            |
| ----------------- | --------------------------------------------------------------- |
| `index.ts`        | entry point, tier selection, degradation                        |
| `types.ts`        | plain data types, re-declared rather than imported from the app |
| `adapter.ts`      | provider seam — also documents the `reasoning_content` quirk    |
| `prompt.ts`       | prompt construction                                             |
| `parse.ts`        | tolerant JSON extraction from reasoning-model output            |
| `stub-adapter.ts` | Phase 1 placeholder; always agrees, zero confidence             |

## Status

Phase 1. `createStubAdapter` returns a canned response through the real prompt and parse path, so
Phase 3 is a swap rather than a rewrite. The model ids in `MODELS` are **unverified** — the plan
requires checking them against `GET /v1/models` before trusting them.
