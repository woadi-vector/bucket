#!/usr/bin/env node
/**
 * Placement guess checks. Bundles src/lib/placement.ts and runs it against fixed labels.
 *
 * The guess decides which bucket sits at the top of the purchase picker, which means a wrong
 * one gets tapped on momentum and the money comes out of somewhere the person did not
 * intend. That makes the fallback and the ambiguity rule the load-bearing cases rather than
 * the vocabulary: anything that is not food and not kids must land in the generic bucket,
 * and a label that could go either way must produce no guess at all.
 *
 * The real bucket list is checked too, because the match is on `iconKey`. Renaming a bucket
 * is safe; changing "Everything Else" away from the default key would silently disable the
 * fallback and leave every unclassifiable purchase pointing at whatever came first.
 *
 *   npm run check:placement
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
  throw new Error(`check-placement: network call blocked (${String(url)})`);
};

const dir = mkdtempSync(join(tmpdir(), "bucket-placement-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `export { guessPlacement, orderForPlacement } from "@/lib/placement";
export { initialBuckets } from "@/lib/bucket-store";`,
);

const bundled = await build({
  entryPoints: [entry],
  bundle: true,
  // `node` rather than `neutral`: bucket-store.ts imports icon components for the cards.
  // Nothing here touches them, but they have to resolve for the bundle to build.
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  alias: { "@": resolve("src") },
});
const file = join(dir, "placement.mjs");
writeFileSync(file, bundled.outputFiles[0].contents);
const { guessPlacement, orderForPlacement, initialBuckets } = await import(
  pathToFileURL(file).href
);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};

/** A bucket list shaped like the app's, independent of what the app currently ships. */
const BUCKETS = [
  {
    id: "g",
    name: "Groceries",
    balance: 283,
    limit: null,
    ownerType: "self",
    iconKey: "groceries",
    accent: "",
  },
  {
    id: "d",
    name: "Dining Out",
    balance: 124,
    limit: null,
    ownerType: "self",
    iconKey: "dining",
    accent: "",
  },
  {
    id: "k",
    name: "Kids' Allowance",
    balance: 50,
    limit: null,
    ownerType: "child",
    iconKey: "kids",
    accent: "",
  },
  {
    id: "e",
    name: "Everything Else",
    balance: 0,
    limit: null,
    ownerType: "self",
    iconKey: "default",
    accent: "",
  },
  {
    id: "s",
    name: "Savings",
    balance: 1254,
    limit: null,
    ownerType: "self",
    iconKey: "savings",
    accent: "",
  },
];

const at = (label, buckets = BUCKETS) => guessPlacement(label, buckets);

// 1. The case the generic bucket exists for. None of these are food or kids, so the right
//    answer is reached by elimination rather than by anticipating the noun.
{
  for (const label of [
    "Shoes",
    "New headphones",
    "Arctis Nova Pro earpads",
    "Phone case, cracked the old one",
    "Oil change",
    "Birthday present for Dana",
    "Replacement charger",
  ]) {
    const p = at(label);
    check(`fallback: "${label}" lands in the generic bucket`, p?.bucketId === "e", p?.bucketId);
  }
  check("fallback: and says why", at("Shoes")?.reason === "nothing_else_fits");
}

// 2. The three categories with vocabulary worth matching.
{
  check("matched: weekly shop is groceries", at("Weekly shop")?.bucketId === "g");
  check("matched: farmers market is groceries", at("Farmers market")?.bucketId === "g");
  check("matched: oat latte is dining", at("Oat latte")?.bucketId === "d");
  check("matched: takeout is dining", at("Takeout, too tired to cook")?.bucketId === "d");
  check("matched: ramen is dining", at("Ramen with friends")?.bucketId === "d");
  check("matched: school supplies is kids", at("School supplies")?.bucketId === "k");
  check("matched: daycare is kids", at("Daycare for the week")?.bucketId === "k");
  check("matched: reports itself as a match", at("Weekly shop")?.reason === "matched");
  check("matched: case does not matter", at("WEEKLY SHOP")?.bucketId === "g");
}

// 3. Ambiguity produces nothing. A confident wrong guess at the top of the list is worse
//    than no guess, because the first row is what gets tapped.
{
  check("ambiguous: coffee and milk hits two categories", at("Coffee and milk") === null);
  check("ambiguous: kids lunch hits two categories", at("Kids lunch money") === null);
  check(
    "ambiguous: the list keeps its own order",
    orderForPlacement("Coffee and milk", BUCKETS).guess === null,
  );
}

// 4. Whole words only. Substring matching turned "kidney" into a children's expense and
//    "producer" into groceries in an earlier draft.
{
  check("words: kidney is not kids", at("Kidney beans and rice")?.bucketId !== "k");
  check("words: producer is not produce", at("Producer fee for the short")?.bucketId === "e");
  check("words: barstool is not a bar tab", at("Barstool for the kitchen")?.bucketId === "e");
}

// 5. Savings is never the guess. Money is not spent into savings, and offering it as the
//    obvious home would invite charging a want against the one bucket being protected.
{
  const labels = ["Savings", "Deposit into savings", "Shoes", "Weekly shop", "Emergency fund"];
  check(
    "savings: never guessed, whatever the label",
    labels.every((l) => at(l)?.bucketId !== "s"),
  );
  check(
    "savings: a savings-sounding label still falls to generic",
    at("Savings")?.bucketId === "e",
  );
}

// 6. Nothing to guess from.
{
  check("empty: an empty label", at("") === null);
  check("empty: whitespace only", at("   ") === null);
  check("empty: no buckets at all", at("Shoes", []) === null);
  check(
    "empty: only savings exists",
    at(
      "Shoes",
      BUCKETS.filter((b) => b.iconKey === "savings"),
    ) === null,
  );
}

// 7. A matched category whose bucket the person does not have falls through to generic rather
//    than guessing something unrelated.
{
  const noDining = BUCKETS.filter((b) => b.iconKey !== "dining");
  const p = guessPlacement("Oat latte", noDining);
  check(
    "missing: a dining label with no dining bucket goes generic",
    p?.bucketId === "e",
    p?.bucketId,
  );

  const noGeneric = BUCKETS.filter((b) => b.iconKey !== "default");
  check("missing: no generic bucket means no guess", guessPlacement("Shoes", noGeneric) === null);
  check(
    "missing: but a match still works without a generic bucket",
    guessPlacement("Weekly shop", noGeneric)?.bucketId === "g",
  );
}

// 8. The ordering handed to the dialog.
{
  const { guess, rest } = orderForPlacement("Shoes", BUCKETS);
  check("order: the guess is separated out", guess?.id === "e");
  check("order: it is not also in the rest", !rest.some((b) => b.id === "e"));
  check("order: nothing else is dropped", rest.length === BUCKETS.length - 1);
  check(
    "order: the rest keep their original order",
    rest.map((b) => b.id).join(",") === "g,d,k,s",
    rest.map((b) => b.id).join(","),
  );

  const none = orderForPlacement("Coffee and milk", BUCKETS);
  check("order: no guess means the full list, untouched", none.rest.length === BUCKETS.length);
}

// 9. Against the buckets the app actually ships. This is what catches an edit that renames or
//    re-keys the generic bucket and silently disables the fallback.
{
  const generic = initialBuckets.filter((b) => b.iconKey === "default");
  check("shipped: exactly one generic bucket exists", generic.length === 1, `${generic.length}`);
  check(
    "shipped: shoes land in it",
    guessPlacement("Shoes", initialBuckets)?.bucketId === generic[0]?.id,
  );
  check(
    "shipped: and it is the empty one",
    generic[0]?.balance === 0,
    `${generic[0]?.name} at ${generic[0]?.balance}`,
  );
  check(
    "shipped: the seeded labels still route as expected",
    guessPlacement("Weekly shop", initialBuckets)?.bucketId ===
      initialBuckets.find((b) => b.iconKey === "groceries")?.id &&
      guessPlacement("Oat latte", initialBuckets)?.bucketId ===
        initialBuckets.find((b) => b.iconKey === "dining")?.id,
  );
}

// 10. The guard itself.
check("no network calls attempted", fetchAttempts === 0, `fetch=${fetchAttempts}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
