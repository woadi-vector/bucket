#!/usr/bin/env node
/**
 * Engine checks. Bundles src/engine on its own and runs judgeTransaction against fake adapters.
 *
 * Nothing here reaches Token Factory, and nothing is spent. Every adapter is an in-process fixture,
 * and global `fetch` is replaced with one that throws and is counted, so an accidental network
 * call fails the run instead of going out.
 *
 * Bundling the engine separately is itself part of the check: it must build without the rest of
 * the app (see "The verdict engine is a separate thing from the app" in the README).
 *
 *   npm run check:engine
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Refuse the network before the engine is even loaded.
let fetchAttempts = 0;
globalThis.fetch = async (url) => {
  fetchAttempts++;
  throw new Error(`check-engine: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/engine/index.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "error",
});
const dir = mkdtempSync(join(tmpdir(), "bucket-engine-"));
const file = join(dir, "engine.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { judgeTransaction, reconsiderTransaction, shapeEvidence, CACHED_REASONING } = await import(
  pathToFileURL(file).href
);
rmSync(dir, { recursive: true, force: true });

const request = {
  purchase: { amount: 260, label: "Headphones", intent: "need", readinessTag: "impulse" },
  history: [],
};

// Counts every call and always contests the user's tag, so escalation is always warranted.
function countingAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      name: "fixture",
      async complete(req) {
        calls.push(req.model);
        return {
          text: '{"verdict":"want","confidence":0.9,"reasoning":"You call comforts needs."}',
          usage: { promptTokens: 300, completionTokens: 300, totalTokens: 600 },
        };
      },
    },
  };
}

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

// 1. Ceiling already reached: no model call at all, cached verdict that agrees.
{
  const { calls, adapter } = countingAdapter();
  const usage = [];
  const v = await judgeTransaction(request, {
    adapter,
    canEscalate: () => true,
    onUsage: (e) => usage.push(e),
    checkCeiling: () => ({ reached: true, reason: "tokens 5000000/5000000" }),
  });
  check("tripped: adapter never called", calls.length === 0, `calls=${calls.length}`);
  check("tripped: nothing recorded to the ledger", usage.length === 0);
  check("tripped: marked cached", v.cached === true && v.telemetry?.cached === true);
  check("tripped: agrees with the user", v.agrees === true && v.verdict === "need");
  check("tripped: reasoning says it is cached", v.reasoning === CACHED_REASONING);
  check("tripped: zero confidence", v.confidence === 0);
}

// 2. Under the ceiling: normal path, screening + escalation both happen.
{
  const { calls, adapter } = countingAdapter();
  const v = await judgeTransaction(request, {
    adapter,
    canEscalate: () => true,
    checkCeiling: () => ({ reached: false }),
  });
  check("under: both tiers called", calls.length === 2, calls.join(" -> "));
  check("under: not marked cached", !v.cached);
}

// 3. Ceiling trips after screening: keep the paid-for screening verdict, skip Ultra.
{
  const { calls, adapter } = countingAdapter();
  let asked = 0;
  const v = await judgeTransaction(request, {
    adapter,
    canEscalate: () => true,
    checkCeiling: () => (++asked === 1 ? { reached: false } : { reached: true, reason: "x" }),
  });
  check("mid-trip: only screening called", calls.length === 1, calls.join(" -> "));
  check("mid-trip: ceiling asked twice", asked === 2, `asked=${asked}`);
  check("mid-trip: real screening verdict kept", v.cached !== true && v.verdict === "want");
}

// 4. The ceiling check itself throws: fail CLOSED — no call, cached verdict.
//    The engine logs the error; that console.error line is expected output.
{
  const { calls, adapter } = countingAdapter();
  const v = await judgeTransaction(request, {
    adapter,
    checkCeiling: () => {
      throw new Error("ledger unavailable (expected in this check)");
    },
  });
  check("throwing check: fails closed, no call", calls.length === 0, `calls=${calls.length}`);
  check("throwing check: serves cached verdict", v.cached === true && v.agrees === true);
}

// 5. No checkCeiling supplied: behaves exactly as before.
{
  const { calls, adapter } = countingAdapter();
  await judgeTransaction(request, { adapter });
  check("no hook: unchanged behaviour", calls.length === 1);
}

// 6. Stub scenario markers: forced disagreement for design work, default unchanged.
{
  const base = { amount: 260, intent: "need", readinessTag: "impulse" };

  const plain = await judgeTransaction({ purchase: { ...base, label: "Headphones" }, history: [] });
  check("stub default: still agrees", plain.agrees === true && plain.verdict === "need");
  check("stub default: zero confidence", plain.confidence === 0, `conf=${plain.confidence}`);

  const forced = await judgeTransaction({
    purchase: { ...base, label: "Headphones #want" },
    history: [],
  });
  check("marker: contests the user's tag", forced.agrees === false && forced.verdict === "want");
  check("marker: reasoning announces the stub", forced.reasoning.startsWith("STUB SCENARIO"));
  check("marker: tier stays stub", forced.telemetry?.tier === "stub");

  const hedged = await judgeTransaction({
    purchase: { ...base, label: "Headphones #want #low", note: null },
    history: [],
  });
  check("marker: #low lowers confidence", hedged.confidence === 0.25, `conf=${hedged.confidence}`);

  // A forced disagreement must never reach the expensive tier, even with escalation allowed.
  // onUsage fires once per model call, so counting it is what actually proves no second pass.
  {
    const tiers = [];
    let escalationAsked = 0;
    const v = await judgeTransaction(
      { purchase: { ...base, label: "Headphones #want" }, history: [] },
      {
        canEscalate: () => {
          escalationAsked++;
          return true;
        },
        onUsage: (e) => tiers.push(e.telemetry.tier),
      },
    );
    check("marker: exactly one pass", tiers.length === 1, tiers.join(" -> "));
    check("marker: never asked to escalate", escalationAsked === 0, `asked=${escalationAsked}`);
    check("marker: no adjudication recorded", v.telemetry?.escalatedFrom === undefined);
  }

  // The marker only works where a person actually typed it.
  const inNote = await judgeTransaction({
    purchase: { ...base, label: "Headphones", note: "work calls #want" },
    history: [],
  });
  check("marker: honoured in the note too", inNote.agrees === false);
}

// 7. Clarification: a contested tag carries a question, and the answer is weighed not waved through.
{
  const contested = await judgeTransaction({
    purchase: { amount: 260, label: "Headphones #want", intent: "need", readinessTag: "impulse" },
    history: [],
  });
  check("clarify: disagreement carries a question", typeof contested.question === "string");

  const agreed = await judgeTransaction({
    purchase: { amount: 40, label: "Groceries", intent: "need", readinessTag: null },
    history: [],
  });
  check("clarify: agreement carries no question", agreed.question === undefined);

  // A question on an agreeing verdict is dropped: nobody should defend an uncontested call.
  const chatty = {
    name: "fixture",
    async complete() {
      return {
        text: '{"verdict":"need","confidence":0.8,"reasoning":"Fine.","question":"Why though?"}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  const v = await judgeTransaction(request, { adapter: chatty });
  check("clarify: question dropped when it agrees", v.agrees === true && v.question === undefined);
}

// 8. Reconsideration: holds or accepts, and says which.
{
  const base = {
    purchase: { amount: 260, label: "Headphones #want", intent: "need", readinessTag: "impulse" },
    history: [],
    question: "What changed since the last pair?",
    priorVerdict: "want",
  };

  const held = await reconsiderTransaction({ ...base, explanation: "I need them for work." });
  check("reconsider: can hold its position", held.explanationAccepted === false);
  check("reconsider: still disagrees", held.agrees === false && held.verdict === "want");
  check("reconsider: stage recorded", held.telemetry?.stage === "reconsideration");

  const moved = await reconsiderTransaction({
    ...base,
    explanation: "The old pair broke this morning #accept",
  });
  check("reconsider: can be persuaded", moved.explanationAccepted === true);
  check("reconsider: agrees after accepting", moved.agrees === true && moved.verdict === "need");

  // Acceptance is derived from the verdict, never read from the model's own claim.
  const liar = {
    name: "fixture",
    async complete() {
      return {
        text: '{"verdict":"want","confidence":0.9,"reasoning":"Held.","explanationAccepted":true}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  const claimed = await reconsiderTransaction({ ...base, explanation: "work" }, { adapter: liar });
  check("reconsider: ignores a self-reported acceptance", claimed.explanationAccepted === false);

  // A provider outage must not punish someone for explaining themselves.
  const broken = {
    name: "fixture",
    async complete() {
      throw new Error("provider down (expected in this check)");
    },
  };
  const degraded = await reconsiderTransaction(
    { ...base, explanation: "work" },
    { adapter: broken },
  );
  check("reconsider: outage accepts the explanation", degraded.explanationAccepted === true);
  check("reconsider: outage marked degraded", degraded.telemetry?.degraded === true);

  // The ceiling still applies to the expensive pass.
  let spent = 0;
  const counting = {
    name: "fixture",
    async complete() {
      spent++;
      return {
        text: '{"verdict":"want","confidence":0.9,"reasoning":"x"}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  const ceiled = await reconsiderTransaction(
    { ...base, explanation: "work" },
    { adapter: counting, checkCeiling: () => ({ reached: true, reason: "budget" }) },
  );
  check("reconsider: ceiling blocks the call", spent === 0, `spent=${spent}`);
  check("reconsider: ceiling accepts the explanation", ceiled.explanationAccepted === true);
  check("reconsider: ceiling marked cached", ceiled.cached === true);
}

// 9. Evidence: a lookup can only ever add a fact, and never makes Bucket harsher.
{
  const base = {
    purchase: { amount: 260, label: "Headphones", intent: "need", readinessTag: "replacing" },
    history: [],
    question: "What changed since the last pair?",
    priorVerdict: "want",
    explanation: "The old pair broke this morning",
  };

  // Records what the engine chose to search for, so the query itself can be asserted on.
  const recording = (result) => {
    const queries = [];
    return {
      queries,
      source: {
        name: "fixture",
        async search(query) {
          queries.push(query);
          return typeof result === "function" ? result(query) : result;
        },
      },
    };
  };

  const found = {
    query: "Headphones repair cost vs replacement",
    provider: "fixture",
    summary: "Replacement earpads for this model run about $40.",
    items: [{ title: "Earpad kit", url: "https://example.com/pads", snippet: "$39.99" }],
  };

  // The prompt is what the model actually sees, so assert on it rather than on an internal.
  let promptSeen = "";
  const capturing = {
    name: "fixture",
    async complete(req) {
      promptSeen = req.messages.map((m) => m.content).join("\n");
      return {
        text: '{"verdict":"want","confidence":0.8,"reasoning":"There is a $40 repair."}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };

  const { queries, source } = recording(found);
  const v = await reconsiderTransaction(base, { adapter: capturing, evidence: source });
  check("evidence: a lookup happened", queries.length === 1, queries.join(" | "));
  check(
    "evidence: breakage wording picks the repair query",
    queries[0] === "Headphones repair cost vs replacement",
    queries[0],
  );
  check("evidence: the finding reaches the prompt", promptSeen.includes("$40"));
  check(
    "evidence: the model is told not to treat a cheaper option as decisive",
    promptSeen.includes("does not settle the question"),
  );
  check("evidence: recorded in telemetry", v.telemetry?.evidence?.provider === "fixture");
  check("evidence: result count recorded", v.telemetry?.evidence?.resultCount === 1);

  // THE PRIVACY PROPERTY. The explanation is the most personal text in the app and must never
  // be handed to a third-party search API, however much it might improve the query.
  {
    const secret = "my ex took the old pair when she moved out and it broke in the car";
    const { queries: sent } = recording(null);
    await reconsiderTransaction(
      { ...base, explanation: secret },
      { adapter: capturing, evidence: recording(null).source },
    );
    const probe = recording(null);
    await reconsiderTransaction(
      { ...base, explanation: secret },
      { adapter: capturing, evidence: probe.source },
    );
    const leaked = probe.queries.some((q) => q.includes("ex") || q.includes("moved out"));
    check("evidence: the explanation is never sent to the provider", !leaked, probe.queries[0]);
    check("evidence: only the label is searched", probe.queries[0].startsWith("Headphones"));
    check("evidence: unused probe stayed empty", sent.length === 0);
  }

  // Without breakage wording, the broader query. Same two inputs, different shape.
  {
    const probe = recording(null);
    await reconsiderTransaction(
      { ...base, explanation: "I want them for the gym" },
      { adapter: capturing, evidence: probe.source },
    );
    check(
      "evidence: no breakage wording picks the alternatives query",
      probe.queries[0] === "Headphones cheaper alternatives typical price",
      probe.queries[0],
    );
  }

  // Scenario markers are a dev affordance and have no business in somebody's search query.
  {
    const probe = recording(null);
    await reconsiderTransaction(
      { ...base, purchase: { ...base.purchase, label: "Headphones #want #low" } },
      { adapter: capturing, evidence: probe.source },
    );
    check("evidence: stub markers stripped from the query", !probe.queries[0].includes("#"));
  }

  // Every failure path must land where "no search at all" lands: the verdict is unchanged and
  // nothing is recorded. A slow third party cannot be allowed to alter a verdict about money.
  const noEvidence = await reconsiderTransaction(base, { adapter: capturing });
  const baseline = { verdict: noEvidence.verdict, accepted: noEvidence.explanationAccepted };

  for (const [name, bad] of [
    [
      "returns null",
      {
        name: "fixture",
        async search() {
          return null;
        },
      },
    ],
    [
      "throws",
      {
        name: "fixture",
        async search() {
          throw new Error("provider down (expected)");
        },
      },
    ],
    [
      "returns nothing usable",
      {
        name: "fixture",
        async search() {
          return { query: "q", provider: "fixture", items: [] };
        },
      },
    ],
  ]) {
    const r = await reconsiderTransaction(base, { adapter: capturing, evidence: bad });
    check(
      `evidence: a source that ${name} changes nothing`,
      r.verdict === baseline.verdict && r.explanationAccepted === baseline.accepted,
    );
    check(
      `evidence: a source that ${name} records no evidence`,
      r.telemetry?.evidence === undefined,
    );
  }

  // A label with nothing searchable in it must not produce a query for "".
  {
    const probe = recording(found);
    await reconsiderTransaction(
      { ...base, purchase: { ...base.purchase, label: "#want" } },
      { adapter: capturing, evidence: probe.source },
    );
    check("evidence: no query when the label is only markers", probe.queries.length === 0);
  }

  // The same page under two URLs must count once. Observed against the real Tavily API:
  // two of three results were one article, one with a tracking parameter.
  {
    const dupes = {
      name: "fixture",
      async search(query) {
        return shapeEvidence({
          query,
          provider: "fixture",
          items: [
            { title: "A", url: "https://www.example.com/pads?op=1", snippet: "$40" },
            { title: "A again", url: "https://example.com/pads", snippet: "$40" },
            { title: "A trailing", url: "https://example.com/pads/", snippet: "$40" },
            { title: "B", url: "https://other.example/kit", snippet: "$45" },
          ],
        });
      },
    };
    const v = await reconsiderTransaction(base, { adapter: capturing, evidence: dupes });
    check(
      "evidence: one page counted once",
      v.telemetry?.evidence?.resultCount === 2,
      `count=${v.telemetry?.evidence?.resultCount}`,
    );
    check("evidence: the distinct source survived", promptSeen.includes("$45"));
  }

  // Screening never searches: there is no claim to check until the person has spoken.
  {
    const probe = recording(found);
    await judgeTransaction(request, { adapter: capturing, evidence: probe.source });
    check("evidence: screening never looks anything up", probe.queries.length === 0);
  }
}

// 10. Restraint: disagreeing and saying so out loud are two separate decisions.
{
  const fixed = (verdict, confidence) => ({
    name: "fixture",
    async complete() {
      return {
        text: JSON.stringify({ verdict, confidence, reasoning: "Because." }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  });
  const open = { canEscalate: () => true, checkCeiling: () => ({ reached: false }) };

  // Same purchase, tagged the other way, so a verdict of "need" is the contest.
  const wantTagged = {
    purchase: { amount: 260, label: "Headphones", intent: "want", readinessTag: null },
    history: [],
  };

  const loud = await judgeTransaction(request, { ...open, adapter: fixed("want", 0.9) });
  check(
    "restraint: a confident contest is spoken",
    loud.agrees === false && loud.withheld === undefined,
  );

  const quiet = await judgeTransaction(request, { ...open, adapter: fixed("want", 0.7) });
  check("restraint: a hedged contest is withheld", quiet.withheld?.reason === "unsure");
  check("restraint: withholding never fakes agreement", quiet.agrees === false);
  check(
    "restraint: the unspoken verdict is recorded",
    quiet.withheld?.verdict === "want" && quiet.withheld?.confidence === 0.7,
  );

  // The asymmetry: 0.7 is too hedged to call someone's need a want, but sure enough to
  // tell them the thing they called a want was closer to a need.
  const generous = await judgeTransaction(wantTagged, { ...open, adapter: fixed("need", 0.7) });
  check(
    "restraint: calling a want a need clears a lower floor",
    generous.agrees === false && generous.withheld === undefined,
  );
  const coinflip = await judgeTransaction(wantTagged, { ...open, adapter: fixed("need", 0.5) });
  check(
    "restraint: a coin flip is withheld in either direction",
    coinflip.withheld?.reason === "unsure",
  );

  const agreeing = await judgeTransaction(request, { ...open, adapter: fixed("need", 0.9) });
  check(
    "restraint: an agreement withholds nothing",
    agreeing.agrees === true && agreeing.withheld === undefined,
  );

  const ceilinged = await judgeTransaction(request, {
    adapter: fixed("want", 0.9),
    canEscalate: () => true,
    checkCeiling: () => ({ reached: true, reason: "tokens" }),
  });
  check("restraint: a cached verdict withholds nothing", ceilinged.withheld === undefined);

  const unescalated = await judgeTransaction(request, {
    adapter: fixed("want", 0.7),
    canEscalate: () => false,
    checkCeiling: () => ({ reached: false }),
  });
  check(
    "restraint: a hedge nobody adjudicated is still withheld",
    unescalated.withheld?.reason === "unsure",
  );

  // The strong silence: the cheap tier contested, the expensive tier took the person's
  // side, and the argument was dropped before it reached them. Branches on call order
  // because screening always runs first.
  {
    let call = 0;
    const twoMinds = {
      name: "fixture",
      async complete() {
        call += 1;
        return {
          text:
            call === 1
              ? '{"verdict":"want","confidence":0.95,"reasoning":"You call comforts needs."}'
              : '{"verdict":"need","confidence":0.9,"reasoning":"You were right."}',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    const dropped = await judgeTransaction(request, { ...open, adapter: twoMinds });
    check("restraint: both tiers were asked", call === 2, `calls=${call}`);
    check(
      "restraint: an overruled contest agrees with the person",
      dropped.agrees === true && dropped.verdict === "need",
    );
    check("restraint: the overruled contest is recorded", dropped.withheld?.reason === "overruled");
    check(
      "restraint: the dropped verdict is the cheap tier's",
      dropped.withheld?.verdict === "want",
    );
    check(
      "restraint: the dropped confidence is the cheap tier's, not the one that won",
      dropped.withheld?.confidence === 0.95,
      `conf=${dropped.withheld?.confidence}`,
    );
  }

  // Both paths are walkable with no API key at all, which is how the surface gets designed.
  const marked = await judgeTransaction({
    purchase: { amount: 260, label: "Headphones #want", intent: "need", readinessTag: null },
    history: [],
  });
  check(
    "restraint: a marked contest is spoken",
    marked.agrees === false && marked.withheld === undefined,
  );
  const markedQuiet = await judgeTransaction({
    purchase: { amount: 260, label: "Headphones #want #low", intent: "need", readinessTag: null },
    history: [],
  });
  check("restraint: #low walks the withheld path", markedQuiet.withheld?.reason === "unsure");
}

// 11. The guard itself: nothing above touched the network.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
