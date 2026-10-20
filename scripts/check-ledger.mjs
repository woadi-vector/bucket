#!/usr/bin/env node
/**
 * Checks the public ledger's arithmetic: how holds and refusals become grid rows, and how the
 * totals on the page add up. No network, no keys.
 *
 *   npm run check:ledger
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function bundle(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    logLevel: "error",
    alias: { "@": resolve("src") },
    external: ["@tanstack/*", "react", "react/*"],
    mainFields: ["module", "main"],
  });
  mkdirSync(resolve("node_modules/.cache"), { recursive: true });
  const dir = mkdtempSync(join(resolve("node_modules/.cache"), "bucket-ledger-"));
  const file = join(dir, "bundle.mjs");
  writeFileSync(file, out.outputFiles[0].contents);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rowsMod = await bundle("src/lib/bucket/ledger-rows.ts");
const ledgerMod = await bundle("src/lib/server/ledger.ts");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const hold = (over) => ({
  id: over.id,
  bucketId: "b5",
  bucketTag: "want",
  label: "Shoes",
  merchant: "shop.example",
  amountCents: 1000,
  currency: "USD",
  orderId: "O",
  authorizationId: `AUTH-${over.id}`,
  verdict: "hold",
  state: "held",
  decidedBy: null,
  captureId: null,
  lastError: null,
  createdAt: 1000,
  deadlineAt: 2000,
  decidedAt: null,
  ...over,
});
const refusal = (over) => ({
  id: over.id,
  kind: "declined",
  request: "oat milk",
  maxCents: 2000,
  productTitle: null,
  priceCents: null,
  merchant: null,
  category: null,
  reason: "Nothing listed is oat milk.",
  considered: 8,
  createdAt: 1500,
  ...over,
});

const holds = [
  hold({
    id: "need",
    bucketTag: "need",
    state: "captured",
    decidedBy: "policy",
    amountCents: 1899,
    createdAt: 10,
  }),
  hold({ id: "small", state: "captured", decidedBy: "policy", amountCents: 2499, createdAt: 20 }),
  hold({ id: "kept", state: "captured", decidedBy: "user", amountCents: 15500, createdAt: 30 }),
  hold({ id: "letgo", state: "voided", decidedBy: "user", amountCents: 8999, createdAt: 40 }),
  hold({ id: "clock", state: "voided", decidedBy: "clock", amountCents: 12995, createdAt: 50 }),
  hold({ id: "open", state: "held", amountCents: 24999, createdAt: 60 }),
  hold({ id: "busy", state: "deciding", amountCents: 500, createdAt: 70, lastError: "TIMEOUT" }),
];
const refusals = [
  refusal({ id: "dec", createdAt: 15 }),
  refusal({
    id: "over",
    kind: "overruled",
    productTitle: "Strainer bag",
    priceCents: 899,
    reason: "A strainer bag is not oat milk.",
    createdAt: 25,
  }),
];

const totals = ledgerMod.totalsOf(holds, refusals);
check(
  "captured counts every capture, rule or person",
  totals.captured === 3,
  String(totals.captured),
);
check(
  "captured dollars add up",
  totals.capturedCents === 1899 + 2499 + 15500,
  String(totals.capturedCents),
);
check(
  "let go and clock are counted apart",
  totals.releasedByPerson === 1 && totals.releasedByClock === 1,
);
check(
  "released dollars add up",
  totals.releasedCents === 8999 + 12995,
  String(totals.releasedCents),
);
check("held and deciding both count as waiting", totals.waiting === 2, String(totals.waiting));
check("declines and overrules are counted apart", totals.declined === 1 && totals.overruled === 1);
check("an overrule counts what the agent would have spent", totals.overruledCents === 899);

const rows = rowsMod.toLedgerRows({ holds, refusals, totals, generatedAt: "" });
const by = Object.fromEntries(rows.map((r) => [r.id, r]));
check("one row per hold and per refusal", rows.length === holds.length + refusals.length);
check(
  "rows are newest first",
  rows.every((r, i) => i === 0 || rows[i - 1].at >= r.at),
);
check("a need captured by the rule reads 'Paid at once'", by.need.outcome === "Paid at once");
check("the rule's reason names a need", by.need.decidedBy === "Rule: a need passes");
check(
  "a small want captured by the rule reads 'Paid at once'",
  by.small.outcome === "Paid at once",
);
check("the rule's reason names the threshold", by.small.decidedBy.includes("threshold"));
check("a capture the person chose reads 'Kept'", by.kept.outcome === "Kept");
check(
  "a void the person chose reads 'Let go'",
  by.letgo.outcome === "Let go" && by.letgo.group === "released",
);
check(
  "a void by the clock reads 'Expired'",
  by.clock.outcome === "Expired" && by.clock.decidedBy === "The clock",
);
check(
  "an open hold reads 'Waiting'",
  by.open.outcome === "Waiting" && by.busy.outcome === "Waiting",
);
check("a PayPal error shows on its row", by.busy.note === "Last PayPal error: TIMEOUT");
check(
  "a decline has no amount and no PayPal id",
  by.dec.amountCents === null && by.dec.authorizationId === null,
);
check(
  "a decline is credited to the agent",
  by.dec.decidedBy === "Agent (Super)" && by.dec.group === "refused",
);
check(
  "an overrule shows the refused product and the checker's reason",
  by.over.detail === "Strainer bag" && by.over.note === "A strainer bag is not oat milk.",
);
check(
  "every hold row carries PayPal's authorization id",
  rows
    .filter((r) => r.source === "PayPal hold")
    .every((r) => r.authorizationId?.startsWith("AUTH-")),
);

const chart = rowsMod.dollarsByOutcome(rows);
const sum = (o) => chart.find((d) => d.outcome === o);
check(
  "chart: 'Paid at once' sums both rule captures",
  sum("Paid at once").dollars === (1899 + 2499) / 100,
);
check(
  "chart: a decline adds a count and no dollars",
  sum("Declined").count === 1 && sum("Declined").dollars === 0,
);
check(
  "chart dollars equal the rows' dollars",
  Math.abs(
    chart.reduce((s, d) => s + d.dollars, 0) -
      rows.reduce((s, r) => s + (r.amountCents ?? 0), 0) / 100,
  ) < 1e-9,
);

// --- Released holds in the app: counted once, into Savings only when chosen ----------------------

const reducerMod = await bundle("src/lib/bucket/reducer.ts");
{
  const { bucketReducer, createInitialState } = reducerMod;
  const start = createInitialState();
  const savings = (st) => st.buckets.find((b) => b.id === "b4").balance;

  const kept = bucketReducer(start, { type: "RELEASE_HOLD", holdId: "h1", amount: 89.99 });
  check(
    "by default a release counts as saved but the money stays in its bucket",
    kept.savedByPause === 89.99 && savings(kept) === savings(start),
  );
  const again = bucketReducer(kept, { type: "RELEASE_HOLD", holdId: "h1", amount: 89.99 });
  check("the same hold is never counted twice", again === kept);

  const chose = bucketReducer(start, { type: "SET_RELEASE_TO", to: "savings" });
  const set = bucketReducer(chose, { type: "RELEASE_HOLD", holdId: "h2", amount: 40 });
  check(
    "with Savings chosen, the amount moves into Savings",
    savings(set) === savings(start) + 40 && set.savedByPause === 40,
  );
  check(
    "the Savings bar does not read the incoming money as spent",
    set.startingBalances.b4 === start.startingBalances.b4 + 40,
  );
}

console.log(failed ? `\n${failed} ledger check(s) failed.` : "\nAll ledger checks passed.");
process.exitCode = failed ? 1 : 0;
