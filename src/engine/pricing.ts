import type { Evidence, EvidenceItem } from "./evidence";

/**
 * Pulling a price out of a search result, and doing the subtraction in code.
 *
 * The model reads English. It must not be the thing that says "you could save $230", because
 * that sentence is a number about someone's money, and a model producing it is producing a
 * figure nobody checked: the price came off a snippet it skimmed and the arithmetic happened
 * in prose. If it is wrong, it is wrong confidently, in the one place this app cannot afford
 * to be.
 *
 * So the division is strict. The model interprets; this file extracts and subtracts. Nothing
 * here asks a model anything, and the prompt is told not to state a figure of its own.
 *
 * The bar for claiming a saving is deliberately high, because the failure modes are lopsided.
 * Saying nothing when a cheaper fix existed costs the person a tip they can find themselves.
 * Naming a wrong number costs them trust in everything else the app said, and it is the kind
 * of error someone notices immediately and remembers. Every rule below resolves toward
 * silence when it is unsure.
 */

/** A cheaper option the code found, priced and attributed. */
export type PriceFinding = {
  /** What the cheaper option costs, as printed in the source. */
  amount: number;
  /** The purchase it was compared against. */
  against: number;
  /** `against` minus `amount`. Always positive: a non-saving is not a finding. */
  saving: number;
  /** Where the number came from, so the claim can be followed rather than believed. */
  source: { title: string; url: string };
};

/**
 * Prices written the way a shopping page writes them, and only those.
 *
 * The currency marker is required, which throws away most of what would otherwise be
 * mistaken for a price: model numbers (Nova Pro 7P), years, capacities, percentages, review
 * counts, "top 10 under 100". An unmarked number in a snippet is not evidence of a price.
 *
 * Only USD is read. The app formats in dollars and compares against a dollar amount, so a
 * euro figure would be subtracted from a dollar one and produce a confident wrong answer.
 * Leaving other currencies unmatched means no claim, which is the correct outcome until
 * there is a conversion step worth trusting.
 */
const PRICE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;

/**
 * Words that mark the number after them as something other than what you would pay: the
 * pre-discount price, the thing being replaced, a total that includes the purchase.
 *
 * Checked against the few characters before the match rather than parsed, because this is a
 * heuristic and a wrong one should fail by skipping a candidate, not by misreading a
 * sentence.
 */
const NOT_A_CURRENT_PRICE =
  /\b(was|originally|list|msrp|retail|reg|regularly|instead of|vs\.?|save|off|worth|valued)\s*$/i;

/** How many characters before a match to inspect for the words above. */
const LOOKBEHIND = 24;

/**
 * Floors on what counts as a claim worth making.
 *
 * A cheaper option has to be cheap enough that the difference changes a decision. Without
 * this, a $280 purchase and a $270 accessory produce "you could save $10", which is noise
 * dressed as advice and makes the app look like it is reaching.
 */
const MIN_SAVING_USD = 15;
const MIN_SAVING_SHARE = 0.25;

/**
 * The lowest a candidate can be before it stops looking like a fix and starts looking like a
 * cable, a sticker, or a shipping line. Not a strong signal, but it costs nothing and removes
 * the most embarrassing class of wrong answer.
 */
const MIN_CREDIBLE_USD = 5;

/** Reads every currency-marked amount out of one string, skipping the ones marked stale. */
function pricesIn(text: string): number[] {
  const found: number[] = [];

  for (const match of text.matchAll(PRICE)) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - LOOKBEHIND), at);
    if (NOT_A_CURRENT_PRICE.test(before.trimEnd() + " ")) continue;

    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value)) found.push(value);
  }

  return found;
}

/**
 * Finds the cheapest credible option across the evidence, or nothing.
 *
 * Reads the items only, never the provider's summary. A summary is the provider's own prose
 * about several results at once, so a number in it cannot be attributed to a page the person
 * could open, and an unattributable number is exactly what this file exists to avoid.
 *
 * Takes the lowest qualifying price rather than the first. Someone who went looking would
 * find the cheapest fix, and every candidate here has already survived the currency marker,
 * the staleness words and both floors. If that still picks up something wrong, the finding
 * carries the page it came from and the person can see the mistake rather than inherit it.
 */
export function findCheaperOption(evidence: Evidence, purchaseAmount: number): PriceFinding | null {
  if (!(purchaseAmount > 0)) return null;

  let best: { amount: number; item: EvidenceItem } | null = null;

  for (const item of evidence.items) {
    for (const amount of pricesIn(`${item.title} ${item.snippet}`)) {
      if (amount < MIN_CREDIBLE_USD) continue;
      if (amount >= purchaseAmount) continue;
      if (best === null || amount < best.amount) best = { amount, item };
    }
  }

  if (best === null) return null;

  const saving = purchaseAmount - best.amount;
  if (saving < MIN_SAVING_USD) return null;
  if (saving / purchaseAmount < MIN_SAVING_SHARE) return null;

  return {
    amount: best.amount,
    against: purchaseAmount,
    saving,
    source: { title: best.item.title, url: best.item.url },
  };
}

const usd = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

/**
 * The sentence the model is handed, already finished.
 *
 * Written out here rather than left to the model to phrase, because a paraphrase is a chance
 * to restate a number, and restating is where a number changes. The model's job around this
 * is to decide whether it bears on what the person said, not to do the sum again.
 */
export function describeFinding(finding: PriceFinding): string {
  return (
    `A cheaper option was found and priced by the app, not by you: ${usd(finding.amount)} ` +
    `against ${usd(finding.against)} for the purchase, a difference of ${usd(finding.saving)}. ` +
    `Source: ${finding.source.title}.`
  );
}
