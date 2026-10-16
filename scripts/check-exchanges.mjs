#!/usr/bin/env node
/**
 * Exchange log checks. Bundles src/lib/server/exchanges.ts and runs it against no database.
 *
 * The /exchanges page exists so a judge does not have to trust our accuracy claim. That only
 * helps if the counts behind it are right, so the arithmetic is checked here rather than
 * asserted in a README: which rows are excluded, what the denominator is, and what happens
 * when a reconsideration arrives without the id of the challenge it answers.
 *
 * Scope, stated plainly: with no D1 binding the module uses its in-memory store, so this
 * exercises the summary semantics and the fallback paths, not the SQL. The SQL aggregate in
 * `readExchangeSummary` mirrors the same rules and is exercised by running the app against
 * Miniflare (see "Against the real Workers runtime" in the README).
 *
 *   npm run check:exchanges
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Nothing here should reach the network or a real database.
let fetchAttempts = 0;
globalThis.fetch = async (url) => {
  fetchAttempts++;
  throw new Error(`check-exchanges: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/lib/server/exchanges.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const dir = mkdtempSync(join(tmpdir(), "bucket-exchanges-"));
const file = join(dir, "exchanges.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const {
  recordChallenge,
  recordReconsideration,
  readExchangeSummary,
  readExchanges,
  exchangeLogUnlocked,
} = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

const reset = () => {
  globalThis.__bucketExchanges = new Map();
};

const purchase = (over = {}) => ({
  purchase: {
    amount: 260,
    label: "Headphones",
    intent: "need",
    readinessTag: "impulse",
    ...over,
  },
  history: [],
});

const contested = (over = {}) => ({
  agrees: false,
  verdict: "want",
  confidence: 0.8,
  reasoning: "You call comforts needs.",
  question: "What changed since the last pair?",
  ...over,
});

// 1. A challenge is recorded; an agreement is not an exchange and never reaches this module.
{
  reset();
  const id = await recordChallenge({
    sessionId: "s1",
    request: purchase(),
    verdict: contested(),
  });
  const rows = await readExchanges();
  check("challenge: returns an id", typeof id === "string" && id.length > 0);
  check("challenge: one row stored", rows.length === 1, `rows=${rows.length}`);
  check("challenge: keeps the user's tag", rows[0].userIntent === "need");
  check("challenge: keeps the contested verdict", rows[0].screeningVerdict === "want");
  check("challenge: keeps the question", typeof rows[0].question === "string");
  check("challenge: unanswered until answered", rows[0].answeredAt === null);

  const s = await readExchangeSummary();
  check("challenge: counted as a challenge", s.challenges === 1);
  check("challenge: not counted as answered", s.answered === 0, `answered=${s.answered}`);
}

// 2. An explanation attaches to the challenge it answers rather than making a second row.
{
  reset();
  const id = await recordChallenge({
    sessionId: "s1",
    request: purchase(),
    verdict: contested(),
  });
  await recordReconsideration({
    sessionId: "s1",
    exchangeId: id,
    request: {
      ...purchase(),
      question: "q",
      explanation: "The old pair broke",
      priorVerdict: "want",
    },
    verdict: {
      agrees: true,
      verdict: "need",
      confidence: 0.7,
      reasoning: "Fair.",
      explanationAccepted: true,
    },
  });

  const rows = await readExchanges();
  const s = await readExchangeSummary();
  check("answer: still one row", rows.length === 1, `rows=${rows.length}`);
  check("answer: explanation stored", rows[0].explanation === "The old pair broke");
  check("answer: acceptance stored", rows[0].explanationAccepted === 1);
  check("answer: timestamped", typeof rows[0].answeredAt === "number");
  check("answer: counted once", s.challenges === 1 && s.answered === 1);
  check("answer: counted as accepted", s.accepted === 1 && s.held === 0);
}

// 3. A held verdict is recorded as held, not quietly dropped.
{
  reset();
  const id = await recordChallenge({ sessionId: "s1", request: purchase(), verdict: contested() });
  await recordReconsideration({
    sessionId: "s1",
    exchangeId: id,
    request: {
      ...purchase(),
      question: "q",
      explanation: "I need them for work",
      priorVerdict: "want",
    },
    verdict: {
      agrees: false,
      verdict: "want",
      confidence: 0.85,
      reasoning: "Held.",
      explanationAccepted: false,
    },
  });
  const s = await readExchangeSummary();
  check("held: counted as answered", s.answered === 1);
  check("held: counted as held", s.held === 1 && s.accepted === 0);
}

// 4. A reconsideration with no id must not vanish. Losing it would bias the record toward
//    challenges nobody argued with, which is the flattering direction.
{
  reset();
  await recordReconsideration({
    sessionId: "s1",
    exchangeId: undefined,
    request: { ...purchase(), question: "q", explanation: "orphan", priorVerdict: "want" },
    verdict: {
      agrees: true,
      verdict: "need",
      confidence: 0.6,
      reasoning: "ok",
      explanationAccepted: true,
    },
  });
  const rows = await readExchanges();
  const s = await readExchangeSummary();
  check("orphan: written anyway", rows.length === 1, `rows=${rows.length}`);
  check("orphan: counted as answered", s.answered === 1 && s.accepted === 1);
}

// 5. Degraded rows are excluded from both rates but still counted as challenges. A fallback
//    agreeing with someone is not evidence that a model agreed with them.
{
  reset();
  const id = await recordChallenge({
    sessionId: "s1",
    request: purchase(),
    verdict: contested({ cached: true }),
  });
  await recordReconsideration({
    sessionId: "s1",
    exchangeId: id,
    request: { ...purchase(), question: "q", explanation: "x", priorVerdict: "want" },
    verdict: {
      agrees: true,
      verdict: "need",
      confidence: 0,
      reasoning: "cached",
      explanationAccepted: true,
    },
  });
  const s = await readExchangeSummary();
  check("degraded: flagged", (await readExchanges())[0].degraded === 1);
  check("degraded: still a challenge", s.challenges === 1);
  check("degraded: excluded from answered", s.answered === 0, `answered=${s.answered}`);
  check("degraded: excluded from accepted", s.accepted === 0, `accepted=${s.accepted}`);
}

// 6. A degraded second pass taints the row even when the first pass was real. The pair is one
//    claim, and half of it coming from a fallback makes the whole exchange unusable as proof.
{
  reset();
  const id = await recordChallenge({ sessionId: "s1", request: purchase(), verdict: contested() });
  await recordReconsideration({
    sessionId: "s1",
    exchangeId: id,
    request: { ...purchase(), question: "q", explanation: "x", priorVerdict: "want" },
    verdict: {
      agrees: true,
      verdict: "need",
      confidence: 0,
      reasoning: "provider down",
      explanationAccepted: true,
      telemetry: { degraded: true },
    },
  });
  const s = await readExchangeSummary();
  check("taint: row marked degraded", (await readExchanges())[0].degraded === 1);
  check("taint: excluded from the rates", s.answered === 0 && s.accepted === 0);
}

// 7. The log is closed unless a key is configured and matches. Unset must mean closed: a
//    missing secret is the likeliest way this leaks, so it cannot be the permissive case.
{
  delete process.env.EXCHANGES_KEY;
  check("key: closed when unset", exchangeLogUnlocked("anything") === false);
  check("key: closed for a null key when unset", exchangeLogUnlocked(null) === false);

  process.env.EXCHANGES_KEY = "s3cret";
  check("key: open on an exact match", exchangeLogUnlocked("s3cret") === true);
  check("key: closed on a wrong key", exchangeLogUnlocked("wrong") === false);
  check("key: closed on a prefix", exchangeLogUnlocked("s3cre") === false);
  check("key: closed on a longer key", exchangeLogUnlocked("s3cret ") === false);
  check("key: closed on no key", exchangeLogUnlocked(null) === false);
  delete process.env.EXCHANGES_KEY;
}

// 8. Ordering: newest first, so the page shows what just happened without a judge scrolling.
{
  reset();
  await recordChallenge({
    sessionId: "s1",
    request: purchase({ label: "First" }),
    verdict: contested(),
  });
  await new Promise((r) => setTimeout(r, 2));
  await recordChallenge({
    sessionId: "s1",
    request: purchase({ label: "Second" }),
    verdict: contested(),
  });
  const rows = await readExchanges();
  check("order: newest first", rows[0].label === "Second", rows.map((r) => r.label).join(" -> "));
}

// 9. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
