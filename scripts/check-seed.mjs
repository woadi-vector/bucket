#!/usr/bin/env node
/**
 * Seed state checks. Bundles the persistence module and inspects what a cold visitor gets.
 *
 * This is the only file in the project whose job is to make something happen rather than to
 * stop something happening, and it is here because the seed is quietly load-bearing. Bucket
 * judges a label against the person's own past labels. Seed an honestly labelled history and
 * the app agrees with everything a visitor logs, which looks identical to a broken model and
 * means the one behaviour worth showing never occurs in the time anyone spends looking.
 *
 * So these assert that the habit is present and that the arithmetic around it still holds. A
 * future edit that tidies the history into something more flattering would pass every other
 * suite in this repo and silently turn the demo back into a shrug.
 *
 *   npm run check:seed
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
  throw new Error(`check-seed: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/lib/bucket/persistence.ts"],
  bundle: true,
  // `node` rather than `neutral`, unlike the other suites: this module reaches
  // `bucket-store.ts`, which imports icon components for the bucket cards. Nothing here
  // touches them, but they have to resolve for the bundle to build.
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const dir = mkdtempSync(join(tmpdir(), "bucket-seed-"));
const file = join(dir, "persistence.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { createSeededState } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const state = createSeededState(NOW);
const { transactions, buckets, startingBalances, pending } = state;

// 1. The habit. Four purchases that call convenience food a need is what gives the model
//    grounds to contest the first thing a visitor logs, which is the whole reason a judge
//    sees anything at all in the thirty seconds they spend.
{
  const needs = transactions.filter((t) => t.intent === "need");
  const wants = transactions.filter((t) => t.intent === "want");

  check(
    "habit: enough history to be a pattern",
    transactions.length >= 6,
    `${transactions.length}`,
  );
  check("habit: comforts are called needs", needs.length >= 5, `${needs.length} needs`);
  check(
    "habit: the dining bucket carries most of it",
    needs.filter((t) => t.bucketId === "b2").length >= 3,
    `${needs.filter((t) => t.bucketId === "b2").length} dining needs`,
  );
  // Without these the history is a strawman, and a model shown nothing but self-deception
  // learns to contest everything rather than to notice a pattern.
  check("habit: honest wants are present too", wants.length >= 2, `${wants.length} wants`);
  check(
    "habit: genuine needs are present too",
    needs.some((t) => t.readinessTag === null),
    "a need with no impulse marker",
  );
  check(
    "habit: the impulse marker is on the stretched ones",
    needs.filter((t) => t.readinessTag === "impulse").length >= 3,
  );
}

// 2. Spread. Labels clustered in one hour read as a test fixture; a fortnight reads as a life,
//    and the prompt shows the model how long ago each purchase was.
{
  const days = new Set(transactions.map((t) => Math.floor((NOW - t.timestamp) / DAY)));
  check("spread: covers several distinct days", days.size >= 5, `${days.size} days`);
  check(
    "spread: nothing in the future",
    transactions.every((t) => t.timestamp < NOW),
  );
  check(
    "spread: reaches back about a fortnight",
    Math.max(...transactions.map((t) => NOW - t.timestamp)) >= 10 * DAY,
  );
  check(
    "spread: something from the last day, so it reads as current",
    Math.min(...transactions.map((t) => NOW - t.timestamp)) < DAY,
  );
  check(
    "spread: newest first",
    transactions.every((t, i, a) => i === 0 || a[i - 1].timestamp >= t.timestamp),
  );
}

// 3. The arithmetic still holds. Adding spend to the seed is the easiest way to quietly put a
//    bucket underwater, and a negative balance on the first screen is its own kind of broken.
{
  const spentByBucket = transactions.reduce((acc, t) => {
    acc[t.bucketId] = (acc[t.bucketId] ?? 0) + t.amount;
    return acc;
  }, {});

  check(
    "money: no bucket is underwater",
    buckets.every((b) => b.balance >= 0),
    buckets.map((b) => `${b.name} ${b.balance}`).join(", "),
  );

  for (const b of buckets) {
    const spent = spentByBucket[b.id] ?? 0;
    const start = startingBalances[b.id];
    // Savings is credited by the released want rather than debited, so it is checked by the
    // same rule the app uses: start already includes the credit.
    check(
      `money: ${b.name} balance equals start minus spend`,
      Math.abs(start - spent - b.balance) < 1e-9,
      `${start} - ${spent} = ${start - spent}, got ${b.balance}`,
    );
  }
}

// 4. Identity. The transactions table is keyed on these ids with INSERT OR IGNORE, so a fixed
//    id would mean only the first visitor's rows ever landed and every later one vanished.
{
  const ids = transactions.map((t) => t.id);
  check(
    "ids: every transaction has one",
    ids.every((id) => typeof id === "string" && id.length > 0),
  );
  check("ids: all distinct", new Set(ids).size === ids.length);

  const second = createSeededState(NOW);
  check(
    "ids: a second visitor gets different ones",
    second.transactions.every((t) => !ids.includes(t.id)),
  );
}

// 5. The tray still has something in it, so the let-it-go moment stays one click away.
{
  check("tray: a pending want is waiting", pending.length >= 1);
  check(
    "tray: it is tagged as a want",
    pending.every((p) => p.intent === "want"),
  );
  check(
    "tray: it still has time on the clock",
    pending.every((p) => p.hoursLeft > 0),
  );
}

// 6. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
