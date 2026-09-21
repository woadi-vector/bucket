# Token Factory: what we found

Measured 2026-09-20 against `https://api.tokenfactory.nebius.com/v1`, using
[`scripts/probe-token-factory.mjs`](../scripts/probe-token-factory.mjs). Raw responses are
written to `probe-output/` (gitignored). Re-run with `node scripts/probe-token-factory.mjs`.

**Scope caveat, stated up front:** sections 1–4 come from a single probe run against a toy
prompt (80 tokens, no history). Section 5 re-measures latency with a realistic prompt over 3
runs per model, because the toy-prompt numbers turned out to be misleading — that correction
is the single most useful thing here. Everything was measured from one machine in the US with
no concurrency, so none of it is a benchmark and none of it says anything about p99 under
load. It is reported because it contradicts assumptions we were about to build on.

---

## 1. The model ids in circulation are wrong

Every model on the platform is namespaced. The ids we had been given do not resolve as written.

| What we expected                   | What `GET /v1/models` actually returns  |
| ---------------------------------- | --------------------------------------- |
| `NVIDIA-Nemotron-3-Nano-30B-A3B`   | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` |
| `nemotron-3-super-120b-a12b`       | `nvidia/nemotron-3-super-120b-a12b`     |
| `Llama-3_1-Nemotron-Ultra-253B-v1` | **does not exist**                      |
| —                                  | `nvidia/Nemotron-3-Ultra-550b-a55b`     |
| —                                  | `nvidia/Nemotron-3_5-Lightning`         |

The flagship Nemotron is a **550B MoE with ~55B active**, not the 253B model we had been
planning around. Anything reasoning about cost or latency from "253B" was reasoning about a
model that is not there.

24 models are available in total, including DeepSeek, Qwen, GLM, Kimi and gpt-oss families.

**Takeaway:** call `/v1/models` first. Do not hardcode an id from documentation.

---

## 2. The `reasoning_content` problem does not reproduce — but it is real on Ultra

The reported failure was that Nemotron models return their answer in `reasoning_content` with
`content` empty, so a parser reading `choices[0].message.content` silently gets nothing.

That is **not** what happens:

| Model | `content`                        | `reasoning_content`            |
| ----- | -------------------------------- | ------------------------------ |
| Nano  | 143 chars — the full JSON answer | absent                         |
| Ultra | 208 chars — the full JSON answer | 451 chars — the thinking trace |

So `content` is populated in both cases and an ordinary OpenAI-compatible parser works.
Ultra additionally exposes its reasoning trace in `reasoning_content`; it is a _supplement_,
never a replacement.

**Takeaway:** read `content`. Treat `reasoning_content` as optional extra worth logging —
it is genuinely useful product material, since it is the model's argument in longhand — but
do not build a parser that depends on it.

---

## 3. The real hazard is `max_tokens`, and it fails silently

This is the finding that would have cost us a day.

| `max_tokens` | `finish_reason` | `content`        | completion tokens |
| ------------ | --------------- | ---------------- | ----------------- |
| 256          | `length`        | **empty string** | 256 (all of it)   |
| 4096         | `stop`          | 143 chars        | 263               |

At 256 the call returns **HTTP 200 with a successful-looking response whose content is an
empty string.** No error, no warning. A caller that checks `res.ok` and then parses `content`
sees a blank and concludes the model refused, or that its own prompt was bad.

Note what this means for Nano specifically: it spent 256 tokens without emitting any content,
and needed 263 to produce a 143-character answer. Roughly **220 tokens of invisible work
before the first visible character** — Nano does not report `completion_tokens_details` at
all, so that spend is real, billed, and unobservable.

**Takeaway:** budget generously (4096 worked), and always check `finish_reason === "length"`
as a distinct failure from a parse failure. An empty `content` with HTTP 200 is not a model
that declined; it is a truncated response.

---

## 4. Tool calls work

The reported issue was that tool calls fail through the OpenAI-compatible wrapper. They did
not. Nano returned a well-formed `tool_calls` array with correctly typed arguments:

```json
{
  "id": "chatcmpl-tool-...",
  "type": "function",
  "function": {
    "name": "record_verdict",
    "arguments": "{\"confidence\": 0.8, \"verdict\": \"want\"}"
  }
}
```

`response_format: {"type":"json_object"}` is also honoured — clean JSON, no code fence, no
prose wrapper.

**Takeaway:** both structured-output mechanisms are available. We use `response_format`
rather than tool calls, since one JSON object is all we need.

---

## 5. Latency: prompt size dominates, and **neither** tier is fast

This section was initially wrong, and the correction is the most useful thing in this
document.

The probe used a toy prompt — 80 tokens, no history — and produced Nano at 985 ms and Ultra
at 1204 ms. From that we concluded Ultra was barely slower than Nano and that the "reasoning
models take seconds" warning was overblown.

Re-measuring with a **realistic** prompt (8 history items, 1792 characters, ~340 prompt
tokens), 3 runs each:

| Model        | runs                | mean        | completion tokens |
| ------------ | ------------------- | ----------- | ----------------- |
| Nano (30B)   | 2287, 1993, 1994 ms | **2091 ms** | 349–420           |
| Ultra (550B) | 2977, 3587, 4274 ms | **3613 ms** | 505–781           |

Both conclusions from the toy prompt were wrong:

- **Ultra is meaningfully slower than Nano** — ~1.7x, not ~1.2x — and at 3.6 s the original
  "a big reasoning model takes seconds" warning is correct after all.
- **Nano is also seconds-scale.** 2.1 s is not "a fast verdict with no visible delay".

The cause is that completion tokens scale with prompt richness: Nano went from 263 tokens on
the toy prompt to 349–420 on the real one, Ultra from 163 to 505–781. These models think for
longer when given more to think about, and that thinking is emitted token by token.

**Takeaway:** never size an inference architecture on a toy prompt. The number you care about
only appears once the prompt carries real context. We nearly shipped a design decision based
on an 80-token measurement.

Secondary finding, still true: on the toy prompt Ultra used _fewer_ completion tokens than
Nano (163 vs 263), because Nano's hidden reasoning is not free and is not reported in
`completion_tokens_details`. On realistic prompts Ultra does use more. Either way, the
tiering efficiency claim rests on **price per token, not token volume** — "we saved N tokens
by screening with Nano" would be false as stated.

---

## What this means for the architecture

The plan's async design is right, but one of its two premises needs replacing.

**Still true:** Ultra at ~3.6 s cannot sit inside a half-second interception beat. Routing a
contested tag into the Sleep On It tray is correct, and it is also the honest product move —
the tray is the app saying "this deserves a pause."

**No longer true:** "Nano runs inline at tag time. Fast verdict, no visible delay." At
~2.1 s it is a very visible delay. A blocking inline Nano call would damage exactly the beat
the product exists to create.

So the rule is not _cheap model inline, expensive model async_. It is **no model call blocks
the purchase flow.** Nano should be fired without awaiting it, with the verdict landing when
it lands; Ultra escalation stays in the tray as planned. That is a small change to Phase 4's
wording and no change at all to its architecture, which is the good outcome — the plan's
instinct to build async from the start was right even though one number behind it was not.

Worth adding: a network call of any duration can also fail or hang, and tail latency is not
mean latency. Three runs on an idle endpoint says nothing about p99 under load.

**Update from the wired-up app.** Once verdicts were being requested by the running product
rather than a benchmark script, two consecutive Nano calls of near-identical size came back
at **1964 ms and 3796 ms** — a 1.9x spread on the same tier, same prompt shape, same machine.
Nano's slow case overlaps Ultra's typical case. Any design that depends on the cheap tier
being reliably quick is depending on something that is not stable.

---

## 6. What a verdict actually costs

Measured from the app's own ledger (`model_usage`), real calls:

|                               | tokens                            | est. cost | latency |
| ----------------------------- | --------------------------------- | --------- | ------- |
| Nano verdict, 4 history items | 655 (351 prompt / 304 completion) | 66 µ$     | 1964 ms |
| Nano verdict, 5 history items | 730                               | 73 µ$     | 3796 ms |

At those rates the app's $10 internal ceiling is roughly **144,000 Nano verdicts** — far more
than a hackathon demo will ever use. The cap exists to bound a runaway loop or a stranger
hammering an endpoint that has no login, not to ration a budget that was never going to run
out. Cost estimates use deliberately conservative price constants (see
`src/lib/server/budget.ts`), so the true number is likely higher still.
