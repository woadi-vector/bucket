import { SLEEP_THRESHOLD, type Bucket, type PurchaseVerdict } from "@/lib/bucket-store";
import { isLiveContest } from "@/lib/reconsideration";

/**
 * What happens when a bucket is chosen.
 *
 * Four things can interrupt a purchase at this point and they are not interchangeable, so
 * the order is the whole content of this file. Extracted from the component because an
 * ordering is exactly the kind of rule that breaks without anything looking wrong: every
 * branch produces a plausible screen, so a swapped pair shows the person the wrong one and
 * nothing reports a fault.
 */

export type NextStep = "askParent" | "intercept" | "secondThought" | "commit";

export type RoutingInput = {
  bucket: Bucket;
  amount: number;
  intent: "want" | "need";
  /** What the bucket has already spent, for the child limit. */
  spent: number;
  /** The engine's answer, when it arrived before the bucket was chosen. */
  preview?: PurchaseVerdict | null;
};

/**
 * The ordering, from the most binding to the least:
 *
 * A child's limit comes first because it is the only one that is not Bucket's own opinion.
 * Someone else set it, and an agent is not entitled to talk its way past a rule a parent
 * made.
 *
 * The sleep threshold comes next, and specifically before the disagreement. A want over the
 * threshold is already being paused for a day, which is a stronger intervention than an
 * argument; raising the argument first would mean two interruptions for one purchase, and
 * the tray is where the engine's objection will be waiting anyway.
 *
 * The disagreement comes third, and only when the answer is already in hand. Waiting for it
 * would put a model call inside a screen built as a half-second pause, which is the thing
 * this whole path exists to avoid.
 *
 * Everything else commits.
 */
export function nextStepAfterBucket(input: RoutingInput): NextStep {
  const { bucket, amount, intent, spent, preview } = input;

  if (bucket.ownerType === "child" && bucket.limit != null && spent + amount > bucket.limit) {
    return "askParent";
  }

  if (intent === "want" && amount > SLEEP_THRESHOLD) {
    return "intercept";
  }

  if (isLiveContest(preview)) {
    return "secondThought";
  }

  return "commit";
}
