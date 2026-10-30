/**
 * The checkout policy: given a purchase and the bucket it was filed into, capture now or hold.
 *
 * This is the rule any agent can ask before it pays, and the same rule Bucket's own shopping
 * agent obeys. It is deterministic on purpose. The bucket's tag is the person's own decision,
 * made calmly when they created the bucket, and the threshold is a number they set. A model can
 * raise a doubt about a purchase (the screen's `mismatch`), which can only ever move a purchase
 * from capture to hold. Nothing a model says can move a purchase from hold to capture.
 *
 * No PayPal calls and no model calls happen here.
 */

export type PolicyInput = {
  bucketTag: "need" | "want";
  amountCents: number;
  /** Wants at or above this are held. Defaults to the app's Sleep On It threshold. */
  holdThresholdCents?: number;
  /**
   * The screen's view, when it has run. `mismatch` means the purchase does not look like it
   * belongs to its bucket's tag (a need bucket holding what reads as a want). Absent means the
   * screen did not run, and the rule decides on the bucket alone.
   */
  screen?: "agree" | "mismatch";
  /**
   * Concrete reasons to wait on a want, from the person's own records (see pushback.ts): it
   * would overdraw the bucket, or something like it was bought, let go or is already on hold.
   * Any reason holds the want, whatever its price.
   */
  pushback?: string[];
};

export type PolicyDecision = {
  decision: "capture" | "hold";
  /** A short, plain reason, safe to show the person and to return to an outside agent. */
  reason: string;
};

/** Matches DEFAULT_SLEEP_THRESHOLD in src/lib/bucket-store.ts, in cents. */
export const DEFAULT_HOLD_THRESHOLD_CENTS = 4000;

export function decidePolicy(input: PolicyInput): PolicyDecision {
  const threshold = input.holdThresholdCents ?? DEFAULT_HOLD_THRESHOLD_CENTS;

  if (input.bucketTag === "need") {
    if (input.screen === "mismatch") {
      return {
        decision: "hold",
        reason: "Filed under a need, but it reads like a want. Holding it to ask first.",
      };
    }
    return { decision: "capture", reason: "Filed under a need. Captured with no pause." };
  }

  const pushback = (input.pushback ?? []).filter((r) => r.trim().length > 0);
  if (pushback.length > 0) {
    return { decision: "hold", reason: `${pushback[0]} Holding it so you can decide.` };
  }

  if (input.amountCents >= threshold) {
    return {
      decision: "hold",
      reason: `A want over $${(threshold / 100).toFixed(2)}. Holding it to sleep on.`,
    };
  }
  return {
    decision: "capture",
    reason: `A want under $${(threshold / 100).toFixed(2)}. Small enough to let through.`,
  };
}

/** Validates an untrusted policy request. Returns null when it cannot be used. */
export function parsePolicyInput(data: unknown): PolicyInput | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const tag = d.bucketTag;
  const amount = d.amountCents;
  const threshold = d.holdThresholdCents;
  const screen = d.screen;
  const pushback = d.pushback;
  if (tag !== "need" && tag !== "want") return null;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return null;
  if (amount > 100_000_00) return null;
  if (
    threshold !== undefined &&
    (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0)
  ) {
    return null;
  }
  if (screen !== undefined && screen !== "agree" && screen !== "mismatch") return null;
  if (
    pushback !== undefined &&
    !(
      Array.isArray(pushback) &&
      pushback.length <= 5 &&
      pushback.every((r) => typeof r === "string" && r.length <= 300)
    )
  ) {
    return null;
  }
  return {
    bucketTag: tag,
    amountCents: amount,
    holdThresholdCents: threshold as number | undefined,
    screen: screen as PolicyInput["screen"],
    pushback: pushback as string[] | undefined,
  };
}
