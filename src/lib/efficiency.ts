/**
 * What the tiering actually bought, derived from the ledger rather than asserted.
 *
 * Bucket runs a small model on every purchase and a large one only when the small model
 * contests a person's own word. That is the whole efficiency claim, and until now it existed
 * only in prose. This module turns `model_usage` into the numbers behind it.
 *
 * Pure on purpose: no storage, no network, no React. It takes rows and returns arithmetic, so
 * the sums can be checked without a database and the page cannot quietly compute something
 * different from what the checks verify.
 */

/** One row of `model_usage`, grouped by tier. */
export type TierUsage = {
  tier: string;
  calls: number;
  totalTokens: number;
  costMicros: number;
  /** Mean round trip for this tier, or null when none was recorded. */
  avgLatencyMs: number | null;
};

export type Efficiency = {
  tiers: TierUsage[];
  /** Screening calls: one per purchase judged, whether or not it escalated. */
  verdicts: number;
  /** Calls that reached the expensive tier. */
  escalations: number;
  /** Escalations as a share of verdicts, 0..1, or null with nothing to divide. */
  escalationRate: number | null;
  /** What was actually spent, across every tier. */
  spentMicros: number;
  /**
   * What the screening pass alone would have cost at the expensive tier's observed rate,
   * or null when no expensive call has happened yet and there is no rate to observe.
   */
  counterfactualMicros: number | null;
  /** Counterfactual minus actual, floored at zero, or null when there is no counterfactual. */
  savedMicros: number | null;
  /** How many times more the counterfactual costs, or null. */
  savedMultiple: number | null;
};

const SCREENING_TIER = "nano";
const ADJUDICATION_TIER = "ultra";

function tier(tiers: TierUsage[], name: string): TierUsage | undefined {
  return tiers.find((t) => t.tier === name);
}

/**
 * Builds the comparison.
 *
 * The counterfactual is the only figure here that is not a straight sum, so it is worth
 * being exact about what it claims. It takes the tokens the screening pass actually spent
 * and reprices them at the cost-per-token the expensive tier actually charged. It does not
 * use the published price table, because there isn't one: Token Factory does not expose
 * pricing through the API, so every rate in this app is an observation.
 *
 * Repricing tokens rather than multiplying by an average call cost matters. The expensive
 * tier's calls are a mix of adjudications and reconsiderations, and a reconsideration carries
 * the person's explanation and is therefore a longer prompt. An average of call costs would
 * inherit that length and overstate the saving. A rate per token does not.
 *
 * What it still assumes is that the expensive tier would have produced a similar number of
 * completion tokens on the same prompt. That is an assumption, not a measurement, and the
 * page says so rather than presenting this as a receipt.
 */
export function summarize(tiers: TierUsage[]): Efficiency {
  const screening = tier(tiers, SCREENING_TIER);
  const adjudication = tier(tiers, ADJUDICATION_TIER);

  const verdicts = screening?.calls ?? 0;
  const escalations = adjudication?.calls ?? 0;
  const spentMicros = tiers.reduce((sum, t) => sum + t.costMicros, 0);

  // Every tier, including the stub, so the arithmetic on the page adds up to what was spent.
  const counterfactualMicros =
    adjudication && adjudication.totalTokens > 0 && screening && screening.totalTokens > 0
      ? Math.ceil(screening.totalTokens * (adjudication.costMicros / adjudication.totalTokens))
      : null;

  // The comparison is screening-versus-screening: what the cheap pass cost against what the
  // same pass would have cost upstairs. Escalation spending sits outside it, because those
  // calls would have happened either way.
  const savedMicros =
    counterfactualMicros === null
      ? null
      : Math.max(0, counterfactualMicros - (screening?.costMicros ?? 0));

  const savedMultiple =
    counterfactualMicros === null || !screening || screening.costMicros <= 0
      ? null
      : counterfactualMicros / screening.costMicros;

  return {
    tiers,
    verdicts,
    escalations,
    escalationRate: verdicts > 0 ? escalations / verdicts : null,
    spentMicros,
    counterfactualMicros,
    savedMicros,
    savedMultiple,
  };
}

/** Micro-dollars as money. Four places, because the whole point is that these are small. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/** A 0..1 share as a percentage, with no false precision. */
export function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`;
}
