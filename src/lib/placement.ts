import type { Bucket, BucketIconKey } from "@/lib/bucket-store";

/**
 * Guessing which bucket a purchase belongs in, from its label alone.
 *
 * No model is involved, deliberately. This runs while the purchase dialog is open and the
 * person is waiting to tap, so a round trip would put a spinner in the middle of the one
 * flow that has always been instant. It would also put a model in front of a money decision
 * before the person has made it, which is the opposite of how the rest of the app is built:
 * the verdict arrives after a purchase and argues with it, it does not steer it beforehand.
 *
 * The guess works by elimination rather than enumeration. Trying to list everything a person
 * might buy would fail on its first unanticipated noun. Instead only the three categories
 * with recognizable vocabulary are matched (food shopping, eating out, children), and
 * anything that matches none of them falls through to the generic bucket. A pair of shoes, a
 * set of headphones, a phone case and a tyre are all "not food and not kids", which is
 * exactly what the generic bucket is for, so the fallback is the accurate answer rather than
 * a shrug.
 *
 * Ambiguity produces no guess at all. A label hitting two categories at once means the list
 * stays in its natural order, because a confident wrong guess at the top of the list is
 * worse than no guess: the person taps the first row on momentum and the money comes out of
 * somewhere they did not intend.
 */

/** Why a bucket was picked, which changes what the dialog says about it. */
export type PlacementReason = "matched" | "nothing_else_fits";

export type Placement = {
  bucketId: string;
  reason: PlacementReason;
};

/**
 * Vocabulary per category, matched on whole words.
 *
 * Kept short on purpose. Every term here is one that would be surprising in another
 * category, and a term that could plausibly belong to two is left out entirely rather than
 * assigned to a winner. "Snack" sits in dining rather than groceries because a snack bought
 * deliberately with the weekly shop is usually labelled as part of it.
 */
const VOCABULARY: Partial<Record<BucketIconKey, RegExp>> = {
  groceries:
    /\b(grocer(?:y|ies)|supermarket|produce|weekly shop|food shop|milk|eggs|bread|veg|vegetables|fruit|pantry|farmers? market)\b/i,
  dining:
    /\b(restaurant|takeout|take-?away|delivery|doordash|uber eats|grubhub|coffee|latte|espresso|cafe|café|lunch|dinner|brunch|breakfast|pizza|burger|ramen|sushi|tacos?|pastry|bakery|drinks|snacks?|bar tab)\b/i,
  kids: /\b(kid|kids|child|children|school|daycare|nursery|toys?|diapers?|allowance|babysitt\w*)\b/i,
};

/**
 * The bucket a purchase is most likely to belong to, or nothing when the label is ambiguous.
 *
 * Matching is on `iconKey` rather than name or id, so a renamed bucket still works and a
 * bucket the person created themselves (which carries the default key) is a candidate for
 * the generic slot.
 *
 * Savings is never guessed. Money is not spent *into* savings, and offering it as the
 * obvious home for a purchase would invite someone to charge a want against the one bucket
 * the whole app is trying to protect.
 */
export function guessPlacement(label: string, buckets: Bucket[]): Placement | null {
  const text = label.trim();
  if (text.length === 0) return null;

  const spendable = buckets.filter((b) => b.iconKey !== "savings");
  if (spendable.length === 0) return null;

  const hits = (Object.keys(VOCABULARY) as BucketIconKey[]).filter((key) =>
    VOCABULARY[key]?.test(text),
  );

  // Two categories at once: no guess, and the list keeps its own order.
  if (hits.length > 1) return null;

  if (hits.length === 1) {
    const match = spendable.find((b) => b.iconKey === hits[0]);
    if (match) return { bucketId: match.id, reason: "matched" };
    // The category exists in the vocabulary but not in this person's buckets, so it falls
    // through to the generic slot below rather than guessing something unrelated.
  }

  const generic = spendable.find((b) => b.iconKey === "default");
  if (generic) return { bucketId: generic.id, reason: "nothing_else_fits" };

  return null;
}

/**
 * Buckets reordered so the guess is first, with the guess identified.
 *
 * Returning a single object keeps the dialog from having to re-derive which row is the
 * guessed one while it renders two differently-labelled groups.
 */
export function orderForPlacement(
  label: string,
  buckets: Bucket[],
): { guess: Bucket | null; reason: PlacementReason | null; rest: Bucket[] } {
  const placement = guessPlacement(label, buckets);
  if (!placement) return { guess: null, reason: null, rest: buckets };

  const guess = buckets.find((b) => b.id === placement.bucketId) ?? null;
  if (!guess) return { guess: null, reason: null, rest: buckets };

  return {
    guess,
    reason: placement.reason,
    rest: buckets.filter((b) => b.id !== guess.id),
  };
}
