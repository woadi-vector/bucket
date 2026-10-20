/**
 * Pushback: the concrete reasons to wait before a want goes through.
 *
 * A want bucket's threshold catches big purchases, but a $25 want can still overdraw the bucket
 * or repeat something bought last month. Melissa's rule for Bucket is that every want gets
 * pushback with a legitimate reason, so this looks for the reasons a friend would name:
 *
 *   - It would take the bucket below zero, counting money already held for other purchases.
 *   - Something like it was bought recently.
 *   - Something like it was let go recently.
 *   - Something like it is already waiting as a hold.
 *   - The same search found something like it for meaningfully less.
 *
 * Every reason is a fact from the person's own records, worded so they can check it. No model
 * is involved: a reason that cannot be checked is not a legitimate reason to stop a purchase.
 * The policy holds any want that has at least one.
 */

export type PastPurchase = {
  label: string;
  /** Epoch ms. */
  at: number;
  /** bought: money left; let-go: the person released it; waiting: an open hold right now. */
  kind: "bought" | "let-go" | "waiting";
};

/** Another listing from the same search, for the cheaper-option check. */
export type Alternative = { title: string; priceCents: number; merchant: string };

export type PushbackInput = {
  title: string;
  amountCents: number;
  bucketName: string;
  /** What the bucket has left, in cents, before this purchase. */
  bucketBalanceCents: number;
  /** Money already held for other open purchases from this bucket, in cents. */
  heldInBucketCents: number;
  history: PastPurchase[];
  now: number;
  /** The other listings the same search returned. */
  alternatives?: Alternative[];
};

/**
 * The bar for naming a cheaper option, the same as the pricing rules on `main`
 * (src/engine/pricing.ts): the difference has to be big enough to change a decision, or saying
 * it is noise dressed as advice.
 */
export const MIN_SAVING_CENTS = 1500;
export const MIN_SAVING_SHARE = 0.25;

/** How far back a similar purchase still counts. */
export const LOOKBACK_DAYS = 45;
/** Reasons shown at most, so the card stays readable. */
const MAX_REASONS = 3;

const DAY = 24 * 60 * 60 * 1000;

const STOP = new Set([
  "with",
  "from",
  "pack",
  "size",
  "new",
  "the",
  "and",
  "for",
  "set",
  "kit",
  "pro",
  "plus",
  "mens",
  "womens",
  "unisex",
  "black",
  "white",
  "blue",
  "red",
  "green",
  "grey",
  "gray",
]);

/** Words that carry meaning in a product title: lowercase, 4+ letters, plural folded. */
export function keywords(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * Two titles describe the same kind of thing when they share two meaningful words ("trail
 * running shoes" and "Scend Pro Running Shoes"), or when either title is a single meaningful
 * word that the other contains ("Headphones" and "Sony WH-1000XM5 Headphones").
 */
export function similar(a: string, b: string): boolean {
  const ka = keywords(a);
  const kb = keywords(b);
  if (ka.size === 0 || kb.size === 0) return false;
  let shared = 0;
  for (const w of ka) if (kb.has(w)) shared++;
  if (shared >= 2) return true;
  return shared === 1 && (ka.size === 1 || kb.size === 1);
}

const name = (label: string) => (label.length > 60 ? `${label.slice(0, 57).trimEnd()}...` : label);

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function ago(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks < 5 ? `${weeks} weeks ago` : "about a month ago";
}

export function findPushback(input: PushbackInput): string[] {
  const reasons: string[] = [];

  const available = input.bucketBalanceCents - input.heldInBucketCents;
  if (input.amountCents > available) {
    const short = input.amountCents - Math.max(available, 0);
    reasons.push(
      input.heldInBucketCents > 0
        ? `This would overdraw ${input.bucketName} by ${dollars(short)}: it has ${dollars(
            Math.max(available, 0),
          )} left once the purchases already on hold go through.`
        : `This would overdraw ${input.bucketName} by ${dollars(short)}: it has ${dollars(
            Math.max(available, 0),
          )} left.`,
    );
  }

  // A cheaper listing of the same kind of thing, from the search the agent just ran. The price
  // is the catalog's and the subtraction happens here; no model states the number.
  const cheaper = (input.alternatives ?? [])
    .filter((a) => a.priceCents > 0 && a.priceCents < input.amountCents)
    .filter((a) => a.title !== input.title && similar(a.title, input.title))
    .filter((a) => {
      const saving = input.amountCents - a.priceCents;
      return saving >= MIN_SAVING_CENTS && saving / input.amountCents >= MIN_SAVING_SHARE;
    })
    .sort((a, b) => a.priceCents - b.priceCents)[0];
  if (cheaper) {
    reasons.push(
      `The same search found ${name(cheaper.title)} at ${cheaper.merchant} for ${dollars(
        cheaper.priceCents,
      )}, ${dollars(input.amountCents - cheaper.priceCents)} less.`,
    );
  }

  const cutoff = input.now - LOOKBACK_DAYS * DAY;
  const matches = input.history
    .filter((p) => p.at >= cutoff && p.at <= input.now && similar(p.label, input.title))
    .sort((a, b) => b.at - a.at);

  const waiting = matches.find((p) => p.kind === "waiting");
  if (waiting) reasons.push(`${name(waiting.label)} is already on hold, waiting for your answer.`);

  const bought = matches.find((p) => p.kind === "bought");
  if (bought) reasons.push(`You bought ${name(bought.label)} ${ago(input.now - bought.at)}.`);

  const letGo = matches.find((p) => p.kind === "let-go");
  if (letGo) reasons.push(`You let ${name(letGo.label)} go ${ago(input.now - letGo.at)}.`);

  return reasons.slice(0, MAX_REASONS);
}
