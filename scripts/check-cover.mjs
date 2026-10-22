#!/usr/bin/env node
/**
 * Cover arithmetic checks. Bundles the reducer and drives COVER_BUCKET against fixed states.
 *
 * This is the only action in the app that moves money between two buckets, which makes it
 * the only one that can silently invent or destroy money. Every other action debits one
 * balance by an amount that is also written to the ledger, so a mistake there shows up as a
 * wrong number next to a visible row. A bad cover shows up as two wrong numbers and no row,
 * and the person's own total is the thing it corrupts.
 *
 * The refusal cases carry most of the weight. Overshooting a deficit would leave "Everything
 * Else" holding a positive balance, which quietly restores the slush fund that bucket exists
 * to prevent, and would pass every other suite in this repo.
 *
 *   npm run check:cover
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
  throw new Error(`check-cover: network call blocked (${String(url)})`);
};

const bundled = await build({
  entryPoints: ["src/lib/bucket/reducer.ts"],
  bundle: true,
  // `node` rather than `neutral`: the reducer reaches bucket-store.ts, which imports icon
  // components. Nothing here touches them, but they have to resolve for the bundle to build.
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const dir = mkdtempSync(join(tmpdir(), "bucket-cover-"));
const file = join(dir, "reducer.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { bucketReducer, createInitialState } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

const balanceOf = (state, id) => state.buckets.find((b) => b.id === id).balance;

/** A state where Everything Else is $250 over and Groceries has $283. */
const underwater = () => {
  const base = createInitialState();
  return {
    ...base,
    buckets: base.buckets.map((b) => {
      if (b.id === "b5") return { ...b, balance: -250 };
      if (b.id === "b1") return { ...b, balance: 283 };
      return b;
    }),
  };
};

const cover = (amount, from = "b1", to = "b5") => ({
  type: "COVER_BUCKET",
  cover: { id: "c1", amount, fromBucketId: from, toBucketId: to, timestamp: 1 },
});

// 1. The ordinary case: the deficit clears and the money comes off the funding bucket.
{
  const next = bucketReducer(underwater(), cover(250));
  check(
    "cover: the deficit clears exactly",
    balanceOf(next, "b5") === 0,
    `${balanceOf(next, "b5")}`,
  );
  check(
    "cover: the funding bucket loses exactly that much",
    balanceOf(next, "b1") === 33,
    `${balanceOf(next, "b1")}`,
  );
  check(
    "cover: no money is created or destroyed",
    next.buckets.reduce((s, b) => s + b.balance, 0) ===
      underwater().buckets.reduce((s, b) => s + b.balance, 0),
  );
  check("cover: the move is recorded", next.covers.length === 1);
  check("cover: the record states what actually moved", next.covers[0].amount === 250);
}

// 2. startingBalances is left alone, which is what makes both cards read honestly: the
//    funding bucket's spend grows because the money really left it, and the covered bucket
//    returns to the zero it started at rather than carrying a phantom credit.
{
  const before = underwater();
  const next = bucketReducer(before, cover(250));
  check(
    "starting: untouched by a cover",
    JSON.stringify(next.startingBalances) === JSON.stringify(before.startingBalances),
  );
  check(
    "starting: the funding bucket now reads as more spent",
    next.startingBalances["b1"] - balanceOf(next, "b1") === 387,
    `${next.startingBalances["b1"] - balanceOf(next, "b1")}`,
  );
  check(
    "starting: the covered bucket reads as nothing spent",
    next.startingBalances["b5"] - balanceOf(next, "b5") === 0,
  );
}

// 3. A partial cover from a bucket that cannot clear the whole thing.
{
  const next = bucketReducer(underwater(), cover(50, "b3"));
  check("partial: what is available moves", balanceOf(next, "b3") === 0);
  check("partial: the rest stays over", balanceOf(next, "b5") === -200, `${balanceOf(next, "b5")}`);
  check("partial: still recorded", next.covers.length === 1);
}

// 4. Refusals. Each of these would corrupt a balance, and the reducer rejects rather than
//    clamping: a clamp would record a row stating an amount that differs from what moved,
//    and that row is the only thing reconciling a funding bucket's card against its ledger.
{
  const s = underwater();
  const unchanged = (next, label) => {
    check(
      `refuses: ${label}`,
      balanceOf(next, "b5") === -250 && balanceOf(next, "b1") === 283 && next.covers.length === 0,
    );
  };

  unchanged(bucketReducer(s, cover(0)), "a zero amount");
  unchanged(bucketReducer(s, cover(-100)), "a negative amount");
  unchanged(bucketReducer(s, cover(250, "b5", "b5")), "a bucket covering itself");
  unchanged(bucketReducer(s, cover(250, "nope")), "an unknown funding bucket");
  unchanged(bucketReducer(s, cover(250, "b1", "nope")), "an unknown target");
  unchanged(bucketReducer(s, cover(400)), "more than the funding bucket holds");
  // The one that matters most: overshooting leaves Everything Else positive, which is the
  // slush fund the empty bucket exists to prevent.
  unchanged(bucketReducer(s, cover(300)), "more than the deficit");
}

// 5. A cover is never a purchase. The verdict prompt is handed the last twenty transactions
//    as spending history, so a transfer landing there would teach the model that someone
//    bought $250 of groceries they never ate.
{
  const next = bucketReducer(underwater(), cover(250));
  check("ledger: transactions are untouched", next.transactions.length === 0);
  check(
    "ledger: the cover is not disguised as a transaction",
    !next.transactions.some((t) => t.amount === 250),
  );
}

// 6. Covers accumulate rather than replacing one another, so the record stays readable.
{
  let state = underwater();
  state = bucketReducer(state, cover(100));
  state = bucketReducer(state, { ...cover(150), cover: { ...cover(150).cover, id: "c2" } });
  check("history: both moves are kept", state.covers.length === 2);
  check("history: newest first", state.covers[0].id === "c2");
  check("history: the deficit is fully cleared", balanceOf(state, "b5") === 0);
  check("history: the funding bucket paid both", balanceOf(state, "b1") === 33);
}

// 7. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
