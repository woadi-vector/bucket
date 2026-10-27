#!/usr/bin/env node
/**
 * Purchase routing checks. Bundles src/lib/purchase-routing.ts.
 *
 * Four things can interrupt a purchase when a bucket is chosen, and the order between them
 * is the entire content of that module. An ordering is the kind of rule that breaks without
 * anything looking wrong: every branch renders a plausible screen, so a swapped pair simply
 * shows the person the wrong one and nothing reports a fault.
 *
 * The pair that matters most is the sleep threshold against the disagreement. A big want is
 * already being held for a day, which is a stronger intervention than an argument, and
 * raising the argument first would interrupt one purchase twice.
 *
 *   npm run check:routing
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
  throw new Error(`check-routing: network call blocked (${String(url)})`);
};

const dir = mkdtempSync(join(tmpdir(), "bucket-routing-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `export { nextStepAfterBucket } from "@/lib/purchase-routing";
export { SLEEP_THRESHOLD } from "@/lib/bucket-store";`,
);

const bundled = await build({
  entryPoints: [entry],
  bundle: true,
  // `node` rather than `neutral`: bucket-store.ts imports icon components for the cards.
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const file = join(dir, "routing.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { nextStepAfterBucket, SLEEP_THRESHOLD } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

const self = { id: "b1", name: "Groceries", balance: 283, limit: null, ownerType: "self" };
const kid = { id: "b3", name: "Kids' Allowance", balance: 50, limit: 40, ownerType: "child" };

/** A disagreement the person would actually be shown. */
const contest = {
  agrees: false,
  verdict: "want",
  confidence: 0.8,
  reasoning: "Four of your last eight needs were convenience food.",
  question: "What made this one different?",
};

const route = (over) =>
  nextStepAfterBucket({ bucket: self, amount: 20, intent: "need", spent: 0, ...over });

// 1. Nothing to say: the purchase just happens.
{
  check("commit: no preview", route({}) === "commit");
  check("commit: the engine agreed", route({ preview: { ...contest, agrees: true } }) === "commit");
  check(
    "commit: a withheld contest never interrupts",
    route({ preview: { ...contest, withheld: true } }) === "commit",
    "the whole value of that silence is that nothing appears",
  );
  check(
    "commit: a cached verdict never interrupts",
    route({ preview: { ...contest, cached: true } }) === "commit",
    "nothing canned may argue with anyone",
  );
  check(
    "commit: an argument with no reasoning in it",
    route({ preview: { ...contest, reasoning: "" } }) === "commit",
  );
}

// 2. The disagreement, when it arrived in time.
{
  check("contest: raised before the money moves", route({ preview: contest }) === "secondThought");
  check(
    "contest: a want under the threshold is argued with, not held",
    nextStepAfterBucket({
      bucket: self,
      amount: SLEEP_THRESHOLD - 1,
      intent: "want",
      spent: 0,
      preview: contest,
    }) === "secondThought",
  );
}

// 3. The sleep threshold wins over the argument. A want over the line is already being held
//    for a day, and arguing first would interrupt one purchase twice.
{
  check(
    "order: a big want is held, not argued with",
    nextStepAfterBucket({
      bucket: self,
      amount: SLEEP_THRESHOLD + 1,
      intent: "want",
      spent: 0,
      preview: contest,
    }) === "intercept",
    "the tray is where the objection waits anyway",
  );
  check(
    "order: exactly at the threshold is not over it",
    nextStepAfterBucket({
      bucket: self,
      amount: SLEEP_THRESHOLD,
      intent: "want",
      spent: 0,
      preview: contest,
    }) === "secondThought",
  );
  check(
    "order: a big need is not held",
    nextStepAfterBucket({
      bucket: self,
      amount: SLEEP_THRESHOLD + 500,
      intent: "need",
      spent: 0,
      preview: contest,
    }) === "secondThought",
  );
}

// 4. A child's limit beats everything. It is the only one of the four that is not Bucket's
//    own opinion: someone else set it, and an agent does not talk its way past a parent.
{
  check(
    "order: the limit beats the argument",
    nextStepAfterBucket({
      bucket: kid,
      amount: 20,
      intent: "need",
      spent: 30,
      preview: contest,
    }) === "askParent",
  );
  check(
    "order: the limit beats the sleep threshold",
    nextStepAfterBucket({
      bucket: kid,
      amount: SLEEP_THRESHOLD + 1,
      intent: "want",
      spent: 30,
      preview: contest,
    }) === "askParent",
  );
  check(
    "limit: under it, the purchase proceeds normally",
    nextStepAfterBucket({ bucket: kid, amount: 5, intent: "need", spent: 30 }) === "commit",
  );
  check(
    "limit: a child bucket with no limit set is not gated",
    nextStepAfterBucket({
      bucket: { ...kid, limit: null },
      amount: 500,
      intent: "need",
      spent: 30,
    }) === "commit",
  );
  check(
    "limit: exactly at the limit is not over it",
    nextStepAfterBucket({ bucket: kid, amount: 10, intent: "need", spent: 30 }) === "commit",
  );
}

// 5. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
