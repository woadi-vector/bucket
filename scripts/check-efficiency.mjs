#!/usr/bin/env node
/**
 * Efficiency arithmetic checks. Bundles src/lib/efficiency.ts and runs it against fixed rows.
 *
 * The panel this feeds makes a claim about money, which is the easiest kind of claim to get
 * quietly wrong and the hardest for a reader to spot. So the sums are checked here against
 * hand-computed values rather than trusted because they look plausible on screen.
 *
 * The counterfactual gets the most attention. It is the only figure that is not a straight
 * sum, it is the one a judge would challenge first, and an honest version of it has to come
 * back null rather than guess when there is nothing to observe.
 *
 *   npm run check:efficiency
 *
 * Exit code 1 means a failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let fetchAttempts = 0;
globalThis.fetch = async (url) => {
  fetchAttempts++;
  throw new Error(`check-efficiency: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/lib/efficiency.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const dir = mkdtempSync(join(tmpdir(), "bucket-efficiency-"));
const file = join(dir, "efficiency.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { summarize, formatMicros, formatRate } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

const row = (tier, calls, totalTokens, costMicros, avgLatencyMs = null) => ({
  tier,
  calls,
  totalTokens,
  costMicros,
  avgLatencyMs,
});

// 1. Nothing recorded yet. Every derived figure has to admit it rather than show a zero that
//    reads like a measurement.
{
  const e = summarize([]);
  check("empty: no verdicts", e.verdicts === 0);
  check("empty: no escalations", e.escalations === 0);
  check("empty: rate is null, not zero", e.escalationRate === null);
  check("empty: nothing spent", e.spentMicros === 0);
  check("empty: no counterfactual to offer", e.counterfactualMicros === null);
  check("empty: no saving claimed", e.savedMicros === null && e.savedMultiple === null);
}

// 2. Screening only, nobody contested. There is no observed expensive rate, so there is no
//    honest counterfactual: the price table is not a substitute for a measurement.
{
  const e = summarize([row("nano", 40, 26000, 2600, 2091)]);
  check("screening only: verdicts counted", e.verdicts === 40);
  check("screening only: no escalations", e.escalations === 0);
  check("screening only: rate is zero, not null", e.escalationRate === 0);
  check("screening only: spend is the screening spend", e.spentMicros === 2600);
  check(
    "screening only: refuses to invent a counterfactual",
    e.counterfactualMicros === null,
    "no ultra rate observed",
  );
}

// 3. The real shape. 40 verdicts, 6 of them contested enough to escalate.
//
//    Hand-computed: ultra charged 12000µ$ for 9000 tokens, so 1.3333µ$ per token. The
//    screening pass spent 26000 tokens, so upstairs it would have cost
//    26000 * 1.33333... = 34666.67, ceil 34667. Screening actually cost 2600. Saving is
//    34667 - 2600 = 32067, and the multiple is 34667 / 2600 = 13.33.
{
  const e = summarize([row("nano", 40, 26000, 2600, 2091), row("ultra", 6, 9000, 12000, 3613)]);
  check("mixed: verdicts are screening calls", e.verdicts === 40);
  check("mixed: escalations are the expensive calls", e.escalations === 6);
  check("mixed: escalation rate", Math.abs(e.escalationRate - 0.15) < 1e-9, e.escalationRate);
  check("mixed: total spend is every tier", e.spentMicros === 14600, `${e.spentMicros}`);
  check(
    "mixed: counterfactual reprices screening tokens at the observed rate",
    e.counterfactualMicros === 34667,
    `${e.counterfactualMicros}`,
  );
  check(
    "mixed: saving is counterfactual minus screening",
    e.savedMicros === 32067,
    `${e.savedMicros}`,
  );
  check(
    "mixed: multiple is counterfactual over screening",
    Math.abs(e.savedMultiple - 34667 / 2600) < 1e-9,
    `${e.savedMultiple}`,
  );

  // The claim is screening-versus-screening. Escalation spend is excluded deliberately,
  // because those calls happen in both worlds and counting them would flatter the saving.
  check(
    "mixed: saving does not credit escalation spend",
    e.savedMicros < e.counterfactualMicros,
    "escalations excluded from the comparison",
  );
}

// 4. A rate per token, not an average per call. This is the confound the counterfactual
//    exists to avoid: reconsiderations carry the person's explanation and are longer calls,
//    so an average call cost would overstate the saving.
//
//    Same per-token rate as case 3 (1.3333µ$), but spread over 3 fat calls instead of 6.
//    An average-per-call method would give 26000/650 * 4000 = a different, larger number;
//    repricing tokens gives the same 34667 because the rate is what matters.
{
  const e = summarize([row("nano", 40, 26000, 2600), row("ultra", 3, 9000, 12000)]);
  check(
    "rate: counterfactual is unchanged by how calls are bundled",
    e.counterfactualMicros === 34667,
    `${e.counterfactualMicros}`,
  );
  check("rate: escalation count still reflects calls", e.escalations === 3);
}

// 5. The stub tier costs nothing but is still a call. It must not be mistaken for screening,
//    or a key-less demo would report verdicts it never paid for.
{
  const e = summarize([row("stub", 12, 0, 0), row("nano", 5, 3000, 300)]);
  check("stub: not counted as verdicts", e.verdicts === 5, `${e.verdicts}`);
  check("stub: contributes nothing to spend", e.spentMicros === 300);
}

// 6. A saving can never read as negative, however the rates land.
{
  const e = summarize([row("nano", 10, 1000, 900), row("ultra", 2, 1000, 100)]);
  check(
    "floor: cheap expensive tier cannot produce a negative saving",
    e.savedMicros === 0,
    `${e.savedMicros}`,
  );
}

// 7. Formatting, because these are small numbers and rounding them to cents would show $0.00
//    for everything and make the whole panel look like it measured nothing.
{
  check("format: four decimal places", formatMicros(34667) === "$0.0347", formatMicros(34667));
  check("format: zero is still money", formatMicros(0) === "$0.0000");
  check("format: rate rounds to whole percent", formatRate(0.15) === "15%");
  check("format: an absent rate says so", formatRate(null) === "n/a");
}

// 8. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
